const axios = require('axios');
const fs = require('fs');
const { createObjectCsvWriter } = require('csv-writer');

/**
 * Main scraping function that routes to different platform handlers
 *
 * @param {string} baseUrl   Store URL (or category URL for customwheeloffset)
 * @param {Function} logger  Log sink
 * @param {string} mode      'shopify' | 'shopify_collection' | 'woocommerce' | 'customwheeloffset' | 'forgiato'
 * @param {object} options   { maxPages: number|'auto' }
 */
async function scrapeShopifyStore(baseUrl, logger = console.log, mode = 'shopify', options = {}) {
    if (!baseUrl) {
        logger("Error: No store URL provided.");
        return { success: false, error: "No URL provided" };
    }

    baseUrl = baseUrl.replace(/\/$/, "");
    const filePrefix = generateFilePrefix(baseUrl);
    logger(`Starting [${mode.toUpperCase()}] scraper for: ${baseUrl}`);
    if (options.maxPages) logger(`  (Page limit: ${options.maxPages})`);

    try {
        let products = [];
        let collections = [];

        if (mode === 'shopify' || mode === 'shopify_collection') {
            const result = await handleShopifyScrape(baseUrl, mode, logger);
            products = result.products;
            collections = result.collections;
        } else if (mode === 'woocommerce') {
            products = await handleWooCommerceScrape(baseUrl, logger);
        } else if (mode === 'customwheeloffset') {
            products = await handleCustomWheelOffsetScrape(baseUrl, logger, options);
        } else if (mode === 'forgiato') {
            products = await handleForgiatoScrape(baseUrl, logger, options);
        } else {
            logger(`Mode [${mode}] is not fully implemented yet. Falling back to basic Shopify logic.`);
            const result = await handleShopifyScrape(baseUrl, 'shopify', logger);
            products = result.products;
        }

        if (products && products.length > 0) {
            return await saveResults(products, collections, filePrefix, logger, mode);
        } else {
            logger("No products found to save.");
            return { success: false, error: "No products found" };
        }
    } catch (error) {
        logger(`Critical error: ${error.message}`);
        return { success: false, error: error.message };
    }
}

/**
 * Handles Shopify Product/Collection JSON scraping
 */
async function handleShopifyScrape(baseUrl, mode, logger) {
    let collections = [];
    let products = [];
    const userAgent = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36';

    if (mode === 'shopify') {
        logger("\n[1/2] Fetching Shopify collections...");
        let page = 1;
        let hasMore = true;
        while (hasMore) {
            try {
                const res = await axios.get(`${baseUrl}/collections.json?limit=250&page=${page}`, { headers: { 'User-Agent': userAgent } });
                if (res.data?.collections?.length > 0) {
                    collections.push(...res.data.collections);
                    logger(`  -> Fetched ${res.data.collections.length} collections (page ${page})`);
                    page++;
                } else { hasMore = false; }
            } catch (err) { hasMore = false; }
        }
    }

    logger(`\n[2/2] Fetching products from ${mode === 'shopify' ? 'main store' : 'collection'}...`);

    let totalExpected = 0;
    try {
        const countRes = await axios.get(`${baseUrl}/products/count.json`, { headers: { 'User-Agent': userAgent } });
        totalExpected = countRes.data.count || 0;
        if (totalExpected) logger(`  (Total products found in store: ${totalExpected})`);
    } catch (e) { /* ignore */ }

    let page = 1;
    let hasMore = true;
    while (hasMore) {
        try {
            const url = `${baseUrl}/products.json?limit=250&page=${page}`;
            const res = await axios.get(url, { headers: { 'User-Agent': userAgent } });
            if (res.data?.products?.length > 0) {
                products.push(...res.data.products);
                const progressMsg = totalExpected
                    ? `Fetched ${products.length}/${totalExpected} products...`
                    : `Fetched ${products.length} products (page ${page})...`;
                logger(`  -> ${progressMsg}`);
                page++;
            } else { hasMore = false; }
        } catch (err) {
            logger(`  -> Finished fetching (End of data or ${err.response?.status || 'error'})`);
            hasMore = false;
        }
    }

    return { products, collections };
}

