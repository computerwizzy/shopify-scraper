require('dotenv').config();
const axios = require('axios');
const fs = require('fs');
const path = require('path');
const { createObjectCsvWriter } = require('csv-writer');

const MAX_RETRIES = parseInt(process.env.MAX_RETRIES || '3', 10);
const REQUEST_DELAY_MS = parseInt(process.env.REQUEST_DELAY_MS || '800', 10);
const DOWNLOADS_DIR = path.join(__dirname, 'downloads');

const UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/130.0.0.0 Safari/537.36';

function sleep(ms) {
    return new Promise(r => setTimeout(r, ms));
}

function validateUrl(raw) {
    try {
        const u = new URL(raw);
        if (!['http:', 'https:'].includes(u.protocol)) return false;
        const h = u.hostname.toLowerCase();
        // Block private/loopback ranges to prevent SSRF
        if (/^(localhost|127\.|0\.0\.0\.0|10\.|192\.168\.|172\.(1[6-9]|2\d|3[01])\.)/i.test(h)) return false;
        if (h === '::1' || h === '[::1]') return false;
        return true;
    } catch { return false; }
}

async function fetchWithRetry(config, retries = MAX_RETRIES) {
    for (let attempt = 0; attempt <= retries; attempt++) {
        try {
            return await axios(config);
        } catch (err) {
            const status = err.response?.status;
            // Don't retry client errors (except 429 rate limit)
            if (status && status < 500 && status !== 429) throw err;
            if (attempt === retries) throw err;
            await sleep(REQUEST_DELAY_MS * Math.pow(2, attempt));
        }
    }
}

async function scrapeShopifyStore(baseUrl, logger = console.log, mode = 'shopify', options = {}) {
    if (!baseUrl) {
        logger('Error: No store URL provided.');
        return { success: false, error: 'No URL provided' };
    }

    if (!validateUrl(baseUrl)) {
        logger('Error: Invalid or disallowed URL.');
        return { success: false, error: 'Invalid or disallowed URL' };
    }

    baseUrl = baseUrl.replace(/\/$/, '');
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
        } else if (mode === 'shopify_browser' || mode === 'shopify_browser_collection') {
            const result = await handleShopifyBrowserScrape(baseUrl, mode, logger);
            products = result.products;
            collections = result.collections;
        } else if (mode === 'woocommerce') {
            products = await handleWooCommerceScrape(baseUrl, logger);
        } else if (mode === 'customwheeloffset') {
            products = await handleCustomWheelOffsetScrape(baseUrl, logger, options);
        } else if (mode === 'forgiato') {
            products = await handleForgiatoScrape(baseUrl, logger, options);
        } else {
            logger(`Mode [${mode}] not implemented. Falling back to Shopify.`);
            const result = await handleShopifyScrape(baseUrl, 'shopify', logger);
            products = result.products;
        }

        if (products?.length > 0) {
            return await saveResults(products, collections, filePrefix, logger);
        } else {
            logger('No products found to save.');
            return { success: false, error: 'No products found' };
        }
    } catch (error) {
        logger(`Critical error: ${error.message}`);
        return { success: false, error: error.message };
    }
}

async function handleShopifyScrape(baseUrl, mode, logger) {
    let collections = [];
    let products = [];

    if (mode === 'shopify') {
        logger('\n[1/2] Fetching Shopify collections...');
        let page = 1;
        let hasMore = true;
        while (hasMore) {
            try {
                const res = await fetchWithRetry({
                    method: 'get',
                    url: `${baseUrl}/collections.json?limit=250&page=${page}`,
                    headers: { 'User-Agent': UA },
                    timeout: 20000
                });
                if (res.data?.collections?.length > 0) {
                    collections.push(...res.data.collections);
                    logger(`  -> Fetched ${res.data.collections.length} collections (page ${page})`);
                    page++;
                    await sleep(REQUEST_DELAY_MS);
                } else { hasMore = false; }
            } catch { hasMore = false; }
        }
    }

    logger(`\n[2/2] Fetching products from ${mode === 'shopify' ? 'main store' : 'collection'}...`);

    let totalExpected = 0;
    try {
        const countRes = await fetchWithRetry({
            method: 'get',
            url: `${baseUrl}/products/count.json`,
            headers: { 'User-Agent': UA },
            timeout: 10000
        });
        totalExpected = countRes.data.count || 0;
        if (totalExpected) logger(`  (Total products: ${totalExpected})`);
    } catch { /* not all stores expose this */ }

    let page = 1;
    let hasMore = true;
    while (hasMore) {
        try {
            const res = await fetchWithRetry({
                method: 'get',
                url: `${baseUrl}/products.json?limit=250&page=${page}`,
                headers: { 'User-Agent': UA },
                timeout: 20000
            });
            if (res.data?.products?.length > 0) {
                products.push(...res.data.products);
                const msg = totalExpected
                    ? `Fetched ${products.length}/${totalExpected} products...`
                    : `Fetched ${products.length} products (page ${page})...`;
                logger(`  -> ${msg}`);
                page++;
                await sleep(REQUEST_DELAY_MS);
            } else { hasMore = false; }
        } catch (err) {
            logger(`  -> Finished (${err.response?.status || err.message})`);
            hasMore = false;
        }
    }

    return { products, collections };
}

