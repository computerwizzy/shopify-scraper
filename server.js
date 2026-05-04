require('dotenv').config();
const express = require('express');
const cors = require('cors');
const path = require('path');
const fs = require('fs');
const { scrapeShopifyStore, detectPlatform } = require('./index');

const app = express();
const PORT = parseInt(process.env.PORT || '3000', 10);
const MAX_LOG_LINES = parseInt(process.env.MAX_LOG_LINES || '500', 10);
const DOWNLOADS_DIR = path.join(__dirname, 'downloads');

fs.mkdirSync(DOWNLOADS_DIR, { recursive: true });

app.use(cors());
app.use(express.json());
app.use(express.static('public'));
// Serve only the downloads/ subdirectory — not the entire project root
app.use('/downloads', express.static(DOWNLOADS_DIR));

let currentLogs = [];
let isScraping = false;
let lastResult = null;

function pushLog(msg) {
    currentLogs.push(msg);
    if (currentLogs.length > MAX_LOG_LINES) currentLogs = currentLogs.slice(-MAX_LOG_LINES);
    console.log(msg);
}

function isValidUrl(raw) {
    try {
        const u = new URL(raw);
        if (!['http:', 'https:'].includes(u.protocol)) return false;
        const h = u.hostname.toLowerCase();
        // Block private/loopback ranges to prevent SSRF
        if (/^(localhost|127\.|0\.0\.0\.0|10\.|192\.168\.|172\.(1[6-9]|2\d|3[01])\.)/i.test(h)) return false;
        return true;
    } catch { return false; }
}

app.post('/api/scrape', async (req, res) => {
    const { url, mode, maxPages } = req.body;

    if (!url || typeof url !== 'string') {
        return res.status(400).json({ error: 'URL is required' });
    }
    if (!isValidUrl(url)) {
        return res.status(400).json({ error: 'Invalid or disallowed URL' });
    }
    if (isScraping) {
        return res.status(409).json({ error: 'A scrape is already in progress. Please wait.' });
    }

    let options = {};
    if (typeof maxPages === 'string' && maxPages.toLowerCase() === 'auto') {
        options = { maxPages: 'auto' };
    } else if (maxPages !== undefined && maxPages !== null && maxPages !== '') {
        const parsed = parseInt(maxPages, 10);
        if (Number.isFinite(parsed) && parsed > 0) options = { maxPages: parsed };
    }

    isScraping = true;
    currentLogs = [`[${new Date().toLocaleTimeString()}] Starting ${mode} scrape for ${url}...`];
    lastResult = null;

    res.json({ message: 'Scraping started' });

    try {
        lastResult = await scrapeShopifyStore(url, pushLog, mode, options);
    } catch (err) {
        pushLog(`Error: ${err.message}`);
        lastResult = { success: false, error: err.message };
    } finally {
        isScraping = false;
    }
});

app.post('/api/detect', async (req, res) => {
    const { url } = req.body;
    if (!url || typeof url !== 'string') return res.status(400).json({ error: 'URL is required' });
    if (!isValidUrl(url)) return res.status(400).json({ error: 'Invalid or disallowed URL' });

    const logs = [];
    try {
        const result = await detectPlatform(url, msg => { logs.push(msg); console.log(msg); });
        res.json({ ...result, logs });
    } catch (err) {
        res.status(500).json({ error: err.message, logs });
    }
});

app.get('/api/status', (_req, res) => {
    res.json({ isScraping, logs: currentLogs, result: lastResult });
});

const server = app.listen(PORT, () => {
    console.log(`Server running at http://localhost:${PORT}`);
});

function shutdown() {
    console.log('\nShutting down gracefully...');
    server.close(() => {
        console.log('Server closed.');
        process.exit(0);
    });
    // Force exit if connections are still hanging after 10s
    setTimeout(() => process.exit(1), 10000);
}

process.on('SIGTERM', shutdown);
process.on('SIGINT', shutdown);