/**
 * Handles Custom Wheel Offset SCRAPER
 * Parses the embedded JSON-LD ItemList payload (the page is client-rendered,
 * so cheerio selectors against the visible DOM return nothing).
 *
 * The full catalog is ~5,476 pages (~164k SKUs). Filtered URLs (by brand, size,
 * etc.) are much smaller. Pass options.maxPages for a hard cap, or set it to
 * 'auto' / 0 / null to scrape until the site returns an empty page.
 */
async function handleCustomWheelOffsetScrape(baseUrl, logger, options = {}) {
    const rawLimit = options.maxPages;
    const autoDetect = rawLimit === 'auto' || rawLimit === 0 || rawLimit === null;
    const hardCeiling = 6000;
    const maxPages = autoDetect ? hardCeiling : (rawLimit || 50);

    const modeLabel = autoDetect ? 'auto-detect (stops on empty page)' : `up to ${maxPages} pages`;
    logger(`\n[1/1] Fetching Custom Wheel Offset products (JSON-LD extraction, ${modeLabel})...`);
    const products = [];
    const seenSkus = new Set();
    const userAgent = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36';

    for (let page = 1; page <= maxPages; page++) {
        const pageUrl = baseUrl.includes('?') ? `${baseUrl}&page=${page}` : `${baseUrl}?page=${page}`;
        logger(`  -> Fetching page ${page}: ${pageUrl}`);

        let html;
        try {
            const res = await axios.get(pageUrl, {
                headers: {
                    'User-Agent': userAgent,
                    'Accept': 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8',
                    'Accept-Language': 'en-US,en;q=0.9',
                    'Referer': 'https://www.google.com/'
                },
                timeout: 20000
            });
            html = res.data;
        } catch (err) {
            logger(`  -> Error on page ${page}: ${err.message}`);
            break;
        }

        const items = extractItemListProducts(html);
        if (items.length === 0) {
            logger(`  -> No products found on page ${page}. Stopping.`);
            break;
        }

        let newCount = 0;
        for (const item of items) {
            const sku = item.sku || item.mpn || '';
            if (sku && seenSkus.has(sku)) continue;
            if (sku) seenSkus.add(sku);
            newCount++;

            const url = item.url || '';
            const handle = url.split('/').filter(Boolean).pop()?.split('?')[0] || sku;
            const offer = item.offers || {};
            const priceRaw = offer.price ?? '';
            const price = priceRaw === '' ? '' : Number(priceRaw).toFixed(2);
            const available = typeof offer.availability === 'string'
                ? /InStock/i.test(offer.availability)
                : true;

            const specTags = [
                item.height && item.width ? `${item.width}x${item.height}`.replace(/in/gi, '') : '',
                item.depth ? `offset ${item.depth}` : '',
                item.color,
                item.material,
                item.weight
            ].filter(Boolean).join(' | ');

            products.push({
                id: sku || handle,
                title: [item.name, item.color].filter(Boolean).join(' ').trim(),
                handle,
                vendor: item.manufacturer || item.name?.split(' ')[0] || '',
                product_type: 'Wheels',
                tags: specTags,
                images: item.image ? [{ src: item.image }] : [],
                variants: [{
                    sku,
                    price,
                    compare_at_price: null,
                    available
                }]
            });
        }

        logger(`  -> Extracted ${items.length} items (${newCount} new) from page ${page}. Total: ${products.length}`);

        if (newCount === 0) {
            logger(`  -> No new SKUs on page ${page}. Stopping.`);
            break;
        }

        await new Promise(r => setTimeout(r, 1200));
    }

    return products;
}

/**
 * Extracts products from JSON-LD ItemList payloads embedded in a page's <script> tags.
 */
function extractItemListProducts(html) {
    const products = [];
    const scriptRegex = /<script[^>]*>([\s\S]*?)<\/script>/g;
    let m;
    while ((m = scriptRegex.exec(html))) {
        const body = m[1].trim();
        if (!body.includes('ItemList') || !body.includes('itemListElement')) continue;

        const normalized = body.replace(/"itemListElement"\s*:\s*\[\s*\[/, '"itemListElement":[')
                               .replace(/\]\s*\]\s*\}\s*$/, ']}');
        try {
            const parsed = JSON.parse(normalized);
            const list = parsed.itemListElement || [];
            for (const entry of list) {
                if (entry?.item) products.push(entry.item);
            }
        } catch {
            const productRegex = /\{"@type":"Product"[\s\S]*?\}\}\}/g;
            let pm;
            while ((pm = productRegex.exec(body))) {
                try { products.push(JSON.parse(pm[0])); } catch { /* skip */ }
            }
        }
    }
    return products;
}