/**
 * Shopify scraper with Playwright browser to bypass Cloudflare WAF.
 * Navigates the site in a real browser to pass the challenge, then uses
 * fetch() from within the page context to access /products.json endpoints.
 * Works with both full-store URLs and collection URLs.
 */
async function handleShopifyBrowserScrape(baseUrl, mode, logger) {
    let chromium;
    try { ({ chromium } = require('playwright')); }
    catch {
        logger('  -> playwright not installed. Run: npm install playwright && npx playwright install chromium');
        return { products: [], collections: [] };
    }

    const urlObj = new URL(baseUrl);
    const origin = urlObj.origin;
    const isCollection = mode === 'shopify_browser_collection' || urlObj.pathname.length > 1;

    logger('\n[1/3] Launching browser to bypass Cloudflare WAF...');
    const headless = process.env.SHOPIFY_BROWSER_HEADLESS === 'true';
    const browser = await chromium.launch({ headless });
    const ctx = await browser.newContext({ userAgent: UA, viewport: { width: 1366, height: 768 }, locale: 'en-US' });

    const products = [];
    const collections = [];

    try {
        const page = await ctx.newPage();
        logger(`  -> Navigating to ${baseUrl}`);
        await page.goto(baseUrl, { waitUntil: 'domcontentloaded', timeout: 60000 });

        // Wait for Cloudflare challenge to clear
        await page.waitForFunction(
            () => !/just a moment/i.test(document.title) && document.readyState === 'complete',
            { timeout: 30000 }
        );
        await page.waitForTimeout(2000);
        logger('  -> Cloudflare bypass successful.');

        // Fetch collections (full-store mode only)
        if (!isCollection) {
            logger('\n[2/3] Fetching collections...');
            let colPage = 1;
            let hasMore = true;
            while (hasMore) {
                const data = await page.evaluate(async (url) => {
                    try { const r = await fetch(url); return r.ok ? r.json() : null; } catch { return null; }
                }, `${origin}/collections.json?limit=250&page=${colPage}`);
                if (data?.collections?.length > 0) {
                    collections.push(...data.collections);
                    logger(`  -> Fetched ${data.collections.length} collections (page ${colPage})`);
                    colPage++;
                } else { hasMore = false; }
            }
        } else {
            logger('\n[2/3] Collection mode — skipping full collections fetch.');
        }

        // Determine products endpoint
        // Collection URL: try {url}/products.json first, fall back to {origin}/products.json
        const productsBase = isCollection ? baseUrl : origin;

        logger('\n[3/3] Fetching products...');
        let totalExpected = 0;
        const countData = await page.evaluate(async (url) => {
            try { const r = await fetch(url); return r.ok ? r.json() : null; } catch { return null; }
        }, `${origin}/products/count.json`);
        if (countData?.count) {
            totalExpected = countData.count;
            logger(`  (Total products in store: ${totalExpected})`);
        }

        const fetchPages = async (base) => {
            let p = 1;
            while (true) {
                const data = await page.evaluate(async (url) => {
                    try { const r = await fetch(url); return r.ok ? r.json() : null; } catch { return null; }
                }, `${base}/products.json?limit=250&page=${p}`);
                if (!data?.products?.length) break;
                products.push(...data.products);
                const msg = totalExpected
                    ? `Fetched ${products.length}/${totalExpected} products...`
                    : `Fetched ${products.length} products (page ${p})...`;
                logger(`  -> ${msg}`);
                p++;
                await page.waitForTimeout(REQUEST_DELAY_MS);
            }
        };

        await fetchPages(productsBase);

        // If collection endpoint returned nothing, fall back to full store
        if (products.length === 0 && isCollection) {
            logger(`  -> Collection endpoint returned nothing, trying full store...`);
            await fetchPages(origin);
        }
    } finally {
        await browser.close();
    }

    return { products, collections };
}

