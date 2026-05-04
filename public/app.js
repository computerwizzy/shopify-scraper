const scrapeBtn = document.getElementById('scrape-btn');
const detectBtn = document.getElementById('detect-btn');
const detectResult = document.getElementById('detect-result');
const storeUrlInput = document.getElementById('store-url');
const statusCard = document.getElementById('status-card');
const logViewer = document.getElementById('log-viewer');
const statusText = document.getElementById('status-text');
const resultsArea = document.getElementById('results-area');
const downloadCsv = document.getElementById('download-csv');
const downloadJson = document.getElementById('download-json');
const btnText = scrapeBtn.querySelector('.btn-text');
const loader = scrapeBtn.querySelector('.loader');
const progressContainer = document.getElementById('progress-container');
const progressFill = document.getElementById('progress-fill');
const platformMode = document.getElementById('platform-mode');
const maxPagesGroup = document.getElementById('max-pages-group');
const maxPagesInput = document.getElementById('max-pages');

function toggleMaxPagesVisibility() {
    if (platformMode.value === 'customwheeloffset') {
        maxPagesGroup.classList.remove('hidden');
    } else {
        maxPagesGroup.classList.add('hidden');
    }
}
platformMode.addEventListener('change', toggleMaxPagesVisibility);
toggleMaxPagesVisibility();

detectBtn.addEventListener('click', async () => {
    const url = storeUrlInput.value.trim();
    if (!url) return alert('Please enter a URL first');

    const dBtnText = detectBtn.querySelector('.btn-text');
    const dLoader = detectBtn.querySelector('.loader');
    dBtnText.classList.add('hidden');
    dLoader.classList.remove('hidden');
    detectBtn.disabled = true;
    scrapeBtn.disabled = true;
    detectResult.className = 'hint';
    detectResult.textContent = 'Detecting platform...';

    try {
        const res = await fetch('/api/detect', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ url })
        });
        const data = await res.json();

        if (data.confidence === 'high' || data.confidence === 'medium') {
            platformMode.value = data.mode;
            toggleMaxPagesVisibility();
            const badge = data.confidence === 'high' ? '✓' : '~';
            detectResult.innerHTML = `${badge} Detected: <strong>${platformMode.options[platformMode.selectedIndex].text}</strong> — ${data.reason}`;
            detectResult.style.color = data.confidence === 'high' ? '#34d399' : '#fbbf24';
        } else {
            // Low confidence or blocked — give the user actionable manual steps
            const origin = (() => { try { return new URL(url).origin; } catch { return url; } })();
            detectResult.innerHTML =
                `⚠ Could not auto-detect (site blocked our server).<br>` +
                `Check these URLs in your own browser:<br>` +
                `&nbsp;&nbsp;<a href="${origin}/products.json?limit=1" target="_blank" style="color:#a78bfa">${origin}/products.json?limit=1</a> → JSON with "products" array = <strong>Shopify</strong><br>` +
                `&nbsp;&nbsp;<a href="${origin}/wp-json" target="_blank" style="color:#a78bfa">${origin}/wp-json</a> → JSON with "namespaces" = <strong>WooCommerce</strong>`;
            detectResult.style.color = '#fbbf24';
            if (data.mode) {
                platformMode.value = data.mode;
                toggleMaxPagesVisibility();
            }
        }
        detectResult.classList.remove('hidden');
    } catch (err) {
        detectResult.textContent = `Detection error: ${err.message}`;
        detectResult.style.color = '#f87171';
        detectResult.classList.remove('hidden');
    } finally {
        dBtnText.classList.remove('hidden');
        dLoader.classList.add('hidden');
        detectBtn.disabled = false;
        scrapeBtn.disabled = false;
    }
});

let pollInterval = null;

scrapeBtn.addEventListener('click', async () => {
    const url = storeUrlInput.value.trim();
    const mode = platformMode.value;
    let maxPages;
    if (mode === 'customwheeloffset') {
        const raw = (maxPagesInput.value || '').trim().toLowerCase();
        maxPages = raw === 'auto' || raw === '' ? 'auto' : (parseInt(raw, 10) || 50);
    }
    if (!url) return alert('Please enter a URL');

    btnText.classList.add('hidden');
    loader.classList.remove('hidden');
    scrapeBtn.disabled = true;
    statusCard.classList.remove('hidden');
    progressContainer.classList.add('hidden');
    progressFill.style.width = '0%';
    logViewer.innerHTML = `<div class="log-line system">> Initializing ${mode} scrape request...</div>`;
    resultsArea.classList.add('hidden');

    try {
        const response = await fetch('/api/scrape', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ url, mode, maxPages })
        });

        if (!response.ok) {
            const err = await response.json();
            if (response.status === 409) {
                throw new Error('A scrape is already running. Wait for it to finish, then try again.');
            }
            throw new Error(err.error || 'Failed to start scrape');
        }

        startPolling();
    } catch (err) {
        addLog(`Error: ${err.message}`, 'error');
        resetBtn();
    }
});

function startPolling() {
    if (pollInterval) clearInterval(pollInterval);

    pollInterval = setInterval(async () => {
        try {
            const res = await fetch('/api/status');
            const data = await res.json();

            updateLogs(data.logs);

            if (!data.isScraping && data.result) {
                clearInterval(pollInterval);
                finishScrape(data.result);
            }
        } catch (err) {
            console.error('Polling error:', err);
        }
    }, 1000);
}

function updateLogs(logs) {
    const currentLines = logViewer.querySelectorAll('.log-line').length;
    if (logs.length > currentLines) {
        for (let i = currentLines; i < logs.length; i++) {
            const msg = logs[i];
            addLog(msg);

            const progressMatch = msg.match(/Fetched (\d+)\/(\d+)/);
            if (progressMatch) {
                const current = parseInt(progressMatch[1]);
                const total = parseInt(progressMatch[2]);
                const percent = Math.min(100, Math.round((current / total) * 100));

                progressContainer.classList.remove('hidden');
                progressFill.style.width = `${percent}%`;
                statusText.textContent = `Scraping (${percent}%)`;
            } else if (msg.includes('Fetching')) {
                statusText.textContent = 'Processing...';
            }
        }
    }
}

function addLog(msg, type = 'normal') {
    const div = document.createElement('div');
    div.className = `log-line ${type}`;
    div.textContent = msg.startsWith('>') ? msg : `> ${msg}`;
    logViewer.appendChild(div);
    logViewer.scrollTop = logViewer.scrollHeight;
}

function finishScrape(result) {
    resetBtn();
    if (result.success) {
        statusText.textContent = 'Complete';
        resultsArea.classList.remove('hidden');
        downloadCsv.href = `/downloads/${result.files.csv}`;
        downloadJson.href = `/downloads/${result.files.json}`;
        addLog('Extraction verified. Ready for download.', 'system');
    } else {
        statusText.textContent = 'Failed';
        addLog(`Extraction failed: ${result.error}`, 'error');
    }
}

function resetBtn() {
    btnText.classList.remove('hidden');
    loader.classList.add('hidden');
    scrapeBtn.disabled = false;
}
