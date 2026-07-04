// ==UserScript==
// @name         Item Market Portfolio
// @namespace    https://github.com/CowboyUpp
// @version      2.9.4
// @description  Aggregates your active Item Market listings into an easy-to-read summary with listing totals, market values and buyback values.
// @author       cowboyup
// @match        https://www.torn.com/page.php?sid=ItemMarket*
// @grant        GM_setValue
// @grant        GM_getValue
// @grant        GM_addStyle
// @grant        GM_xmlhttpRequest
// @connect      api.torn.com
// @downloadURL https://update.greasyfork.org/scripts/585434/Item%20Market%20Portfolio.user.js
// @updateURL https://update.greasyfork.org/scripts/585434/Item%20Market%20Portfolio.meta.js
// ==/UserScript==

(function () {
    'use strict';

    /**************************************************************************
     * Item Market Portfolio
     * ------------------------------------------------------------------------
     * Sections:
     *  01. Constants
     *  02. Runtime State
     *  03. Styles
     *  04. Utilities
     *  05. API Helpers
     *  06. Local Cache
     *  07. Data Loading
     *  08. Portfolio Aggregation
     *  09. UI Rendering
     *  10. Event Wiring
     *  11. App Bootstrap
     **************************************************************************/

    /**************************************************************************
     * 01. Constants
     **************************************************************************/

    const SCRIPT_VERSION = '2.9.4';
    const TARGET_HASH = '#/viewListing';

    const STORAGE = {
        API_KEY: 'imp_api_key',
        LEGACY_API_KEY: 'torn_api_key',

        ITEMS_DB: 'imp_items_db_v2',
        ITEMS_DB_TIME: 'imp_items_db_time_v2',

        PORTFOLIO_DATA: 'imp_portfolio_data_v2',
        PORTFOLIO_TIME: 'imp_portfolio_time_v2'
    };

    const TTL = {
        ITEM_CATALOG_MS: 24 * 60 * 60 * 1000,
        PORTFOLIO_MS: 24 * 60 * 60 * 1000
    };

    const API = {
        BASE: 'https://api.torn.com/v2',
        PAGE_SIZE: 100,
        MAX_PAGES: 2000,
        PAGE_DELAY_MS: 750,
        MAX_RETRIES: 6,
        BACKOFF_START_MS: 2000,
        BACKOFF_MAX_MS: 30000
    };

    /**************************************************************************
     * 02. Runtime State
     **************************************************************************/

    let apiKey = GM_getValue(STORAGE.API_KEY, '') || GM_getValue(STORAGE.LEGACY_API_KEY, '');
    let itemsCache = GM_getValue(STORAGE.ITEMS_DB, null);
    let itemsCacheTime = Number(GM_getValue(STORAGE.ITEMS_DB_TIME, 0)) || 0;
    let portfolioCache = GM_getValue(STORAGE.PORTFOLIO_DATA, null);
    let portfolioCacheTime = Number(GM_getValue(STORAGE.PORTFOLIO_TIME, 0)) || 0;
    let isFetching = false;

    /**************************************************************************
     * 03. Styles
     **************************************************************************/

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

        #tm-market-fixed-toggle.tm-inline-toggle:hover {
            color: #222;
        }

        .tm-switch {
            position: relative;
            display: inline-block;
            width: 34px;
            height: 18px;
            margin-right: 8px;
        }

        .tm-switch input {
            opacity: 0;
            width: 0;
            height: 0;
        }

        .tm-slider {
            position: absolute;
            cursor: pointer;
            top: 0;
            left: 0;
            right: 0;
            bottom: 0;
            background-color: #ccc;
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

        input:checked + .tm-slider {
            background-color: #4e97d9;
        }

        input:checked + .tm-slider:before {
            transform: translateX(16px);
        }

        .tm-version {
            margin-left: 6px;
            font-size: 11px;
            color: #888;
            font-weight: normal;
        }

        #tm-summary-overlay {
            position: fixed;
            top: 120px;
            right: 15px;
            width: 500px;
            max-height: 80vh;
            background: #f7f8fa;
            border: 1px solid #cfd6df;
            border-radius: 8px;
            z-index: 2147483646;
            box-shadow: 0 10px 28px rgba(0,0,0,0.28);
            display: none;
            flex-direction: column;
            color: #333;
            font-family: Arial, Helvetica, sans-serif;
            overflow: hidden;
        }

        .tm-header {
            background: linear-gradient(#ffffff, #eceff3);
            padding: 11px 13px;
            font-weight: bold;
            border-bottom: 1px solid #cfd6df;
            display: flex;
            justify-content: space-between;
            align-items: center;
            color: #333;
        }

        .tm-header-title {
            display: flex;
            align-items: baseline;
            gap: 6px;
        }

        .tm-header-version {
            font-size: 11px;
            color: #888;
            font-weight: normal;
        }

        .tm-header-actions {
            display: flex;
            align-items: center;
            gap: 12px;
        }

        .tm-gear {
            cursor: pointer;
            color: #777;
            font-size: 16px;
            line-height: 1;
        }

        .tm-gear:hover {
            color: #2e78bf;
        }

        .tm-close {
            cursor: pointer;
            color: #777;
            font-size: 18px;
            font-weight: bold;
            line-height: 1;
        }

        .tm-close:hover {
            color: #b33;
        }

        .tm-body {
            padding: 12px;
            overflow-y: auto;
            flex-grow: 1;
        }

        .tm-toolbar {
            display: flex;
            align-items: center;
            justify-content: space-between;
            gap: 8px;
            margin-bottom: 10px;
        }

        .tm-cache-line,
        .tm-debug-row {
            margin: 8px 0 12px;
            padding: 8px 10px;
            border: 1px solid #d5dde7;
            background: #eef3f8;
            border-radius: 6px;
            color: #4b5a69;
            font-size: 12px;
            line-height: 1.35;
        }

        .tm-debug-row summary {
            cursor: pointer;
            color: #5c6c7c;
            font-size: 11px;
        }

        .tm-debug-row pre {
            background: #f8fafc;
            color: #364555;
            padding: 8px;
            border: 1px solid #d8e0ea;
            border-radius: 4px;
            font-size: 11px;
            overflow-x: auto;
            white-space: pre-wrap;
            word-break: break-all;
            margin-top: 6px;
        }

        .tm-metrics {
            display: grid;
            grid-template-columns: repeat(3, 1fr);
            gap: 8px;
            margin-bottom: 12px;
        }

        .tm-card {
            background: #fff;
            padding: 8px;
            border-radius: 6px;
            border: 1px solid #d6dde5;
            font-size: 11px;
            color: #666;
            box-shadow: 0 1px 2px rgba(0,0,0,0.04);
        }

        .tm-card span {
            display: block;
            font-size: 13px;
            font-weight: bold;
            margin-top: 4px;
        }

        .tm-table {
            width: 100%;
            border-collapse: collapse;
            font-size: 12px;
            text-align: left;
            background: #fff;
            border: 1px solid #d6dde5;
            border-radius: 6px;
            overflow: hidden;
        }

        .tm-table th,
        .tm-table td {
            padding: 8px 6px;
            border-bottom: 1px solid #e4e8ee;
        }

        .tm-table th {
            background: #f0f3f7;
            color: #596775;
            font-weight: 600;
        }

        .tm-table tr:last-child td {
            border-bottom: none;
        }

        .tm-muted {
            color: #777;
            font-size: 11px;
        }

        .c-blue { color: #2e78bf; }
        .c-green { color: #60902a; }
        .c-orange { color: #cf7d00; }

        .tm-input-field {
            background: #fff;
            color: #222;
            border: 1px solid #bfc8d2;
            padding: 6px;
            border-radius: 4px;
            width: 65%;
            margin-right: 5px;
        }

        .tm-btn {
            background: #4e97d9;
            color: #fff;
            border: 1px solid #357fbe;
            padding: 6px 12px;
            border-radius: 4px;
            cursor: pointer;
            font-weight: bold;
            font-size: 12px;
        }

        .tm-btn:hover {
            background: #367fbe;
        }

        .tm-btn-secondary {
            background: #f9fafc;
            color: #4b5a69;
            border: 1px solid #c7d0db;
        }

        .tm-btn-secondary:hover {
            background: #edf2f7;
        }

        .tm-btn:disabled {
            opacity: 0.6;
            cursor: default;
        }
    `);

    /**************************************************************************
     * 04. Utilities
     **************************************************************************/

    function esc(value) {
        return String(value).replace(/[&<>"']/g, (char) => ({
            '&': '&amp;',
            '<': '&lt;',
            '>': '&gt;',
            '"': '&quot;',
            "'": '&#39;'
        }[char]));
    }

    function sleep(ms) {
        return new Promise((resolve) => setTimeout(resolve, ms));
    }

    function isValidApiKey(value) {
        return /^[A-Za-z0-9]{16}$/.test(String(value || '').trim());
    }

    function maskKey(value) {
        const key = String(value || '');
        if (key.length < 4) return 'Not set';
        return '\u2022'.repeat(key.length - 4) + key.slice(-4);
    }

    function formatMoney(value) {
        const num = Number(value) || 0;
        return '$' + Math.floor(num).toString().replace(/\B(?=(\d{3})+(?!\d))/g, ',');
    }

    function formatDateTime(timestamp) {
        if (!timestamp) return 'unknown';
        try {
            return new Date(timestamp).toLocaleString();
        } catch (error) {
            return 'unknown';
        }
    }

    function cacheAgeText(timestamp) {
        if (!timestamp) return 'not cached';
        const diff = Math.max(0, Date.now() - timestamp);
        const mins = Math.floor(diff / 60000);
        if (mins < 1) return 'just now';
        if (mins < 60) return `${mins} min ago`;
        const hours = Math.floor(mins / 60);
        if (hours < 48) return `${hours} hour${hours === 1 ? '' : 's'} ago`;
        const days = Math.floor(hours / 24);
        return `${days} day${days === 1 ? '' : 's'} ago`;
    }

    function buildApiUrl(path, params = {}) {
        const url = new URL(API.BASE + path);
        Object.entries(params).forEach(([key, value]) => {
            if (value !== undefined && value !== null && value !== '') {
                url.searchParams.set(key, value);
            }
        });
        url.searchParams.set('key', apiKey);
        return url.toString();
    }

    function ensureApiKeyInNextUrl(nextUrl) {
        const url = new URL(nextUrl, API.BASE);
        url.searchParams.set('key', apiKey);
        return url.toString();
    }

    /**************************************************************************
     * 05. API Helpers
     **************************************************************************/

    function apiGet(url) {
        return new Promise((resolve) => {
            GM_xmlhttpRequest({
                method: 'GET',
                url,
                timeout: 20000,
                onload: (res) => {
                    try {
                        resolve(JSON.parse(res.responseText));
                    } catch (error) {
                        resolve({ error: { error: 'Payload parsing error' } });
                    }
                },
                onerror: () => resolve({ error: { error: 'Network request failed' } }),
                ontimeout: () => resolve({ error: { error: 'Request timed out' } })
            });
        });
    }


    function isRateLimitError(response) {
        const message = String(response?.error?.error || '').toLowerCase();
        const code = response?.error?.code;
        return code === 5
            || message.includes('too many requests')
            || message.includes('rate limit')
            || message.includes('too many');
    }

    async function apiGetWithBackoff(url, progressCallback, pageNumber) {
        let attempt = 0;
        let delay = API.BACKOFF_START_MS;

        while (attempt <= API.MAX_RETRIES) {
            const response = await apiGet(url);

            if (!response.error || !isRateLimitError(response)) {
                return response;
            }

            attempt += 1;

            if (attempt > API.MAX_RETRIES) {
                return response;
            }

            if (progressCallback) {
                progressCallback(`Rate limited on page ${pageNumber}. Waiting ${Math.round(delay / 1000)} seconds before retry ${attempt}/${API.MAX_RETRIES}...`);
            }

            await sleep(delay);
            delay = Math.min(delay * 2, API.BACKOFF_MAX_MS);
        }

        return { error: { error: 'Too many requests' } };
    }

    /**************************************************************************
     * 06. Local Cache
     **************************************************************************/

    function isFresh(timestamp, ttl) {
        return timestamp && (Date.now() - timestamp) < ttl;
    }

    function saveApiKey(value) {
        apiKey = value.trim();
        GM_setValue(STORAGE.API_KEY, apiKey);
        GM_setValue(STORAGE.LEGACY_API_KEY, apiKey);
    }

    function saveItemsCache(itemsDb) {
        itemsCache = itemsDb;
        itemsCacheTime = Date.now();
        GM_setValue(STORAGE.ITEMS_DB, itemsCache);
        GM_setValue(STORAGE.ITEMS_DB_TIME, itemsCacheTime);
    }

    function savePortfolioCache(portfolio) {
        portfolioCache = portfolio;
        portfolioCacheTime = Date.now();
        GM_setValue(STORAGE.PORTFOLIO_DATA, portfolioCache);
        GM_setValue(STORAGE.PORTFOLIO_TIME, portfolioCacheTime);
    }

    function clearPortfolioCache() {
        portfolioCache = null;
        portfolioCacheTime = 0;
        GM_setValue(STORAGE.PORTFOLIO_DATA, null);
        GM_setValue(STORAGE.PORTFOLIO_TIME, 0);
    }

    function clearItemsCache() {
        itemsCache = null;
        itemsCacheTime = 0;
        GM_setValue(STORAGE.ITEMS_DB, null);
        GM_setValue(STORAGE.ITEMS_DB_TIME, 0);
    }

    function clearStoredApiKey() {
        apiKey = '';
        GM_setValue(STORAGE.API_KEY, '');
        GM_setValue(STORAGE.LEGACY_API_KEY, '');
    }

    /**************************************************************************
     * 07. Data Loading
     **************************************************************************/

    function normalizeItemsDB(rawItems) {
        const map = {};

        if (Array.isArray(rawItems)) {
            rawItems.forEach((item) => {
                const id = item.id ?? item.item_id;
                if (id !== undefined && id !== null) {
                    map[id] = item;
                }
            });
            return map;
        }

        if (rawItems && typeof rawItems === 'object') {
            Object.assign(map, rawItems);
        }

        return map;
    }

    async function loadItemsDB(forceRefresh = false) {
        if (!forceRefresh && itemsCache && isFresh(itemsCacheTime, TTL.ITEM_CATALOG_MS)) {
            return {
                itemsDB: itemsCache,
                fromCache: true,
                error: null
            };
        }

        const res = await apiGetWithBackoff(buildApiUrl('/torn/items'), null, 'catalog');

        if (res.error) {
            if (itemsCache) {
                return {
                    itemsDB: itemsCache,
                    fromCache: true,
                    error: res.error.error || 'Could not refresh item catalog'
                };
            }

            return {
                itemsDB: {},
                fromCache: false,
                error: res.error.error || 'Could not load item catalog'
            };
        }

        const normalized = normalizeItemsDB(res.items);
        saveItemsCache(normalized);

        return {
            itemsDB: normalized,
            fromCache: false,
            error: null
        };
    }

    function getNextLink(response) {
        return response?._metadata?.links?.next
            || response?._metadata?.next
            || response?.metadata?.links?.next
            || response?.pagination?.next
            || null;
    }

    function extractListings(response) {
        if (Array.isArray(response?.itemmarket)) return response.itemmarket;
        if (Array.isArray(response?.items)) return response.items;
        if (Array.isArray(response?.data)) return response.data;
        return [];
    }

    async function fetchAllItemMarketListings(progressCallback) {
        const listings = [];
        const seenUrls = new Set();

        let page = 0;
        let offset = 0;
        let nextUrl = buildApiUrl('/user/itemmarket', {
            limit: API.PAGE_SIZE,
            offset
        });

        while (nextUrl && page < API.MAX_PAGES) {
            const safeNextUrl = ensureApiKeyInNextUrl(nextUrl);

            if (seenUrls.has(safeNextUrl)) {
                return {
                    listings,
                    warning: 'Stopped because Torn returned a duplicate next-page URL.',
                    pagesFetched: page
                };
            }

            seenUrls.add(safeNextUrl);
            page++;

            if (progressCallback) {
                progressCallback(`Fetching listings page ${page} — ${listings.length.toLocaleString()} listing rows loaded. Current delay: ${API.PAGE_DELAY_MS} ms...`);
            }

            const res = await apiGetWithBackoff(safeNextUrl, progressCallback, page);

            if (res.error) {
                if (listings.length > 0) {
                    return {
                        listings,
                        warning: res.error.error || 'Pagination request failed',
                        pagesFetched: page
                    };
                }

                throw new Error(res.error.error || 'Access denied');
            }

            const pageRows = extractListings(res);
            listings.push(...pageRows);

            const linkNext = getNextLink(res);
            if (linkNext) {
                nextUrl = linkNext;
            } else if (pageRows.length >= API.PAGE_SIZE) {
                offset += API.PAGE_SIZE;
                nextUrl = buildApiUrl('/user/itemmarket', {
                    limit: API.PAGE_SIZE,
                    offset
                });
            } else {
                nextUrl = null;
            }

            if (nextUrl) {
                await sleep(API.PAGE_DELAY_MS);
            }
        }

        const warning = page >= API.MAX_PAGES
            ? `Stopped after ${API.MAX_PAGES.toLocaleString()} pages as a safety limit.`
            : null;

        return {
            listings,
            warning,
            pagesFetched: page
        };
    }

    /**************************************************************************
     * 08. Portfolio Aggregation
     **************************************************************************/

    function resolveItemId(listing) {
        if (listing?.item?.id !== undefined && listing.item.id !== null) return listing.item.id;
        if (listing?.item_id !== undefined && listing.item_id !== null) return listing.item_id;
        return undefined;
    }

    function aggregatePortfolio(listings, itemsDB, meta = {}) {
        let sumListed = 0;
        let sumMarket = 0;
        let sumBuyback = 0;
        let totalQuantity = 0;

        const groupedItems = {};
        const rawSample = listings.slice(0, 3);

        listings.forEach((listing) => {
            const itemId = resolveItemId(listing);
            if (itemId === undefined) return;

            const info = itemsDB[itemId] || {};
            const quantity = Number(listing.amount || 1);
            const totalListed = Number(listing.price || 0);

            const perUnitMarketValue = listing.average_price !== undefined && listing.average_price !== null
                ? Number(listing.average_price)
                : (
                    info.value && info.value.market_price !== undefined && info.value.market_price !== null
                        ? Number(info.value.market_price)
                        : (quantity ? totalListed / quantity : 0)
                );

            const sellPrice = info.value && info.value.sell_price !== undefined
                ? Number(info.value.sell_price)
                : 0;

            const totalMarket = perUnitMarketValue * quantity;
            const totalBuyback = sellPrice * quantity;

            sumListed += totalListed;
            sumMarket += totalMarket;
            sumBuyback += totalBuyback;
            totalQuantity += quantity;

            const itemName = listing.item?.name || info.name || `Item #${itemId}`;

            if (!groupedItems[itemId]) {
                groupedItems[itemId] = {
                    id: itemId,
                    name: itemName,
                    quantity: 0,
                    totalListed: 0,
                    totalMarket: 0,
                    totalBuyback: 0
                };
            }

            groupedItems[itemId].quantity += quantity;
            groupedItems[itemId].totalListed += totalListed;
            groupedItems[itemId].totalMarket += totalMarket;
            groupedItems[itemId].totalBuyback += totalBuyback;
        });

        const rows = Object.values(groupedItems)
            .sort((a, b) => a.name.localeCompare(b.name));

        return {
            version: SCRIPT_VERSION,
            createdAt: Date.now(),
            rows,
            metrics: {
                sumListed,
                sumMarket,
                sumBuyback,
                totalQuantity,
                uniqueItemCount: rows.length,
                listingRows: listings.length
            },
            debug: {
                rawSample,
                pagesFetched: meta.pagesFetched || 0,
                warning: meta.warning || null
            },
            catalog: {
                timestamp: itemsCacheTime,
                fromCache: Boolean(meta.itemsFromCache),
                error: meta.itemsError || null
            }
        };
    }

    async function buildFreshPortfolio(progressCallback, forceCatalogRefresh = false) {
        const itemsResult = await loadItemsDB(forceCatalogRefresh);

        if (itemsResult.error && Object.keys(itemsResult.itemsDB).length === 0) {
            throw new Error(`Could not load item catalog: ${itemsResult.error}`);
        }

        const listingResult = await fetchAllItemMarketListings(progressCallback);

        const portfolio = aggregatePortfolio(listingResult.listings, itemsResult.itemsDB, {
            pagesFetched: listingResult.pagesFetched,
            warning: listingResult.warning,
            itemsFromCache: itemsResult.fromCache,
            itemsError: itemsResult.error
        });

        savePortfolioCache(portfolio);
        return portfolio;
    }

    /**************************************************************************
     * 09. UI Rendering
     **************************************************************************/

    function getBody() {
        return document.getElementById('tm-overlay-body');
    }

    function renderKeyConfigForm() {
        const body = getBody();

        body.innerHTML = `
            <div style="padding: 10px 0;">
                <p style="margin-bottom: 12px; line-height: 1.4; color: #a56500;">
                    <strong>V2 API Notice:</strong> A Full Access Torn API key is required to read your Item Market listings.
                </p>
                <div style="display: flex; margin-bottom: 15px;">
                    <input type="text" id="tm-key-input" class="tm-input-field" placeholder="Paste Full Access API Key" maxlength="16">
                    <button id="tm-save-key-btn" class="tm-btn">Save Key</button>
                </div>
                <p class="tm-muted">The key is stored locally in your browser and is only sent directly to Torn's official API.</p>
            </div>
        `;

        document.getElementById('tm-save-key-btn').addEventListener('click', () => {
            const value = document.getElementById('tm-key-input').value.trim();

            if (!isValidApiKey(value)) {
                alert('Please enter a valid 16-character Torn API key.');
                return;
            }

            saveApiKey(value);
            clearPortfolioCache();
            processMarketSummary({ forceRefresh: true });
        });
    }

    function renderApiError(message, detail = '') {
        const body = getBody();

        body.innerHTML = `
            <p style="color: #b33; margin-bottom: 10px;">${esc(message)}</p>
            ${detail ? `<p class="tm-muted" style="margin-bottom: 12px;">${esc(detail)}</p>` : ''}
            <button id="tm-reset-key-btn" class="tm-btn">Change API Key</button>
        `;

        document.getElementById('tm-reset-key-btn').addEventListener('click', () => {
            apiKey = '';
            clearPortfolioCache();
            renderKeyConfigForm();
        });
    }

    function renderLoading(message) {
        const body = getBody();
        body.innerHTML = `
            <div class="tm-cache-line">${esc(message)}</div>
        `;
    }

    function renderSettingsView() {
        const body = getBody();

        body.innerHTML = `
            <div class="tm-toolbar">
                <strong>API Settings</strong>
                <button id="tm-settings-back-btn" class="tm-btn tm-btn-secondary">&larr; Back</button>
            </div>

            <div class="tm-cache-line">
                Current key: <strong>${esc(maskKey(apiKey))}</strong><br>
                Item catalog cache: ${itemsCacheTime ? `${esc(formatDateTime(itemsCacheTime))} (${esc(cacheAgeText(itemsCacheTime))})` : 'not cached'}<br>
                Portfolio cache: ${portfolioCacheTime ? `${esc(formatDateTime(portfolioCacheTime))} (${esc(cacheAgeText(portfolioCacheTime))})` : 'not cached'}
            </div>

            <div style="margin-bottom: 14px;">
                <div style="display: flex; margin-bottom: 8px;">
                    <input type="text" id="tm-settings-key-input" class="tm-input-field" placeholder="Paste new Full Access API key" maxlength="16">
                    <button id="tm-settings-save-key-btn" class="tm-btn">Save New Key</button>
                </div>
                <p class="tm-muted">Saving a new key clears cached data and refreshes immediately.</p>
            </div>

            <div style="display: flex; flex-wrap: wrap; gap: 8px;">
                <button id="tm-settings-refresh-btn" class="tm-btn tm-btn-secondary">Force refresh now</button>
                <button id="tm-settings-clear-catalog-btn" class="tm-btn tm-btn-secondary">Clear item catalog cache</button>
                <button id="tm-settings-clear-portfolio-btn" class="tm-btn tm-btn-secondary">Clear portfolio cache</button>
                <button id="tm-settings-remove-key-btn" class="tm-btn tm-btn-secondary" style="color:#b33;border-color:#e3b3b3;">Remove saved API key</button>
            </div>
        `;

        document.getElementById('tm-settings-back-btn').addEventListener('click', () => {
            processMarketSummary({ forceRefresh: false });
        });

        document.getElementById('tm-settings-save-key-btn').addEventListener('click', () => {
            const value = document.getElementById('tm-settings-key-input').value.trim();

            if (!isValidApiKey(value)) {
                alert('Please enter a valid 16-character Torn API key.');
                return;
            }

            saveApiKey(value);
            clearItemsCache();
            clearPortfolioCache();
            processMarketSummary({ forceRefresh: true });
        });

        document.getElementById('tm-settings-refresh-btn').addEventListener('click', () => {
            processMarketSummary({ forceRefresh: true });
        });

        document.getElementById('tm-settings-clear-catalog-btn').addEventListener('click', () => {
            clearItemsCache();
            renderSettingsView();
        });

        document.getElementById('tm-settings-clear-portfolio-btn').addEventListener('click', () => {
            clearPortfolioCache();
            renderSettingsView();
        });

        document.getElementById('tm-settings-remove-key-btn').addEventListener('click', () => {
            if (!confirm('Remove the saved API key? You will need to re-enter it to use this panel again.')) return;
            clearStoredApiKey();
            clearItemsCache();
            clearPortfolioCache();
            renderKeyConfigForm();
        });
    }

    function renderPortfolio(portfolio, options = {}) {
        const body = getBody();
        const isCachedPortfolio = Boolean(options.fromCache);
        const metrics = portfolio.metrics || {};
        const debug = portfolio.debug || {};
        const catalog = portfolio.catalog || {};

        const rowsHtml = (portfolio.rows || []).map((item) => `
            <tr>
                <td><strong>${esc(item.name)}</strong> <span class="tm-muted">x${Number(item.quantity).toLocaleString()}</span></td>
                <td class="c-blue">${formatMoney(item.totalListed)}</td>
                <td class="c-orange">${formatMoney(item.totalMarket)}</td>
                <td class="c-green">${formatMoney(item.totalBuyback)}</td>
            </tr>
        `).join('');

        const cachedText = isCachedPortfolio
            ? `Using cached portfolio data, last refresh: ${formatDateTime(portfolio.createdAt)} (${cacheAgeText(portfolio.createdAt)}).`
            : `Fresh portfolio data loaded, last refresh: ${formatDateTime(portfolio.createdAt)}.`;

        const catalogText = `Using 24-hour cached item catalog, last update: ${formatDateTime(catalog.timestamp || itemsCacheTime)}.`;

        const warningHtml = debug.warning
            ? `<div class="tm-cache-line" style="border-color:#e4c27a;background:#fff7e5;color:#7a5700;">Warning: ${esc(debug.warning)}</div>`
            : '';

        const catalogErrorHtml = catalog.error
            ? `<div class="tm-cache-line" style="border-color:#e4c27a;background:#fff7e5;color:#7a5700;">Catalog refresh warning: ${esc(catalog.error)}</div>`
            : '';

        body.innerHTML = `
            <div class="tm-toolbar">
                <div class="tm-muted">${esc(cachedText)}</div>
                <button id="tm-manual-refresh-btn" class="tm-btn tm-btn-secondary">Refresh now</button>
            </div>

            <div class="tm-cache-line">${esc(catalogText)}</div>
            ${warningHtml}
            ${catalogErrorHtml}

            <details class="tm-debug-row">
                <summary>Debug: raw data (${Number(metrics.listingRows || 0).toLocaleString()} listing rows, ${Number(debug.pagesFetched || 0).toLocaleString()} page${debug.pagesFetched === 1 ? '' : 's'} fetched)</summary>
                <pre>${esc(JSON.stringify(debug.rawSample || [], null, 2))}</pre>
            </details>

            <div class="tm-metrics">
                <div class="tm-card">Sum Listed Items <span><b class="c-blue">${formatMoney(metrics.sumListed)}</b></span></div>
                <div class="tm-card">Sum Market Value <span><b class="c-orange">${formatMoney(metrics.sumMarket)}</b></span></div>
                <div class="tm-card">Sum Torn Buyback <span><b class="c-green">${formatMoney(metrics.sumBuyback)}</b></span></div>
            </div>

            <p class="tm-muted" style="margin: -4px 0 10px;">
                ${Number(metrics.uniqueItemCount || 0).toLocaleString()} unique item${metrics.uniqueItemCount === 1 ? '' : 's'} listed &middot;
                ${Number(metrics.totalQuantity || 0).toLocaleString()} total quantity
            </p>

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
        `;

        document.getElementById('tm-manual-refresh-btn').addEventListener('click', () => {
            processMarketSummary({ forceRefresh: true });
        });
    }

    /**************************************************************************
     * 10. Event Wiring
     **************************************************************************/

    function findItemMarketHeader() {
        const moduleHeader = document.querySelector('.title___Cd3XN');
        if (moduleHeader) return moduleHeader;

        const candidates = document.querySelectorAll('div, span, h1, h2, h3');
        for (const el of candidates) {
            if (el.children.length === 0 && el.textContent.trim() === 'Your items on the Item Market') {
                return el;
            }
        }

        return null;
    }

    function relocateToggleIntoHeader(toggleWrap) {
        const headerEl = findItemMarketHeader();
        if (!headerEl) return false;

        toggleWrap.classList.add('tm-inline-toggle');
        toggleWrap.style.display = '';
        headerEl.insertAdjacentElement('afterend', toggleWrap);
        return true;
    }

    function watchForHeaderAndRelocate(toggleWrap) {
        // Torn's SPA may not have rendered the header yet at the moment this
        // script runs. Rather than giving up after one look (which left the
        // toggle stuck in the fixed bottom-right fallback position), keep
        // watching the DOM until the header shows up, then move the toggle
        // into place.
        const observer = new MutationObserver(() => {
            if (relocateToggleIntoHeader(toggleWrap)) {
                observer.disconnect();
                monitorViewAndRoute();
            }
        });

        observer.observe(document.body, { childList: true, subtree: true });

        // Safety timeout: stop watching after 15s so this doesn't run
        // forever if the header never appears (e.g. Torn changed the page).
        setTimeout(() => observer.disconnect(), 15000);
    }

    function ensureElementsExist() {
        if (document.getElementById('tm-market-fixed-toggle')) return;

        const toggleWrap = document.createElement('div');
        toggleWrap.id = 'tm-market-fixed-toggle';
        toggleWrap.innerHTML = `
            <label class="tm-switch">
                <input type="checkbox" id="tm-toggle-checkbox">
                <span class="tm-slider"></span>
            </label>
            <span>My Listings Summary</span>
            <span class="tm-version">v${SCRIPT_VERSION}</span>
        `;

        const headerEl = findItemMarketHeader();
        if (headerEl) {
            toggleWrap.classList.add('tm-inline-toggle');
            headerEl.insertAdjacentElement('afterend', toggleWrap);
        } else {
            // Fall back to fixed positioning for now, but keep watching for
            // the header so the toggle can hop into place once it renders.
            document.body.appendChild(toggleWrap);
            watchForHeaderAndRelocate(toggleWrap);
        }

        const overlay = document.createElement('div');
        overlay.id = 'tm-summary-overlay';
        overlay.innerHTML = `
            <div class="tm-header">
                <div class="tm-header-title">
                    <span>Item Market Portfolio</span>
                    <span class="tm-header-version">v${SCRIPT_VERSION}</span>
                </div>
                <div class="tm-header-actions">
                    <span class="tm-gear" id="tm-settings-btn" title="API settings">&#9881;</span>
                    <span class="tm-close" id="tm-close-overlay">&times;</span>
                </div>
            </div>
            <div class="tm-body" id="tm-overlay-body">Initializing...</div>
        `;
        document.body.appendChild(overlay);

        const checkbox = document.getElementById('tm-toggle-checkbox');
        checkbox.addEventListener('change', function () {
            const displayOverlay = document.getElementById('tm-summary-overlay');
            const toggle = document.getElementById('tm-market-fixed-toggle');

            if (this.checked) {
                displayOverlay.style.display = 'flex';
                toggle.style.display = 'none';
                processMarketSummary({ forceRefresh: false });
            } else {
                displayOverlay.style.display = 'none';
                toggle.style.display = 'inline-flex';
            }
        });

        document.getElementById('tm-close-overlay').addEventListener('click', closeOverlay);
        document.getElementById('tm-settings-btn').addEventListener('click', renderSettingsView);
    }

    function closeOverlay() {
        const checkbox = document.getElementById('tm-toggle-checkbox');
        const overlay = document.getElementById('tm-summary-overlay');
        const toggle = document.getElementById('tm-market-fixed-toggle');

        if (checkbox) checkbox.checked = false;
        if (overlay) overlay.style.display = 'none';
        if (toggle && window.location.hash === TARGET_HASH) toggle.style.display = 'inline-flex';
    }

    function monitorViewAndRoute() {
        if (window.location.hash === TARGET_HASH) {
            ensureElementsExist();
            const toggle = document.getElementById('tm-market-fixed-toggle');
            const overlay = document.getElementById('tm-summary-overlay');
            const isOpen = overlay && overlay.style.display === 'flex';
            if (toggle) toggle.style.display = isOpen ? 'none' : 'inline-flex';
        } else {
            const toggle = document.getElementById('tm-market-fixed-toggle');
            const overlay = document.getElementById('tm-summary-overlay');
            const checkbox = document.getElementById('tm-toggle-checkbox');

            if (toggle) toggle.style.display = 'none';
            if (overlay) overlay.style.display = 'none';
            if (checkbox) checkbox.checked = false;
        }
    }

    /**************************************************************************
     * 11. App Bootstrap
     **************************************************************************/

    async function processMarketSummary(options = {}) {
        const forceRefresh = Boolean(options.forceRefresh);

        if (!isValidApiKey(apiKey)) {
            renderKeyConfigForm();
            return;
        }

        if (isFetching) {
            renderLoading('A refresh is already running. Please wait...');
            return;
        }

        const canUsePortfolioCache = !forceRefresh
            && portfolioCache
            && isFresh(portfolioCacheTime || portfolioCache.createdAt, TTL.PORTFOLIO_MS);

        if (canUsePortfolioCache) {
            renderPortfolio(portfolioCache, { fromCache: true });
            return;
        }

        try {
            isFetching = true;
            renderLoading(forceRefresh ? 'Manual refresh started...' : 'Refreshing portfolio data...');

            const portfolio = await buildFreshPortfolio((message) => {
                renderLoading(message);
            });

            renderPortfolio(portfolio, { fromCache: false });
        } catch (error) {
            renderApiError(error.message || 'Unable to load Item Market Portfolio.', 'Check your API key and Torn API availability.');
        } finally {
            isFetching = false;
        }
    }

    window.addEventListener('hashchange', monitorViewAndRoute);
    monitorViewAndRoute();

})();