async function handleCustomWheelOffsetScrape(baseUrl, logger, options = {}) {
    const rawLimit = options.maxPages;
    const autoDetect = rawLimit === 'auto' || rawLimit === 0 || rawLimit === null;
    const hardCeiling = 6000;
    const maxPages = autoDetect ? hardCeiling : (rawLimit || 50);
    const modeLabel = autoDetect ? 'auto-detect (stops on empty page)' : `up to ${maxPages} pages`;

    logger(`\n[1/1] Fetching Custom Wheel Offset products (${modeLabel})...`);
    const products = [];
    const seenSkus = new Set();

    for (let page = 1; page <= maxPages; page++) {
        const pageUrl = baseUrl.includes('?') ? `${baseUrl}&page=${page}` : `${baseUrl}?page=${page}`;
        logger(`  -> Fetching page ${page}: ${pageUrl}`);

        let html;
        try {
            const res = await fetchWithRetry({
                method: 'get',
                url: pageUrl,
                headers: {
                    'User-Agent': UA,
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
            logger(`  -> No products on page ${page}. Stopping.`);
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
                ? /InStock/i.test(offer.availability) : true;

            const specTags = [
                item.height && item.width ? `${item.width}x${item.height}`.replace(/in/gi, '') : '',
                item.depth ? `offset ${item.depth}` : '',
                item.color, item.material, item.weight
            ].filter(Boolean).join(' | ');

            products.push({
                id: sku || handle,
                title: [item.name, item.color].filter(Boolean).join(' ').trim(),
                handle,
                vendor: item.manufacturer || item.name?.split(' ')[0] || '',
                product_type: 'Wheels',
                tags: specTags,
                images: item.image ? [{ src: item.image }] : [],
                variants: [{ sku, price, compare_at_price: null, available }]
            });
        }

        logger(`  -> Extracted ${items.length} items (${newCount} new) from page ${page}. Total: ${products.length}`);
        if (newCount === 0) {
            logger(`  -> No new SKUs on page ${page}. Stopping.`);
            break;
        }

        await sleep(REQUEST_DELAY_MS + Math.floor(Math.random() * 400));
    }

    return products;
}

function extractItemListProducts(html) {
    const products = [];
    const scriptRegex = /<script[^>]*>([\s\S]*?)<\/script>/g;
    let m;
    while ((m = scriptRegex.exec(html))) {
        const body = m[1].trim();
        if (!body.includes('ItemList') || !body.includes('itemListElement')) continue;

        const normalized = body
            .replace(/"itemListElement"\s*:\s*\[\s*\[/, '"itemListElement":[')
            .replace(/\]\s*\]\s*\}\s*$/, ']}');
        try {
            const parsed = JSON.parse(normalized);
            for (const entry of (parsed.itemListElement || [])) {
                if (entry?.item) products.push(entry.item);
            }
        } catch {
            const pmRe = /\{"@type":"Product"[\s\S]*?\}\}\}/g;
            let pm;
            while ((pm = pmRe.exec(body))) {
                try { products.push(JSON.parse(pm[0])); } catch { /* skip */ }
            }
        }
    }
    return products;
}

