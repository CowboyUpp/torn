// ==UserScript==
// @name         Torn Item Market Portfolio
// @namespace    https://github.com/CowboyUpp
// @version      2.8.7
// @description  Aggregates your active Item Market listings into an easy-to-read summary with listing totals, market values and buyback values.
// @author       cowboyup
// @match        https://www.torn.com/page.php?sid=ItemMarket*
// @grant        GM_setValue
// @grant        GM_getValue
// @grant        GM_addStyle
// @grant        GM_xmlhttpRequest
// @connect      api.torn.com
// ==/UserScript==

(function () {
    'use strict';

    /*************************************************************************
     * Item Market Portfolio
     * -----------------------------------------------------------------------
     * Shows an aggregated portfolio view for active Item Market listings.
     * Fetches Torn v2 user/itemmarket pages, groups identical item IDs, and
     * combines listing total, market value, Torn buyback value, and quantity.
     *
     * v2.8.7 cleanup:
     * - Reorganized into professional categories.
     * - Removed stale/unused debug-style code paths.
     * - Hardened API-key handling and URL construction.
     * - Kept the original inline toggle behavior with version label.
     * - Keeps the inline toggle hidden while the popup is open.
     *************************************************************************/

    /*************************************************************************
     * 1) Constants & Settings
     *************************************************************************/

    const SCRIPT = Object.freeze({
        name: 'Item Market Portfolio',
        version: '2.8.7',
        title: 'Item Market Portfolio',
        subtitle: 'Aggregated Listings Summary'
    });

    const ROUTE = Object.freeze({
        itemMarketHash: '#/viewListing'
    });

    const STORAGE = Object.freeze({
        apiKey: 'torn_api_key',
        itemCatalog: 'tm_item_catalog_cache_v2',
        itemCatalogTime: 'tm_item_catalog_cache_time_v2'
    });

    const API = Object.freeze({
        base: 'https://api.torn.com/v2',
        pageSize: 100,
        pageDelayMs: 650,
        maxPages: 1000, // 100,000 listing rows safety cap
        timeoutMs: 15000,
        itemCatalogTtlMs: 24 * 60 * 60 * 1000
    });

    /*************************************************************************
     * 2) Runtime State
     *************************************************************************/

    let apiKey = String(GM_getValue(STORAGE.apiKey, '') || '').trim();
    let itemCatalogCache = GM_getValue(STORAGE.itemCatalog, null);
    let itemCatalogCacheTime = Number(GM_getValue(STORAGE.itemCatalogTime, 0)) || 0;

    /*************************************************************************
     * 3) Styles
     *************************************************************************/

    GM_addStyle(`
        #tm-market-fixed-toggle {
            display: none;
            align-items: center;
            position: fixed;
            bottom: 15px;
            right: 15px;
            background: #222;
            border: 1px solid #444;
            padding: 8px 14px;
            border-radius: 4px;
            z-index: 2147483647;
            font-family: Arial, sans-serif;
            font-size: 13px;
            color: #fff;
            box-shadow: 0 4px 12px rgba(0,0,0,0.7);
            user-select: none;
        }
        #tm-market-fixed-toggle.tm-inline-toggle {
            position: static;
            display: none;
            align-items: center;
            background: transparent;
            border: none;
            padding: 0 16px;
            margin: 0;
            box-shadow: none;
            font-family: Arial, Helvetica, sans-serif;
            font-size: 13px;
            font-weight: normal;
            color: #555;
        }
        #tm-market-fixed-toggle.tm-inline-toggle:hover { color: #222; }

        .tm-switch {
            position: relative;
            display: inline-block;
            width: 34px;
            height: 18px;
            margin-right: 8px;
        }
        .tm-switch input { opacity: 0; width: 0; height: 0; }
        .tm-slider {
            position: absolute;
            cursor: pointer;
            top: 0;
            left: 0;
            right: 0;
            bottom: 0;
            background-color: #555;
            transition: .2s;
            border-radius: 20px;
        }
        .tm-slider:before {
            position: absolute;
            content: "";
            height: 12px;
            width: 12px;
            left: 3px;
            bottom: 3px;
            background-color: #fff;
            transition: .2s;
            border-radius: 50%;
        }
        .tm-inline-toggle .tm-slider { background-color: #ccc; }
        input:checked + .tm-slider { background-color: #3788E5; }
        input:checked + .tm-slider:before { transform: translateX(16px); }
        .tm-inline-toggle input:checked + .tm-slider { background-color: #4e97d9; }
        .tm-version {
            margin-left: 6px;
            font-size: 11px;
            color: #888;
            font-weight: normal;
        }

        #tm-summary-overlay {
            position: fixed;
            top: 92px;
            right: 18px;
            width: min(760px, calc(100vw - 36px));
            max-height: 82vh;
            background: #f4f6f8;
            border: 1px solid rgba(0,0,0,.22);
            border-radius: 10px;
            z-index: 2147483646;
            box-shadow: 0 16px 45px rgba(0,0,0,.35);
            display: none;
            flex-direction: column;
            color: #27313d;
            font-family: Arial, Helvetica, sans-serif;
            overflow: hidden;
        }
        .tm-header {
            background: linear-gradient(180deg,#ffffff 0%,#dfe5ec 100%);
            padding: 12px 14px;
            font-weight: 800;
            border-bottom: 1px solid rgba(0,0,0,.18);
            display: flex;
            justify-content: space-between;
            align-items: center;
            color: #27313d;
            text-shadow: 0 1px 0 rgba(255,255,255,.85);
        }
        .tm-header-title {
            display: flex;
            flex-direction: column;
            gap: 2px;
        }
        .tm-header-title small {
            color: #68717c;
            font-size: 11px;
            font-weight: 700;
        }
        .tm-close {
            cursor: pointer;
            color: #6b7280;
            font-size: 20px;
            font-weight: 900;
            line-height: 1;
            border-radius: 50%;
            width: 26px;
            height: 26px;
            display: flex;
            align-items: center;
            justify-content: center;
        }
        .tm-close:hover { color: #b91c1c; background: rgba(185,28,28,.08); }
        .tm-body { padding: 14px; overflow-y: auto; flex-grow: 1; background: #f4f6f8; }

        .tm-metrics {
            display: grid;
            grid-template-columns: repeat(3, 1fr);
            gap: 10px;
            margin-bottom: 12px;
        }
        .tm-card {
            background: linear-gradient(180deg,#ffffff 0%,#eef2f6 100%);
            padding: 10px;
            border-radius: 8px;
            border: 1px solid rgba(0,0,0,.12);
            box-shadow: inset 0 1px 0 rgba(255,255,255,.8), 0 1px 2px rgba(0,0,0,.06);
            font-size: 11px;
            color: #68717c;
            font-weight: 800;
        }
        .tm-card span { display: block; font-size: 14px; font-weight: 900; margin-top: 5px; }
        .c-blue { color: #2563eb; }
        .c-green { color: #15803d; }
        .c-orange { color: #d97706; }

        .tm-table {
            width: 100%;
            border-collapse: separate;
            border-spacing: 0;
            font-size: 12px;
            text-align: left;
            background: #fff;
            border: 1px solid rgba(0,0,0,.12);
            border-radius: 8px;
            overflow: hidden;
        }
        .tm-table th, .tm-table td { padding: 9px 8px; border-bottom: 1px solid rgba(0,0,0,.08); }
        .tm-table tr:last-child td { border-bottom: none; }
        .tm-table th {
            background: linear-gradient(180deg,#f7f9fb 0%,#e4e9ef 100%);
            color: #4b5563;
            font-weight: 800;
            text-shadow: 0 1px 0 rgba(255,255,255,.75);
        }
        .tm-table tbody tr:hover { background: #f7fafc; }

        .tm-input-field {
            background: #fff;
            color: #27313d;
            border: 1px solid rgba(0,0,0,.24);
            padding: 7px 8px;
            border-radius: 5px;
            width: 65%;
            margin-right: 6px;
            box-shadow: inset 0 1px 2px rgba(0,0,0,.08);
        }
        .tm-btn {
            background: linear-gradient(180deg,#4f9be8 0%,#2563eb 100%);
            color: #fff;
            border: 1px solid rgba(0,0,0,.18);
            padding: 7px 12px;
            border-radius: 5px;
            cursor: pointer;
            font-weight: 800;
            box-shadow: inset 0 1px 0 rgba(255,255,255,.25), 0 1px 2px rgba(0,0,0,.12);
        }
        .tm-btn:hover { filter: brightness(1.04); }

        .tm-debug-details {
            margin-bottom: 12px;
            color: #667085;
            background: linear-gradient(180deg,#ffffff 0%,#f1f4f7 100%);
            border: 1px solid rgba(0,0,0,.12);
            border-radius: 7px;
            padding: 8px 10px;
            box-shadow: inset 0 1px 0 rgba(255,255,255,.75);
        }
        .tm-debug-details summary {
            cursor: pointer;
            font-size: 11px;
            color: #6b7280;
            font-weight: 700;
        }
        .tm-debug-details pre {
            background: #f8fafc !important;
            color: #374151 !important;
            border: 1px solid rgba(0,0,0,.10) !important;
            padding: 8px;
            border-radius: 5px;
            font-size: 11px;
            overflow-x: auto;
            white-space: pre-wrap;
            word-break: break-all;
            margin-top: 7px;
        }
        .tm-cache-notice {
            margin: 10px 0 12px;
            padding: 9px 12px;
            border: 1px solid #c9d9ec;
            background: #edf4fc;
            border-radius: 6px;
            color: #3d4b5c;
            font-size: 12px;
        }
        .tm-warning-notice {
            margin: 10px 0 12px;
            padding: 9px 12px;
            border: 1px solid #f4d19b;
            background: #fff6e8;
            border-radius: 6px;
            color: #765019;
            font-size: 12px;
        }
        .tm-muted-line {
            font-size: 11px;
            color: #888;
            margin: -4px 0 10px;
        }
        @media (max-width: 720px) {
            .tm-metrics { grid-template-columns: 1fr; }
            #tm-summary-overlay { right: 8px; width: calc(100vw - 16px); }
        }
    `);

    /*************************************************************************
     * 4) Utilities
     *************************************************************************/

    function $(id) {
        return document.getElementById(id);
    }

    function esc(value) {
        return String(value).replace(/[&<>"']/g, (char) => ({
            '&': '&amp;',
            '<': '&lt;',
            '>': '&gt;',
            '"': '&quot;',
            "'": '&#39;'
        }[char]));
    }

    function formatMoney(value) {
        const number = Number(value) || 0;
        return '$' + Math.floor(number).toLocaleString('en-US');
    }

    function formatNumber(value) {
        return Math.floor(Number(value) || 0).toLocaleString('en-US');
    }

    function formatCacheDateTime(timestamp) {
        if (!timestamp) return 'unknown';
        try {
            return new Date(timestamp).toLocaleString();
        } catch (error) {
            return 'unknown';
        }
    }

    function sleep(ms) {
        return new Promise(resolve => setTimeout(resolve, ms));
    }

    function isValidApiKey(value) {
        return /^[A-Za-z0-9]{16}$/.test(String(value || '').trim());
    }

    /*************************************************************************
     * 5) API Helpers
     *************************************************************************/

    function buildApiUrl(path, params = {}) {
        const url = new URL(API.base + path);
        Object.entries(params).forEach(([key, value]) => {
            if (value !== undefined && value !== null && value !== '') {
                url.searchParams.set(key, String(value));
            }
        });
        if (apiKey) url.searchParams.set('key', apiKey);
        return url.toString();
    }

    function requestJson(url) {
        return new Promise((resolve) => {
            GM_xmlhttpRequest({
                method: 'GET',
                url,
                timeout: API.timeoutMs,
                onload: (response) => {
                    try {
                        resolve(JSON.parse(response.responseText));
                    } catch (error) {
                        resolve({ error: { error: 'Payload parsing error' } });
                    }
                },
                onerror: () => resolve({ error: { error: 'Network request failed' } }),
                ontimeout: () => resolve({ error: { error: 'Request timed out' } })
            });
        });
    }

    function ensureKeyOnUrl(url) {
        if (!url) return null;
        try {
            const nextUrl = new URL(url, API.base);
            if (!nextUrl.searchParams.get('key')) nextUrl.searchParams.set('key', apiKey);
            return nextUrl.toString();
        } catch (error) {
            return null;
        }
    }

    function getNextPageUrl(response) {
        const links = response && response._metadata && response._metadata.links;
        const next = links && (links.next || links.next_page || links['next']);
        if (typeof next === 'string' && next) return ensureKeyOnUrl(next);
        if (next && typeof next.href === 'string') return ensureKeyOnUrl(next.href);
        return null;
    }

    /*************************************************************************
     * 6) Item Catalog Cache
     *************************************************************************/

    function normalizeItemCatalog(rawItems) {
        const map = {};

        if (Array.isArray(rawItems)) {
            rawItems.forEach((item) => {
                const id = item && (item.id ?? item.item_id);
                if (id !== undefined && id !== null) map[id] = item;
            });
            return map;
        }

        if (rawItems && typeof rawItems === 'object') {
            Object.assign(map, rawItems);
        }

        return map;
    }

    function hasCatalogCache() {
        return itemCatalogCache && typeof itemCatalogCache === 'object' && Object.keys(itemCatalogCache).length > 0;
    }

    function isCatalogCacheFresh() {
        return hasCatalogCache() && (Date.now() - itemCatalogCacheTime) < API.itemCatalogTtlMs;
    }

    async function loadItemCatalog() {
        if (isCatalogCacheFresh()) {
            return { items: itemCatalogCache, error: null, usedCache: true };
        }

        const response = await requestJson(buildApiUrl('/torn/items'));
        if (response.error) {
            if (hasCatalogCache()) {
                return { items: itemCatalogCache, error: response.error.error || 'Catalog refresh failed', usedCache: true };
            }
            return { items: {}, error: response.error.error || 'Catalog refresh failed', usedCache: false };
        }

        itemCatalogCache = normalizeItemCatalog(response.items);
        itemCatalogCacheTime = Date.now();
        GM_setValue(STORAGE.itemCatalog, itemCatalogCache);
        GM_setValue(STORAGE.itemCatalogTime, itemCatalogCacheTime);

        return { items: itemCatalogCache, error: null, usedCache: false };
    }

    /*************************************************************************
     * 7) Listing Fetching
     *************************************************************************/

    function resolveItemId(listing) {
        // Confirmed Torn v2 shape: listing.id = listing id, listing.item.id = item id.
        if (listing && listing.item && listing.item.id !== undefined) return listing.item.id;
        if (listing && listing.item_id !== undefined) return listing.item_id;
        return undefined;
    }

    async function fetchAllListings(onProgress) {
        const listings = [];
        const seenListingIds = new Set();
        const seenPageFingerprints = new Set();
        let nextUrl = buildApiUrl('/user/itemmarket', { limit: API.pageSize });
        let offset = 0;
        let pagesFetched = 0;
        let warning = null;

        while (pagesFetched < API.maxPages) {
            const url = nextUrl || buildApiUrl('/user/itemmarket', { limit: API.pageSize, offset });
            const response = await requestJson(url);

            if (response.error) {
                const message = response.error.error || 'Pagination request failed';
                if (listings.length > 0) {
                    warning = message;
                    break;
                }
                return { listings: null, pagesFetched, warning: message };
            }

            const page = Array.isArray(response.itemmarket) ? response.itemmarket : [];
            const fingerprint = page.map(row => row && row.id).join('|');
            if (fingerprint && seenPageFingerprints.has(fingerprint)) {
                warning = 'Stopped because the API returned a duplicate page.';
                break;
            }
            seenPageFingerprints.add(fingerprint);

            page.forEach((row) => {
                const listingId = row && row.id;
                if (listingId === undefined || !seenListingIds.has(listingId)) {
                    listings.push(row);
                    if (listingId !== undefined) seenListingIds.add(listingId);
                }
            });

            pagesFetched += 1;
            if (typeof onProgress === 'function') onProgress(listings.length, pagesFetched);

            const apiNextUrl = getNextPageUrl(response);
            if (apiNextUrl) {
                nextUrl = apiNextUrl;
                await sleep(API.pageDelayMs);
                continue;
            }

            if (page.length < API.pageSize) break;

            offset += API.pageSize;
            nextUrl = buildApiUrl('/user/itemmarket', { limit: API.pageSize, offset });
            await sleep(API.pageDelayMs);
        }

        if (pagesFetched >= API.maxPages) {
            warning = `Stopped after ${(API.maxPages * API.pageSize).toLocaleString()} listing rows (safety cap reached).`;
        }

        return { listings, pagesFetched, warning };
    }

    /*************************************************************************
     * 8) Data Aggregation
     *************************************************************************/

    function aggregateListings(listings, itemCatalog) {
        const totals = {
            listed: 0,
            market: 0,
            buyback: 0,
            quantity: 0
        };
        const grouped = {};
        let rowsSkipped = 0;

        listings.forEach((listing) => {
            const itemId = resolveItemId(listing);
            if (itemId === undefined) {
                rowsSkipped += 1;
                return;
            }

            const catalogInfo = itemCatalog[itemId] || {};
            const quantity = Number(listing.amount) || 1;
            const listedTotal = Number(listing.price) || 0;
            const marketUnit = listing.average_price !== undefined && listing.average_price !== null
                ? Number(listing.average_price) || 0
                : Number(catalogInfo && catalogInfo.value && catalogInfo.value.market_price) || (quantity ? listedTotal / quantity : 0);
            const buybackUnit = Number(catalogInfo && catalogInfo.value && catalogInfo.value.sell_price) || 0;
            const itemName = (listing.item && listing.item.name) || catalogInfo.name || `Item #${itemId}`;

            if (!grouped[itemId]) {
                grouped[itemId] = {
                    name: itemName,
                    quantity: 0,
                    listed: 0,
                    market: 0,
                    buyback: 0
                };
            }

            const marketTotal = marketUnit * quantity;
            const buybackTotal = buybackUnit * quantity;

            grouped[itemId].quantity += quantity;
            grouped[itemId].listed += listedTotal;
            grouped[itemId].market += marketTotal;
            grouped[itemId].buyback += buybackTotal;

            totals.quantity += quantity;
            totals.listed += listedTotal;
            totals.market += marketTotal;
            totals.buyback += buybackTotal;
        });

        return {
            rows: Object.values(grouped).sort((a, b) => a.name.localeCompare(b.name)),
            totals,
            uniqueCount: Object.keys(grouped).length,
            rowsSkipped
        };
    }

    /*************************************************************************
     * 9) UI Helpers
     *************************************************************************/

    function findItemMarketHeader() {
        const knownHeader = document.querySelector('.title___Cd3XN');
        if (knownHeader) return knownHeader;

        const candidates = document.querySelectorAll('div, span, h1, h2, h3');
        for (const element of candidates) {
            if (element.children.length === 0 && element.textContent.trim() === 'Your items on the Item Market') {
                return element;
            }
        }
        return null;
    }

    function getToggleDisplayMode() {
        const toggle = $('tm-market-fixed-toggle');
        return toggle && toggle.classList.contains('tm-inline-toggle') ? 'inline-flex' : 'flex';
    }

    function setMainToggleVisible(visible) {
        const toggle = $('tm-market-fixed-toggle');
        if (!toggle) return;
        toggle.style.display = visible ? getToggleDisplayMode() : 'none';
    }

    function openOverlay() {
        const overlay = $('tm-summary-overlay');
        if (!overlay) return;
        setMainToggleVisible(false);
        overlay.style.display = 'flex';
        processMarketSummary();
    }

    function closeOverlay() {
        const checkbox = $('tm-toggle-checkbox');
        const overlay = $('tm-summary-overlay');
        if (checkbox) checkbox.checked = false;
        if (overlay) overlay.style.display = 'none';
        if (window.location.hash === ROUTE.itemMarketHash) setMainToggleVisible(true);
    }

    function setBodyHtml(html) {
        const body = $('tm-overlay-body');
        if (body) body.innerHTML = html;
    }

    /*************************************************************************
     * 10) UI Rendering
     *************************************************************************/

    function ensureElementsExist() {
        if ($('tm-market-fixed-toggle')) return;

        const toggleWrap = document.createElement('div');
        toggleWrap.id = 'tm-market-fixed-toggle';
        toggleWrap.innerHTML = `
            <label class="tm-switch">
                <input type="checkbox" id="tm-toggle-checkbox">
                <span class="tm-slider"></span>
            </label>
            <span>My Listings Summary</span><span class="tm-version">v${SCRIPT.version}</span>
        `;

        const header = findItemMarketHeader();
        if (header) {
            toggleWrap.classList.add('tm-inline-toggle');
            header.insertAdjacentElement('afterend', toggleWrap);
        } else {
            document.body.appendChild(toggleWrap);
        }

        const overlay = document.createElement('div');
        overlay.id = 'tm-summary-overlay';
        overlay.innerHTML = `
            <div class="tm-header">
                <span class="tm-header-title">
                    <span>${esc(SCRIPT.title)}</span>
                    <small>${esc(SCRIPT.subtitle)} · v${esc(SCRIPT.version)}</small>
                </span>
                <span class="tm-close" id="tm-close-overlay">×</span>
            </div>
            <div class="tm-body" id="tm-overlay-body">Initializing summary view...</div>
        `;
        document.body.appendChild(overlay);

        $('tm-toggle-checkbox').addEventListener('change', function () {
            if (this.checked) openOverlay();
            else closeOverlay();
        });
        $('tm-close-overlay').addEventListener('click', closeOverlay);
    }

    function renderKeyConfigForm() {
        setBodyHtml(`
            <div style="padding: 10px 0;">
                <p style="margin-bottom: 12px; line-height: 1.4; color: #9a6700;">
                    <strong>V2 API Notice:</strong> A Torn API key with the required Item Market access is needed.
                </p>
                <div style="display: flex; margin-bottom: 15px;">
                    <input type="password" id="tm-key-input" class="tm-input-field" placeholder="Paste Torn API Key" maxlength="16" autocomplete="off">
                    <button id="tm-save-key-btn" class="tm-btn">Save Key</button>
                </div>
                <p style="font-size: 11px; color: #888;">
                    The key is stored locally by your userscript manager and is only sent to api.torn.com.
                </p>
            </div>
        `);

        $('tm-save-key-btn').addEventListener('click', () => {
            const value = $('tm-key-input').value.trim();
            if (!isValidApiKey(value)) {
                alert('Please enter a valid 16-character Torn API key.');
                return;
            }
            apiKey = value;
            GM_setValue(STORAGE.apiKey, apiKey);
            processMarketSummary();
        });
    }

    function renderApiError(message, detail) {
        setBodyHtml(`
            <div class="tm-warning-notice">
                <strong>${esc(message)}</strong>
                ${detail ? `<br>${esc(detail)}` : ''}
            </div>
            <button id="tm-reset-key-btn" class="tm-btn">Change API Key</button>
        `);
        $('tm-reset-key-btn').addEventListener('click', () => {
            apiKey = '';
            renderKeyConfigForm();
        });
    }

    function renderProgress(listingCount, pageCount) {
        setBodyHtml(`<span style="color:#6b7280;">Fetched ${formatNumber(listingCount)} active listing row${listingCount === 1 ? '' : 's'} from ${formatNumber(pageCount)} API page${pageCount === 1 ? '' : 's'}...</span>`);
    }

    function renderSummary(aggregation, listings, pagesFetched, catalogResult, listingWarning) {
        const rowsHtml = aggregation.rows.map((item) => `
            <tr>
                <td><strong>${esc(item.name)}</strong> <span style="color:#777;">×${formatNumber(item.quantity)}</span></td>
                <td class="c-blue">${formatMoney(item.listed)}</td>
                <td class="c-orange">${formatMoney(item.market)}</td>
                <td class="c-green">${formatMoney(item.buyback)}</td>
            </tr>
        `).join('');

        const catalogNotice = catalogResult.usedCache
            ? `<div class="tm-cache-notice">Using 24-hour cached item catalog, last update: <strong>${esc(formatCacheDateTime(itemCatalogCacheTime))}</strong></div>`
            : `<div class="tm-cache-notice">Item catalog refreshed, last update: <strong>${esc(formatCacheDateTime(itemCatalogCacheTime))}</strong></div>`;

        const catalogWarning = catalogResult.error
            ? `<div class="tm-warning-notice">Item catalog refresh skipped/failed: ${esc(catalogResult.error)}. ${catalogResult.usedCache ? 'Using cached catalog.' : 'Showing listing data only; Torn buyback may be unavailable until the next successful catalog refresh.'}</div>`
            : '';

        const listingWarningHtml = listingWarning
            ? `<div class="tm-warning-notice">Warning: listing data may be incomplete (${esc(listingWarning)})</div>`
            : '';

        const skippedWarning = aggregation.rowsSkipped
            ? `<div class="tm-warning-notice">Skipped ${formatNumber(aggregation.rowsSkipped)} unrecognized listing row${aggregation.rowsSkipped === 1 ? '' : 's'}.</div>`
            : '';

        const debugBlock = `
            <details class="tm-debug-details">
                <summary>Debug: raw data (${formatNumber(listings.length)} listings, ${formatNumber(pagesFetched)} page${pagesFetched === 1 ? '' : 's'} fetched)</summary>
                <pre>${esc(JSON.stringify(listings.slice(0, 3), null, 2))}</pre>
            </details>
        `;

        setBodyHtml(`
            ${debugBlock}
            <div class="tm-metrics">
                <div class="tm-card">Sum Listed Items <span><b class="c-blue">${formatMoney(aggregation.totals.listed)}</b></span></div>
                <div class="tm-card">Sum Market Value <span><b class="c-orange">${formatMoney(aggregation.totals.market)}</b></span></div>
                <div class="tm-card">Sum Torn Buyback <span><b class="c-green">${formatMoney(aggregation.totals.buyback)}</b></span></div>
            </div>
            <p class="tm-muted-line">${formatNumber(aggregation.uniqueCount)} unique item${aggregation.uniqueCount === 1 ? '' : 's'} listed · ${formatNumber(aggregation.totals.quantity)} total quantity</p>
            ${catalogNotice}
            ${catalogWarning}
            ${listingWarningHtml}
            ${skippedWarning}
            <table class="tm-table">
                <thead>
                    <tr>
                        <th>Item Name</th>
                        <th>Sum Listed Items</th>
                        <th>Sum Market Value</th>
                        <th>Sum Torn Buyback</th>
                    </tr>
                </thead>
                <tbody>${rowsHtml}</tbody>
            </table>
        `);
    }

    /*************************************************************************
     * 11) Main Workflow
     *************************************************************************/

    async function processMarketSummary() {
        if (!isValidApiKey(apiKey)) {
            renderKeyConfigForm();
            return;
        }

        setBodyHtml('<span style="color:#6b7280;">Pulling Torn v2 Item Market data...</span>');

        const listingResult = await fetchAllListings(renderProgress);
        if (listingResult.listings === null) {
            renderApiError(
                `v2 API Error: ${listingResult.warning || 'Access Denied'}`,
                'Check that your Torn API key is valid and has the required access.'
            );
            return;
        }

        if (listingResult.listings.length === 0) {
            setBodyHtml('<p style="padding:10px 0;">No active Item Market listings found.</p>');
            return;
        }

        const firstResolvedId = resolveItemId(listingResult.listings[0]);
        if (firstResolvedId === undefined) {
            setBodyHtml(`
                <div class="tm-warning-notice">Could not identify the item field on listings. Copy this raw sample and send it back.</div>
                <pre style="background:#f8fafc;color:#374151;padding:10px;border-radius:6px;font-size:11px;overflow-x:auto;white-space:pre-wrap;word-break:break-all;">${esc(JSON.stringify(listingResult.listings[0], null, 2))}</pre>
            `);
            return;
        }

        const catalogResult = await loadItemCatalog();
        const aggregation = aggregateListings(listingResult.listings, catalogResult.items);
        renderSummary(aggregation, listingResult.listings, listingResult.pagesFetched, catalogResult, listingResult.warning);
    }

    /*************************************************************************
     * 12) Route Handling & Boot
     *************************************************************************/

    function monitorViewAndRoute() {
        if (window.location.hash === ROUTE.itemMarketHash) {
            ensureElementsExist();
            const overlayOpen = $('tm-summary-overlay') && $('tm-summary-overlay').style.display === 'flex';
            setMainToggleVisible(!overlayOpen);
            return;
        }

        const toggle = $('tm-market-fixed-toggle');
        const overlay = $('tm-summary-overlay');
        if (toggle) toggle.style.display = 'none';
        if (overlay) overlay.style.display = 'none';
        const checkbox = $('tm-toggle-checkbox');
        if (checkbox) checkbox.checked = false;
    }

    window.addEventListener('hashchange', monitorViewAndRoute);
    monitorViewAndRoute();
})();