/**
 * Handles Forgiato (forgiato.com) SCRAPER
 * Forgiato sits behind a Cloudflare JS challenge, so we use Playwright to render
 * the page and pull the JSON-LD Product block from each wheel page.
 */
async function handleForgiatoScrape(baseUrl, logger, options = {}) {
    let chromium;
    try {
        ({ chromium } = require('playwright'));
    } catch {
        logger('  -> playwright is not installed. Run: npm install playwright && npx playwright install chromium');
        return [];
    }

    const indexUrl = baseUrl.endsWith('/wheels') || baseUrl.includes('/wheels/') ? baseUrl : `${baseUrl.replace(/\/$/, '')}/wheels`;
    logger(`\n[1/2] Launching browser to defeat Cloudflare challenge...`);

    // Cloudflare blocks headless Chromium aggressively; default to headful.
    const headless = options.headless === true;
    const browser = await chromium.launch({ headless });
    const ctx = await browser.newContext({
        userAgent: 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/130.0.0.0 Safari/537.36',
        viewport: { width: 1366, height: 768 },
        locale: 'en-US'
    });

    const products = [];
    try {
        const page = await ctx.newPage();
        logger(`  -> Navigating to ${indexUrl}`);
        await page.goto(indexUrl, { waitUntil: 'domcontentloaded', timeout: 60000 });
        await page.waitForSelector('a[href*="/wheels/"]', { state: 'attached', timeout: 45000 });
        await page.waitForTimeout(2000);

        const wheelLinks = await page.evaluate(() => {
            const urls = new Set();
            for (const a of document.querySelectorAll('a[href]')) {
                const href = a.href;
                if (/\/wheels\/[^\/]+\/[^\/]+\/?$/.test(href) && !/\/wheels\/$/.test(href)) {
                    urls.add(href.replace(/\?.*$/, ''));
                }
            }
            return [...urls];
        });

        logger(`  -> Found ${wheelLinks.length} unique wheel pages.`);
        if (wheelLinks.length === 0) {
            logger('  -> No wheels found on the index page. Aborting.');
            return [];
        }

        const limit = options.limit || parseInt(process.env.FORGIATO_LIMIT || '0', 10);
        const targets = limit > 0 ? wheelLinks.slice(0, limit) : wheelLinks;
        if (limit > 0) logger(`  -> Limiting to first ${targets.length} wheel(s) per options.limit.`);

        logger(`\n[2/2] Scraping each product page...`);
        for (let i = 0; i < targets.length; i++) {
            const url = targets[i];
            try {
                await page.goto(url, { waitUntil: 'domcontentloaded', timeout: 45000 });

                // Cloudflare re-challenges on navigation. Wait for the challenge to clear.
                await page.waitForFunction(() => {
                    if (/just a moment/i.test(document.title)) return false;
                    if (document.querySelector('h1.wd-header__name')) return true;
                    for (const s of document.querySelectorAll('script[type="application/ld+json"]')) {
                        try {
                            const p = JSON.parse(s.textContent);
                            const candidates = p['@graph'] || [p];
                            if (candidates.some(c => c?.['@type'] === 'Product')) return true;
                        } catch {}
                    }
                    return false;
                }, { timeout: 45000 });

                const data = await page.evaluate(() => {
                    const decode = s => {
                        if (!s || typeof s !== 'string') return s;
                        return s.replace(/&#34;/g, '"').replace(/&#39;/g, "'")
                                .replace(/&amp;/g, '&').replace(/&quot;/g, '"')
                                .replace(/&lt;/g, '<').replace(/&gt;/g, '>');
                    };

                    let productLd = null;
                    for (const script of document.querySelectorAll('script[type="application/ld+json"]')) {
                        try {
                            const parsed = JSON.parse(script.textContent);
                            const candidates = parsed['@graph'] || [parsed];
                            for (const c of candidates) {
                                if (c?.['@type'] === 'Product') { productLd = c; break; }
                            }
                            if (productLd) break;
                        } catch {}
                    }

                    const h1 = (document.querySelector('h1.wd-header__name')
                        || document.querySelector('main h1')
                        || document.querySelector('h1'))?.textContent?.trim();

                    const series = [...document.querySelectorAll('.wheel-series, [class*="series"], h2, .tag')]
                        .map(e => e.textContent.trim())
                        .find(t => /ECL|3 PIECE|Monoleggera|Flat Forging|Floater|Tecnica/i.test(t)) || '';

                    const allImages = [...document.querySelectorAll('img')]
                        .map(i => ({ src: i.currentSrc || i.src, alt: i.alt || '' }))
                        .filter(i => i.src && !/logo|icon|og-image|forging-sketch/i.test(i.src));

                    return {
                        h1,
                        series,
                        productLd: productLd ? JSON.parse(JSON.stringify(productLd, (_k, v) => typeof v === 'string' ? decode(v) : v)) : null,
                        images: allImages
                    };
                });

                const ld = data.productLd || {};
                const additional = Object.fromEntries(
                    (ld.additionalProperty || []).map(p => [p.name, p.value])
                );

                const primaryImage = ld.image || data.images[0]?.src || '';
                const galleryImages = [...new Set(data.images.map(i => i.src))];

                const priceRaw = ld.offers?.price ?? '';
                const price = priceRaw === '' ? '' : Number(priceRaw).toFixed(2);

                const tagParts = [
                    additional['Construction'],
                    additional['Series'] || data.series,
                    additional['Available Sizes'] ? `Sizes: ${additional['Available Sizes']}` : '',
                    additional['Bolt Pattern'] ? `Bolt: ${additional['Bolt Pattern']}` : '',
                    ld.material
                ].filter(Boolean);

                const slug = url.replace(/\/$/, '').split('/').pop();

                products.push({
                    id: slug,
                    title: ld.name || data.h1 || slug,
                    handle: slug,
                    vendor: 'Forgiato',
                    product_type: additional['Construction'] || 'Wheels',
                    tags: tagParts.join(' | '),
                    body_html: ld.description || '',
                    images: galleryImages.map(src => ({ src })),
                    variants: [{
                        sku: slug,
                        price,
                        compare_at_price: null,
                        available: /InStock/i.test(ld.offers?.availability || ''),
                        featured_image: primaryImage ? { src: primaryImage } : null
                    }],
                    url,
                    series: additional['Series'] || data.series || '',
                    sizes: additional['Available Sizes'] || '',
                    bolt_pattern: additional['Bolt Pattern'] || '',
                    material: ld.material || '',
                    construction: additional['Construction'] || '',
                    gallery: galleryImages
                });

                logger(`  -> [${i + 1}/${targets.length}] ${ld.name || data.h1 || slug} (${galleryImages.length} images)`);
            } catch (err) {
                logger(`  -> [${i + 1}/${targets.length}] Failed: ${url} — ${err.message}`);
            }

            await page.waitForTimeout(400);
        }
    } finally {
        await browser.close();
    }

    return products;
}

/**
 * Handles WooCommerce Public JSON API scraping (Store API — no auth required)
 */
async function handleWooCommerceScrape(baseUrl, logger) {
    logger("\n[1/1] Fetching WooCommerce products...");
    let products = [];
    let page = 1;
    let hasMore = true;
    const userAgent = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36';

    while (hasMore && page <= 20) {
        try {
            const res = await axios.get(`${baseUrl}/wp-json/wc/store/v1/products?page=${page}&per_page=100`, {
                headers: { 'User-Agent': userAgent }
            });
            if (res.data?.length > 0) {
                const mapped = res.data.map(p => ({
                    id: p.id,
                    title: p.name,
                    handle: p.slug,
                    vendor: baseUrl,
                    product_type: p.categories?.[0]?.name || 'General',
                    tags: (p.tags || []).map(t => t.name).join(', '),
                    images: p.images,
                    variants: [{
                        sku: p.sku,
                        price: p.prices?.price ? (Number(p.prices.price) / Math.pow(10, p.prices.currency_minor_unit || 2)).toFixed(2) : '',
                        compare_at_price: p.prices?.regular_price ? (Number(p.prices.regular_price) / Math.pow(10, p.prices.currency_minor_unit || 2)).toFixed(2) : '',
                        available: p.is_in_stock !== false
                    }]
                }));
                products.push(...mapped);
                logger(`  -> Fetched ${res.data.length} products (page ${page})`);
                page++;
            } else { hasMore = false; }
        } catch (err) {
            logger(`  -> WC Store API unavailable (${err.response?.status || err.message}).`);
            hasMore = false;
        }
    }
    return products;
}

/**
 * Formats and saves results to JSON and CSV
 */
async function saveResults(products, collections, filePrefix, logger, mode) {
    const prodJson = `${filePrefix}_products.json`;
    const prodCsv = `${filePrefix}_products.csv`;

    fs.writeFileSync(prodJson, JSON.stringify(products, null, 2));
    logger(`=> Saved JSON to ${prodJson}`);

    if (collections.length > 0) {
        fs.writeFileSync(`${filePrefix}_collections.json`, JSON.stringify(collections, null, 2));
    }

    const csvWriter = createObjectCsvWriter({
        path: prodCsv,
        header: [
            { id: 'productId', title: 'Product ID' },
            { id: 'handle', title: 'Handle' },
            { id: 'title', title: 'Title' },
            { id: 'vendor', title: 'Vendor' },
            { id: 'type', title: 'Type' },
            { id: 'tags', title: 'Tags' },
            { id: 'sku', title: 'SKU' },
            { id: 'price', title: 'Price' },
            { id: 'compareAtPrice', title: 'Compare At Price' },
            { id: 'inStock', title: 'In Stock' },
            { id: 'image', title: 'Image URL' }
        ]
    });

    const csvRecords = [];
    for (const p of products) {
        const defaultImage = p.images?.[0]?.src || '';
        const tags = Array.isArray(p.tags) ? p.tags.join(', ') : (p.tags || '');

        for (const v of (p.variants || [{}])) {
            const variantImage = v.featured_image?.src || defaultImage;
            csvRecords.push({
                productId: p.id || '',
                handle: p.handle || '',
                title: p.title || '',
                vendor: p.vendor || '',
                type: p.product_type || p.type || '',
                tags: tags,
                sku: v.sku || '',
                price: v.price || '',
                compareAtPrice: v.compare_at_price || '',
                inStock: v.available === false ? 'No' : 'Yes',
                image: variantImage
            });
        }
    }

    await csvWriter.writeRecords(csvRecords);
    logger(`=> Saved ${csvRecords.length} items to CSV: ${prodCsv}`);

    return {
        success: true,
        files: { json: prodJson, csv: prodCsv }
    };
}

function generateFilePrefix(url) {
    try {
        const urlObj = new URL(url);
        let prefix = urlObj.hostname.replace(/[^a-zA-Z0-9]/g, '_');
        if (urlObj.pathname.length > 1) {
            prefix += urlObj.pathname.replace(/[^a-zA-Z0-9]/g, '_');
        }
        return prefix;
    } catch (e) {
        return url.replace(/[^a-zA-Z0-9]/g, '_');
    }
}

if (require.main === module) {
    const args = process.argv.slice(2);
    if (!args[0]) {
        console.log("Usage: node index.js <url> [mode] [maxPages|auto]");
        console.log("  modes: shopify | shopify_collection | woocommerce | customwheeloffset | forgiato");
        console.log("  maxPages: only used by customwheeloffset");
        console.log("    - a number (default 50) caps the scrape");
        console.log("    - 'auto' keeps fetching until the site returns an empty page");
        console.log("    - full catalog is ~5,476 pages (~164k SKUs)");
    } else {
        let options = {};
        if (args[2]) {
            options = args[2].toLowerCase() === 'auto'
                ? { maxPages: 'auto' }
                : { maxPages: parseInt(args[2], 10) };
        }
        scrapeShopifyStore(args[0], console.log, args[1] || 'shopify', options);
    }
}

module.exports = { scrapeShopifyStore };