async function handleForgiatoScrape(baseUrl, logger, options = {}) {
    let chromium;
    try { ({ chromium } = require('playwright')); }
    catch {
        logger('  -> playwright not installed. Run: npm install playwright && npx playwright install chromium');
        return [];
    }

    const indexUrl = baseUrl.endsWith('/wheels') || baseUrl.includes('/wheels/') ? baseUrl : `${baseUrl.replace(/\/$/, '')}/wheels`;
    logger('\n[1/2] Launching browser to bypass Cloudflare...');

    // Cloudflare blocks headless Chromium aggressively; headful is default unless FORGIATO_HEADLESS=true
    const headless = process.env.FORGIATO_HEADLESS === 'true' || options.headless === true;
    const browser = await chromium.launch({ headless });
    const ctx = await browser.newContext({
        userAgent: UA,
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
                if (/\/wheels\/[^\/]+\/[^\/]+\/?$/.test(href) && !/\/wheels\/$/.test(href))
                    urls.add(href.replace(/\?.*$/, ''));
            }
            return [...urls];
        });

        logger(`  -> Found ${wheelLinks.length} unique wheel pages.`);
        if (!wheelLinks.length) { logger('  -> No wheels found. Aborting.'); return []; }

        const limit = options.limit || parseInt(process.env.FORGIATO_LIMIT || '0', 10);
        const targets = limit > 0 ? wheelLinks.slice(0, limit) : wheelLinks;
        if (limit > 0) logger(`  -> Limiting to first ${targets.length} wheel(s).`);

        logger('\n[2/2] Scraping each product page...');
        for (let i = 0; i < targets.length; i++) {
            const url = targets[i];
            try {
                await page.goto(url, { waitUntil: 'domcontentloaded', timeout: 45000 });

                // Wait for Cloudflare challenge to clear on each navigation
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
                    const decode = s => typeof s === 'string'
                        ? s.replace(/&#34;/g, '"').replace(/&#39;/g, "'")
                           .replace(/&amp;/g, '&').replace(/&quot;/g, '"')
                           .replace(/&lt;/g, '<').replace(/&gt;/g, '>')
                        : s;

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

                    const h1 = (
                        document.querySelector('h1.wd-header__name') ||
                        document.querySelector('main h1') ||
                        document.querySelector('h1')
                    )?.textContent?.trim();

                    const series = [...document.querySelectorAll('.wheel-series, [class*="series"], h2, .tag')]
                        .map(e => e.textContent.trim())
                        .find(t => /ECL|3 PIECE|Monoleggera|Flat Forging|Floater|Tecnica/i.test(t)) || '';

                    const allImages = [...document.querySelectorAll('img')]
                        .map(i => ({ src: i.currentSrc || i.src, alt: i.alt || '' }))
                        .filter(i => i.src && !/logo|icon|og-image|forging-sketch/i.test(i.src));

                    return {
                        h1, series,
                        productLd: productLd
                            ? JSON.parse(JSON.stringify(productLd, (_k, v) => typeof v === 'string' ? decode(v) : v))
                            : null,
                        images: allImages
                    };
                });

                const ld = data.productLd || {};
                const additional = Object.fromEntries((ld.additionalProperty || []).map(p => [p.name, p.value]));
                const primaryImage = ld.image || data.images[0]?.src || '';
                const galleryImages = [...new Set(data.images.map(i => i.src))];
                const price = ld.offers?.price ? Number(ld.offers.price).toFixed(2) : '';

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

            await page.waitForTimeout(500 + Math.floor(Math.random() * 300));
        }
    } finally {
        await browser.close();
    }

    return products;
}

async function handleWooCommerceScrape(baseUrl, logger) {
    logger('\n[1/1] Fetching WooCommerce products...');
    let products = [];
    let page = 1;
    const PAGE_CAP = 200;

    while (page <= PAGE_CAP) {
        try {
            const res = await fetchWithRetry({
                method: 'get',
                url: `${baseUrl}/wp-json/wc/store/v1/products?page=${page}&per_page=100`,
                headers: { 'User-Agent': UA },
                timeout: 20000
            });
            if (!res.data?.length) break;
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
                    price: p.prices?.price
                        ? (Number(p.prices.price) / Math.pow(10, p.prices.currency_minor_unit || 2)).toFixed(2)
                        : '',
                    compare_at_price: p.prices?.regular_price
                        ? (Number(p.prices.regular_price) / Math.pow(10, p.prices.currency_minor_unit || 2)).toFixed(2)
                        : '',
                    available: p.is_in_stock !== false
                }]
            }));
            products.push(...mapped);
            logger(`  -> Fetched ${res.data.length} products (page ${page})`);
            page++;
            await sleep(REQUEST_DELAY_MS);
        } catch (err) {
            logger(`  -> WC Store API error (${err.response?.status || err.message}).`);
            break;
        }
    }
    return products;
}

