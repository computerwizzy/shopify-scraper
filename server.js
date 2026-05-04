const express = require('express');
const cors = require('cors');
const path = require('path');
const { scrapeShopifyStore } = require('./index');

const app = express();
const PORT = process.env.PORT || 3000;

app.use(cors());
app.use(express.json());
app.use(express.static('public'));

app.use('/downloads', express.static(path.join(__dirname)));

let currentLogs = [];
let isScraping = false;
let lastResult = null;

app.post('/api/scrape', async (req, res) => {
    const { url, mode, maxPages } = req.body;
    if (!url) {
        return res.status(400).json({ error: 'URL is required' });
    }

    if (isScraping) {
        return res.status(400).json({ error: 'Scrape already in progress' });
    }

    let options = {};
    if (typeof maxPages === 'string' && maxPages.toLowerCase() === 'auto') {
        options = { maxPages: 'auto' };
    } else if (maxPages !== undefined && maxPages !== null && maxPages !== '') {
        const parsed = parseInt(maxPages, 10);
        if (Number.isFinite(parsed) && parsed > 0) options = { maxPages: parsed };
    }

    isScraping = true;
    currentLogs = [`[${new Date().toLocaleTimeString()}] Starting scrape for ${url}...`];
    lastResult = null;

    res.json({ message: 'Scraping started' });

    try {
        const result = await scrapeShopifyStore(url, (msg) => {
            currentLogs.push(msg);
            console.log(msg);
        }, mode, options);
        lastResult = result;
    } catch (err) {
        currentLogs.push(`Error: ${err.message}`);
        lastResult = { success: false, error: err.message };
    } finally {
        isScraping = false;
    }
});

app.get('/api/status', (req, res) => {
    res.json({
        isScraping,
        logs: currentLogs,
        result: lastResult
    });
});

app.listen(PORT, () => {
    console.log(`Server running at http://localhost:${PORT}`);
});