async function saveResults(products, collections, filePrefix, logger) {
    fs.mkdirSync(DOWNLOADS_DIR, { recursive: true });

    const jsonFile = `${filePrefix}_products.json`;
    const csvFile = `${filePrefix}_products.csv`;

    fs.writeFileSync(path.join(DOWNLOADS_DIR, jsonFile), JSON.stringify(products, null, 2));
    logger(`=> Saved JSON: ${jsonFile}`);

    if (collections?.length > 0) {
        fs.writeFileSync(
            path.join(DOWNLOADS_DIR, `${filePrefix}_collections.json`),
            JSON.stringify(collections, null, 2)
        );
    }

    const csvWriter = createObjectCsvWriter({
        path: path.join(DOWNLOADS_DIR, csvFile),
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

    const records = [];
    for (const p of products) {
        const defaultImage = p.images?.[0]?.src || '';
        const tags = Array.isArray(p.tags) ? p.tags.join(', ') : (p.tags || '');
        for (const v of (p.variants || [{}])) {
            records.push({
                productId: p.id || '',
                handle: p.handle || '',
                title: p.title || '',
                vendor: p.vendor || '',
                type: p.product_type || p.type || '',
                tags,
                sku: v.sku || '',
                price: v.price || '',
                compareAtPrice: v.compare_at_price || '',
                inStock: v.available === false ? 'No' : 'Yes',
                image: v.featured_image?.src || defaultImage
            });
        }
    }

    await csvWriter.writeRecords(records);
    logger(`=> Saved ${records.length} rows to CSV: ${csvFile}`);

    return { success: true, files: { json: jsonFile, csv: csvFile } };
}

function generateFilePrefix(url) {
    try {
        const u = new URL(url);
        let prefix = u.hostname.replace(/[^a-zA-Z0-9]/g, '_');
        if (u.pathname.length > 1) prefix += u.pathname.replace(/[^a-zA-Z0-9]/g, '_');
        return prefix.replace(/_{2,}/g, '_').replace(/^_|_$/g, '');
    } catch {
        return url.replace(/[^a-zA-Z0-9]/g, '_');
    }
}

if (require.main === module) {
    const args = process.argv.slice(2);
    if (!args[0]) {
        console.log('Usage: node index.js <url> [mode] [maxPages|auto]');
        console.log('  modes: shopify | shopify_collection | woocommerce | customwheeloffset | forgiato | generic');
        console.log('  maxPages: only used by customwheeloffset');
        console.log('    - a number (default 50) caps the scrape');
        console.log("    - 'auto' keeps fetching until an empty page is returned");
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

/**
 * Detects what ecommerce platform a URL is running on.
 * Returns { mode, confidence, reason } where mode matches the UI dropdown values.
 *
 * Strategy:
 *  1. Try a direct HTTP request and scan HTML for platform signatures
 *  2. Try Shopify / WooCommerce JSON endpoints directly
 *  3. If blocked by WAF/Cloudflare, launch a browser, bypass the challenge,
 *     and test endpoints from inside the browser session
 */
async function detectPlatform(rawUrl, logger = console.log) {
    if (!validateUrl(rawUrl)) return { mode: null, confidence: 'none', reason: 'Invalid URL' };

    const urlObj = new URL(rawUrl.replace(/\/$/, ''));
    const origin = urlObj.origin;
    const isSubPath = urlObj.pathname.length > 1;

    logger('Detecting platform...');

    // --- Phase 1: direct HTTP ---
    let html = '';
    let directBlocked = false;
    try {
        const res = await axios.get(rawUrl, {
            headers: { 'User-Agent': UA },
            timeout: 10000,
            validateStatus: s => s < 500
        });
        html = typeof res.data === 'string' ? res.data : JSON.stringify(res.data);
    } catch (err) {
        const status = err.response?.status;
        if (status === 403 || status === 503 || !status) {
            logger('  -> Direct request blocked (WAF/Cloudflare). Switching to browser detection...');
            directBlocked = true;
        }
    }

    if (!directBlocked && html) {
        // Shopify signatures
        if (/cdn\.shopify\.com|Shopify\.theme|myshopify\.com|shopify-features/i.test(html)) {
            const confirmed = await probeShopifyEndpoints(origin);
            const mode = isSubPath ? 'shopify_collection' : 'shopify';
            return { mode, confidence: confirmed ? 'high' : 'medium', reason: confirmed ? 'Shopify CDN + /products.json confirmed' : 'Shopify CDN detected' };
        }
        // WooCommerce signatures
        if (/wp-content|woocommerce|\/wp-json\//i.test(html)) {
            return { mode: 'woocommerce', confidence: 'high', reason: 'WordPress/WooCommerce detected in page source' };
        }
        // BigCommerce
        if (/cdn\.bigcommerce\.com|BCData|bigcommerce/i.test(html)) {
            return { mode: 'generic', confidence: 'medium', reason: 'BigCommerce detected (not natively supported — try Generic)' };
        }
    }

    // --- Phase 2: probe JSON endpoints directly ---
    if (!directBlocked) {
        const shopifyOk = await probeShopifyEndpoints(origin);
        if (shopifyOk) {
            const mode = isSubPath ? 'shopify_collection' : 'shopify';
            return { mode, confidence: 'high', reason: 'Shopify /products.json endpoint confirmed' };
        }
        const wooOk = await probeWooEndpoint(origin);
        if (wooOk) {
            return { mode: 'woocommerce', confidence: 'high', reason: 'WooCommerce Store API confirmed' };
        }
    }

    // --- Phase 3: browser-based detection (Cloudflare bypass) ---
    return await detectWithBrowser(rawUrl, origin, isSubPath, logger);
}

async function probeShopifyEndpoints(origin) {
    try {
        const res = await axios.get(`${origin}/products.json?limit=1`, { headers: { 'User-Agent': UA }, timeout: 6000 });
        return Array.isArray(res.data?.products);
    } catch { return false; }
}

async function probeWooEndpoint(origin) {
    try {
        const res = await axios.get(`${origin}/wp-json/wc/store/v1/products?per_page=1`, { headers: { 'User-Agent': UA }, timeout: 6000 });
        return Array.isArray(res.data);
    } catch { return false; }
}

async function detectWithBrowser(rawUrl, origin, isSubPath, logger) {
    let chromium;
    try { ({ chromium } = require('playwright')); }
    catch {
        return { mode: 'shopify_browser', confidence: 'low', reason: 'Playwright not installed — defaulting to Shopify Browser mode' };
    }

    logger('  -> Launching browser for detection...');
    const headless = process.env.SHOPIFY_BROWSER_HEADLESS === 'true';
    const browser = await chromium.launch({ headless });
    const ctx = await browser.newContext({ userAgent: UA, viewport: { width: 1366, height: 768 }, locale: 'en-US' });

    try {
        const page = await ctx.newPage();
        await page.goto(rawUrl, { waitUntil: 'domcontentloaded', timeout: 45000 });
        await page.waitForFunction(() => !/just a moment/i.test(document.title), { timeout: 25000 });
        await page.waitForTimeout(1500);

        // Detect platform from page source inside browser
        const platformHint = await page.evaluate(() => {
            const html = document.documentElement.innerHTML;
            if (/cdn\.shopify\.com|Shopify\.theme|myshopify\.com/i.test(html) || window.Shopify) return 'shopify';
            if (/wp-content|woocommerce/i.test(html)) return 'woocommerce';
            if (/cdn\.bigcommerce\.com|BCData/i.test(html)) return 'bigcommerce';
            return 'unknown';
        });

        // Confirm Shopify by probing /products.json from inside the browser session
        const shopifyConfirmed = await page.evaluate(async (url) => {
            try {
                const r = await fetch(url);
                if (!r.ok) return false;
                const d = await r.json();
                return Array.isArray(d.products);
            } catch { return false; }
        }, `${origin}/products.json?limit=1`);

        if (shopifyConfirmed) {
            const mode = isSubPath ? 'shopify_browser_collection' : 'shopify_browser';
            return { mode, confidence: 'high', reason: 'Cloudflare-protected Shopify — /products.json confirmed via browser' };
        }

        // Confirm WooCommerce from inside browser
        const wooConfirmed = await page.evaluate(async (url) => {
            try {
                const r = await fetch(url);
                if (!r.ok) return false;
                const d = await r.json();
                return Array.isArray(d);
            } catch { return false; }
        }, `${origin}/wp-json/wc/store/v1/products?per_page=1`);

        if (wooConfirmed) {
            return { mode: 'woocommerce', confidence: 'high', reason: 'Cloudflare-protected WooCommerce — Store API confirmed via browser' };
        }

        if (platformHint === 'bigcommerce') {
            return { mode: 'generic', confidence: 'medium', reason: 'BigCommerce detected via browser (not natively supported)' };
        }

        return { mode: 'shopify_browser', confidence: 'low', reason: `Unknown platform (hint: ${platformHint}) — try Shopify Browser mode` };
    } catch (err) {
        return { mode: 'shopify_browser', confidence: 'low', reason: `Browser detection failed: ${err.message}` };
    } finally {
        await browser.close();
    }
}

module.exports = { scrapeShopifyStore, detectPlatform };
