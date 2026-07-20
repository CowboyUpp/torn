// ==UserScript==
// @name         Torn City Map Finder
// @namespace    https://github.com/CowboyUpp/torn
// @version      1.2.6
// @description  Safety-first city item helper: map pins, floating item window, local history, optional Public API values, and no automated pickup.
// @author       CowboyUp
// @match        https://www.torn.com/city.php*
// @match        https://*.torn.com/city.php*
// @run-at       document-idle
// @license      MIT; https://opensource.org/licenses/MIT
// @grant        GM_getValue
// @grant        GM_setValue
// @grant        GM_xmlhttpRequest
// @grant        unsafeWindow
// @connect      api.torn.com
// @downloadURL https://update.greasyfork.org/scripts/583629/Torn%20City%20Map%20Finder.user.js
// @updateURL https://update.greasyfork.org/scripts/583629/Torn%20City%20Map%20Finder.meta.js
// ==/UserScript==

(function () {
    'use strict';

    const VERSION = '1.2.6';
    const STORE_PREFIX = 'tcfs_';
    const POLL_MS = 1800;
    const REVEAL_MS = 10000;
    const PICKUP_ZOOM = 6;
    const METADATA_CACHE_MAX_AGE_MS = 12 * 60 * 60 * 1000;
    const METADATA_RETRY_MS = 5 * 60 * 1000;
    const HISTORY_SAVE_INTERVAL_MS = 30 * 1000;
    const EMPTY_SCAN_CONFIRMATIONS = 2;
    const DRAG_THRESHOLD_PX = 7;

    const DEFAULT_SETTINGS = {
        fabX: null,
        fabY: null,
        panelOpen: false,
        tab: 'active',
        sort: 'date',
        search: '',
        theme: 'light',
        showImages: false,
        apiEnabled: false,
        apiKey: '',
        historyLimit: 500
    };

    const STORE = {
        get(key, fallback) {
            try {
                if (typeof GM_getValue === 'function') {
                    const value = GM_getValue(STORE_PREFIX + key, undefined);
                    if (value !== undefined) return value;
                }
            } catch (_) {}

            try {
                const raw = localStorage.getItem(STORE_PREFIX + key);
                if (raw !== null) return JSON.parse(raw);
            } catch (_) {}

            return fallback;
        },
        set(key, value) {
            let storedPrivately = false;
            try {
                if (typeof GM_setValue === 'function') {
                    GM_setValue(STORE_PREFIX + key, value);
                    storedPrivately = true;
                }
            } catch (_) {}

            if (storedPrivately) {
                // Migrate away from the old page-accessible fallback. This is
                // especially important for settings because they may contain an API key.
                try {
                    localStorage.removeItem(STORE_PREFIX + key);
                } catch (_) {}
                return;
            }

            try {
                localStorage.setItem(STORE_PREFIX + key, JSON.stringify(value));
            } catch (_) {}
        }
    };

    let settings = Object.assign({}, DEFAULT_SETTINGS, STORE.get('settings', {}));
    settings.theme = settings.theme === 'dark' ? 'dark' : 'light';
    settings.tab = settings.tab === 'history' ? 'history' : 'active';
    settings.showImages = Boolean(settings.showImages);
    let historyMap = readHistory();
    let itemMeta = STORE.get('itemMeta', {});
    let itemMetaFetchedAt = Number(STORE.get('itemMetaFetchedAt', 0)) || 0;
    let metaStatus = itemMetaFetchedAt ? 'Cached' : 'Off';
    let activeItems = [];
    let markers = {};
    let selectedKey = null;
    let syncTimer = null;
    let revealTimer = null;
    let busyMeta = false;
    let nextMetadataAttemptAt = 0;
    let lastHistorySaveAt = 0;
    let consecutiveEmptyScans = 0;
    let lastRenderedItemSignature = '';
    let markerMap = null;

    let fab = null;
    let badge = null;
    let panel = null;
    let listEl = null;
    let detailEl = null;
    let settingsEl = null;
    let toastTimer = null;
    let newFindPulseTimer = null;

    function saveSettings() {
        STORE.set('settings', settings);
    }

    function readHistory() {
        const raw = STORE.get('history', {});
        return raw && typeof raw === 'object' && !Array.isArray(raw) ? raw : {};
    }

    function saveHistory() {
        trimHistory();
        STORE.set('history', historyMap);
        lastHistorySaveAt = Date.now();
    }

    function pageWindow() {
        try {
            if (typeof unsafeWindow !== 'undefined' && unsafeWindow) return unsafeWindow;
        } catch (_) {}
        return window;
    }

    function getTorn() {
        const w = pageWindow();
        return w && w.torn ? w.torn : null;
    }

    function getLeaflet() {
        const w = pageWindow();
        return w && w.L ? w.L : null;
    }

    function tornReady() {
        const torn = getTorn();
        const L = getLeaflet();
        return Boolean(
            torn &&
            L &&
            torn.map &&
            torn.map.lmap &&
            torn.model &&
            typeof torn.model.get === 'function' &&
            typeof torn.map.getLPoint === 'function'
        );
    }

    function escapeHtml(value) {
        return String(value == null ? '' : value).replace(/[&<>"']/g, (ch) => ({
            '&': '&amp;',
            '<': '&lt;',
            '>': '&gt;',
            '"': '&quot;',
            "'": '&#39;'
        }[ch]));
    }

    function escapeAttr(value) {
        return escapeHtml(value).replace(/`/g, '&#96;');
    }

    function cleanText(value) {
        return String(value == null ? '' : value).replace(/\s+/g, ' ').trim();
    }

    function firstDefined(obj, keys) {
        for (const key of keys) {
            if (obj && obj[key] !== undefined && obj[key] !== null) return obj[key];
        }
        return undefined;
    }

    function asNumber(value, base) {
        if (typeof value === 'number' && Number.isFinite(value)) return Math.trunc(value);
        const text = cleanText(value);
        if (!text) return null;
        const parsed = parseInt(text, base || 10);
        return Number.isFinite(parsed) ? parsed : null;
    }

    function asCoord(value) {
        if (typeof value === 'number' && Number.isFinite(value)) return value;
        const text = cleanText(value);
        if (!text) return null;
        if (/^-?\d+(?:\.\d+)?$/.test(text)) return Number(text);
        const parsed = parseInt(text, 36);
        return Number.isFinite(parsed) ? parsed : null;
    }

    function parseItem(raw) {
        if (!raw || typeof raw !== 'object') return null;

        let x;
        let y;
        if (Array.isArray(raw.coordinates)) {
            x = raw.coordinates[0];
            y = raw.coordinates[1];
        } else if (raw.c && typeof raw.c === 'object') {
            x = raw.c.x;
            y = raw.c.y;
        } else {
            x = raw.x;
            y = raw.y;
        }

        const cx = asCoord(x);
        const cy = asCoord(y);
        if (!Number.isFinite(cx) || !Number.isFinite(cy)) return null;

        const itemIdRaw = firstDefined(raw, ['item_id', 'itemID', 'itemId', 'item', 'ID']);
        const itemId = asNumber(itemIdRaw, 10) || asNumber(raw.d, 36);
        const rowRaw = firstDefined(raw, ['row_id', 'rowID', 'rowId', 'id']);
        const rowId = rowRaw === undefined ? '' : String(rowRaw);
        const title = cleanText(raw.title || raw.name || (itemId ? 'Item #' + itemId : 'City item'));
        const key = [rowId || 'row?', itemId || title, Math.round(cx), Math.round(cy)].join('|');

        return {
            key,
            rowId,
            itemId,
            title,
            x: cx,
            y: cy,
            category: cleanText(raw.type || raw.category || ''),
            raw
        };
    }

    function getPageItems() {
        if (!tornReady()) return [];

        let rawItems = [];
        try {
            rawItems = getTorn().model.get('territoryUserItems') || [];
        } catch (_) {
            rawItems = [];
        }

        if (typeof rawItems === 'string') {
            try {
                rawItems = JSON.parse(rawItems);
            } catch (_) {
                rawItems = [];
            }
        }

        if (!Array.isArray(rawItems) && rawItems && typeof rawItems === 'object') {
            rawItems = Object.values(rawItems);
        }

        return (Array.isArray(rawItems) ? rawItems : [])
            .map(parseItem)
            .filter(Boolean);
    }

    function metadataFor(itemId) {
        if (!itemId) return {};
        return itemMeta[String(itemId)] || {};
    }

    function enrichItem(item) {
        const meta = metadataFor(item.itemId);
        return Object.assign({}, item, {
            category: item.category || meta.category || 'Unknown',
            value: typeof meta.value === 'number' ? meta.value : null
        });
    }

    function getRecordValue(record) {
        if (!record) return null;
        if (typeof record.value === 'number' && Number.isFinite(record.value)) return record.value;
        const meta = metadataFor(record.itemId);
        return typeof meta.value === 'number' && Number.isFinite(meta.value) ? meta.value : null;
    }

    function getRecordCategory(record) {
        if (!record) return 'Unknown';
        if (record.category && record.category !== 'Unknown') return record.category;
        const meta = metadataFor(record.itemId);
        return meta.category || 'Unknown';
    }

    function formatMoney(value) {
        if (typeof value !== 'number' || !Number.isFinite(value)) return 'Value off';
        try {
            return '$' + Math.round(value).toLocaleString('en-US');
        } catch (_) {
            return '$' + Math.round(value);
        }
    }

    function formatTime(timestamp) {
        if (!timestamp) return '-';
        try {
            return new Date(timestamp).toLocaleString();
        } catch (_) {
            return '-';
        }
    }

    function formatShortTime(timestamp) {
        if (!timestamp) return '-';
        try {
            return new Date(timestamp).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
        } catch (_) {
            return '-';
        }
    }

    function makeRecord(item, now) {
        const enriched = enrichItem(item);
        return {
            key: item.key,
            rowId: item.rowId,
            itemId: item.itemId,
            title: item.title,
            category: enriched.category,
            value: enriched.value,
            x: item.x,
            y: item.y,
            foundAt: now,
            lastSeenAt: now,
            goneAt: null,
            pickedAt: null,
            status: 'active'
        };
    }

    function updateHistory(items, allowGoneTransitions) {
        const now = Date.now();
        const activeKeys = new Set(items.map((item) => item.key));
        let dirty = false;
        let persistImmediately = false;
        let newCount = 0;

        items.forEach((item) => {
            const enriched = enrichItem(item);
            const existing = historyMap[item.key];

            if (!existing) {
                historyMap[item.key] = makeRecord(item, now);
                dirty = true;
                persistImmediately = true;
                newCount++;
                return;
            }

            const next = Object.assign({}, existing, {
                rowId: item.rowId || existing.rowId,
                itemId: item.itemId || existing.itemId,
                title: item.title || existing.title,
                category: enriched.category || existing.category || 'Unknown',
                value: enriched.value == null ? existing.value : enriched.value,
                x: item.x,
                y: item.y,
                lastSeenAt: now
            });

            if (existing.status !== 'picked') {
                next.status = 'active';
                next.goneAt = null;
            }

            historyMap[item.key] = next;
            dirty = true;
            if (existing.status !== next.status ||
                existing.rowId !== next.rowId ||
                existing.itemId !== next.itemId ||
                existing.title !== next.title ||
                existing.category !== next.category ||
                existing.value !== next.value ||
                existing.x !== next.x ||
                existing.y !== next.y) {
                persistImmediately = true;
            }
        });

        if (allowGoneTransitions) {
            Object.keys(historyMap).forEach((key) => {
                const record = historyMap[key];
                if (record.status === 'active' && !activeKeys.has(key)) {
                    record.status = 'gone';
                    record.goneAt = now;
                    dirty = true;
                    persistImmediately = true;
                }
            });
        }

        if (dirty && (persistImmediately || now - lastHistorySaveAt >= HISTORY_SAVE_INTERVAL_MS)) {
            saveHistory();
        }

        return newCount;
    }

    function trimHistory() {
        const limit = Math.max(50, Number(settings.historyLimit) || DEFAULT_SETTINGS.historyLimit);
        const records = Object.values(historyMap)
            .sort((a, b) => Number(b.foundAt || 0) - Number(a.foundAt || 0));

        records.slice(limit).forEach((record) => {
            delete historyMap[record.key];
        });
    }

    function visibleActiveItems() {
        return activeItems.filter((item) => {
            const record = historyMap[item.key];
            return !record || record.status !== 'picked';
        });
    }

    function markerSignature() {
        return JSON.stringify({
            selectedKey,
            showImages: settings.showImages,
            items: activeItems.map((item) => {
                const record = historyMap[item.key];
                return [item.key, item.itemId, item.title, item.x, item.y, record ? record.status : 'active'];
            })
        });
    }

    function getLatLng(itemOrRecord) {
        if (!itemOrRecord || !tornReady()) return null;
        const torn = getTorn();
        const L = getLeaflet();

        try {
            const point = [Number(itemOrRecord.x) / 2, Number(itemOrRecord.y) / 2];
            const lpoint = torn.map.getLPoint(point);
            return L.CRS.EPSG3857.pointToLatLng(lpoint, torn.map.minZoom);
        } catch (_) {
            return null;
        }
    }

    function injectStyles() {
        if (document.getElementById('tcfs-styles')) return;

        const css = `
            #tcfs-fab {
                position: fixed;
                z-index: 2147483000;
                width: 46px;
                height: 46px;
                display: flex;
                align-items: center;
                gap: 0;
                padding: 0 13px;
                overflow: visible;
                border: 1px solid #505050;
                border-radius: 12px;
                background: linear-gradient(180deg, #3a3a3a 0%, #303030 48%, #272727 100%);
                color: #d7d7d7;
                box-shadow:
                    inset 0 1px rgba(255,255,255,.09),
                    inset 0 -1px rgba(0,0,0,.4),
                    0 5px 16px rgba(0,0,0,.42);
                cursor: pointer;
                user-select: none;
                touch-action: none;
                font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, Arial, sans-serif;
                transition: width .2s ease, background .15s ease, border-color .15s ease,
                            transform .2s ease, box-shadow .18s ease;
            }

            #tcfs-fab::before {
                content: "";
                position: absolute;
                left: -1px;
                top: 9px;
                width: 3px;
                height: 26px;
                border-radius: 0 3px 3px 0;
                background: #c84a4a;
                opacity: 0;
                transform: scaleY(.55);
                transition: opacity .15s ease, transform .18s ease;
            }

            #tcfs-fab:hover,
            #tcfs-fab:focus-visible,
            #tcfs-fab.tcfs-open {
                width: 132px;
                gap: 9px;
                border-color: #606060;
                background: linear-gradient(180deg, #424242 0%, #363636 48%, #2c2c2c 100%);
            }

            #tcfs-fab.tcfs-expand-left {
                flex-direction: row-reverse;
            }

            #tcfs-fab.tcfs-expand-left:hover,
            #tcfs-fab.tcfs-expand-left:focus-visible,
            #tcfs-fab.tcfs-expand-left.tcfs-open {
                transform: translateX(-86px);
            }

            #tcfs-fab.tcfs-open::before,
            #tcfs-fab.tcfs-has-items::before {
                opacity: 1;
                transform: scaleY(1);
            }

            #tcfs-fab.tcfs-has-items {
                border-color: rgba(200,74,74,.8);
                box-shadow:
                    inset 0 1px rgba(255,255,255,.09),
                    inset 0 -1px rgba(0,0,0,.4),
                    0 5px 16px rgba(0,0,0,.42),
                    0 0 0 1px rgba(200,74,74,.16),
                    0 0 14px rgba(200,74,74,.18);
            }

            #tcfs-fab:active,
            #tcfs-fab.tcfs-dragging {
                transform: translateY(1px);
            }

            #tcfs-fab.tcfs-dragging {
                cursor: grabbing;
                transition: none;
            }

            #tcfs-fab.tcfs-expand-left:hover:active,
            #tcfs-fab.tcfs-expand-left.tcfs-dragging {
                transform: translate(-86px, 1px);
            }

            #tcfs-fab .cfc-icon {
                width: 20px;
                height: 20px;
                flex: 0 0 20px;
                display: flex;
                align-items: center;
                justify-content: center;
                color: #e2e2e2;
            }

            #tcfs-fab .cfc-icon svg {
                width: 20px;
                height: 20px;
                display: block;
            }

            #tcfs-fab .cfc-label {
                width: 0;
                overflow: hidden;
                opacity: 0;
                white-space: nowrap;
                color: #ededed;
                font-size: 13px;
                font-weight: 700;
                letter-spacing: .1px;
                text-align: left;
                transition: width .2s ease, opacity .12s ease .03s;
            }

            #tcfs-fab:hover .cfc-label,
            #tcfs-fab:focus-visible .cfc-label,
            #tcfs-fab.tcfs-open .cfc-label {
                width: 72px;
                opacity: 1;
            }

            #tcfs-fab.tcfs-dragging,
            #tcfs-fab.tcfs-expand-left.tcfs-dragging {
                width: 46px;
                gap: 0;
                transform: translateY(1px);
            }

            #tcfs-fab.tcfs-dragging .cfc-label {
                width: 0;
                opacity: 0;
            }

            #tcfs-fab .tcfs-badge {
                position: absolute;
                top: -6px;
                right: -6px;
                min-width: 19px;
                height: 19px;
                box-sizing: border-box;
                display: none;
                align-items: center;
                justify-content: center;
                padding: 0 5px;
                border: 2px solid #272727;
                border-radius: 999px;
                background: #c84a4a;
                color: #fff;
                box-shadow: 0 2px 7px rgba(0,0,0,.45);
                font-size: 11px;
                font-weight: 800;
                line-height: 1;
            }
            #tcfs-panel {
                position: fixed;
                width: 380px;
                max-width: calc(100vw - 20px);
                max-height: min(76vh, 620px);
                z-index: 2147483001;
                display: none;
                flex-direction: column;
                overflow: hidden;
                border-radius: 8px;
                border: 1px solid rgba(246,221,164,.22);
                background: rgba(23,20,18,.96);
                color: #f5efe3;
                box-shadow: 0 18px 54px rgba(0,0,0,.58);
                font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, Arial, sans-serif;
            }
            #tcfs-panel.tcfs-open { display: flex; }
            .tcfs-head {
                display: flex;
                align-items: center;
                gap: 8px;
                padding: 10px 12px;
                border-bottom: 1px solid rgba(255,255,255,.09);
                background: linear-gradient(90deg, rgba(217,182,90,.13), rgba(77,184,168,.08));
            }
            .tcfs-title {
                min-width: 0;
                flex: 1;
                font-size: 14px;
                font-weight: 800;
            }
            .tcfs-title span {
                margin-left: 5px;
                color: rgba(245,239,227,.58);
                font-size: 11px;
                font-weight: 600;
            }
            .tcfs-iconbtn,
            .tcfs-smallbtn,
            .tcfs-row button,
            .tcfs-detail-actions button {
                min-height: 30px;
                border: 1px solid rgba(255,255,255,.12);
                border-radius: 6px;
                background: rgba(255,255,255,.065);
                color: #f5efe3;
                cursor: pointer;
                font-weight: 700;
            }
            .tcfs-iconbtn {
                width: 32px;
                height: 32px;
                display: inline-flex;
                align-items: center;
                justify-content: center;
                font-size: 15px;
            }
            .tcfs-iconbtn:hover,
            .tcfs-smallbtn:hover,
            .tcfs-row button:hover,
            .tcfs-detail-actions button:hover {
                background: rgba(255,255,255,.13);
            }
            .tcfs-tabs,
            .tcfs-tools {
                display: flex;
                align-items: center;
                gap: 8px;
                padding: 9px 12px;
                border-bottom: 1px solid rgba(255,255,255,.08);
            }
            .tcfs-tabs button {
                flex: 1;
                padding: 8px 10px;
                border-radius: 6px;
                border: 1px solid rgba(255,255,255,.11);
                background: rgba(255,255,255,.045);
                color: rgba(245,239,227,.78);
                cursor: pointer;
                font-weight: 800;
            }
            .tcfs-tabs button.tcfs-active {
                border-color: rgba(77,184,168,.72);
                background: rgba(77,184,168,.16);
                color: #ffffff;
            }
            .tcfs-tools input,
            .tcfs-tools select,
            .tcfs-settings input,
            .tcfs-settings select {
                min-width: 0;
                height: 32px;
                box-sizing: border-box;
                border-radius: 6px;
                border: 1px solid rgba(255,255,255,.13);
                background: rgba(255,255,255,.07);
                color: #f5efe3;
                outline: none;
            }
            .tcfs-tools input { flex: 1; padding: 0 9px; }
            .tcfs-tools select{
                width:116px;

                padding:0 10px;

                background:#2b2b2b;

                color:#ffffff;

                border:1px solid #5b5b5b;

                font-weight:600;

                appearance:auto;
            }

            .tcfs-tools select option{
                background:#2d2d2d;
                color:#ffffff;
                font-weight:600;
            }

            .tcfs-settings select{
                background:#2b2b2b;
                color:#ffffff;
                border:1px solid #5b5b5b;
            }

            .tcfs-settings select option{
                background:#2d2d2d;
                color:#ffffff;
            }
            .tcfs-summary {
                display: flex;
                align-items: center;
                gap: 7px;
                padding: 8px 12px;
                border-bottom: 1px solid rgba(255,255,255,.08);
                color: rgba(245,239,227,.72);
                font-size: 12px;
            }
            .tcfs-pill {
                display: inline-flex;
                align-items: center;
                min-height: 22px;
                padding: 2px 7px;
                border-radius: 999px;
                background: rgba(217,182,90,.12);
                color: #ffe1a0;
                font-weight: 800;
            }
            .tcfs-pill.tcfs-teal {
                background: rgba(77,184,168,.13);
                color: #9be5dc;
            }
            .tcfs-detail {
                display: none;
                padding: 10px 12px;
                border-bottom: 1px solid rgba(255,255,255,.08);
                background: rgba(255,255,255,.035);
            }
            .tcfs-detail.tcfs-open {
                display: grid;
                grid-template-columns: 42px minmax(0, 1fr);
                gap: 10px;
                align-items: center;
            }
            .tcfs-detail-name {
                font-size: 14px;
                font-weight: 850;
                overflow: hidden;
                text-overflow: ellipsis;
                white-space: nowrap;
            }
            .tcfs-detail-meta {
                margin-top: 3px;
                color: rgba(245,239,227,.65);
                font-size: 11px;
            }
            .tcfs-detail-actions {
                grid-column: 1 / -1;
                display: grid;
                grid-template-columns: repeat(3, minmax(0, 1fr));
                gap: 8px;
            }
            .tcfs-list {
                overflow: auto;
                padding: 8px;
                -webkit-overflow-scrolling: touch;
            }
            .tcfs-row {
                display: grid;
                grid-template-columns: 42px minmax(0, 1fr);
                gap: 10px;
                align-items: center;
                padding: 8px;
                margin-bottom: 7px;
                border-radius: 8px;
                border: 1px solid rgba(255,255,255,.075);
                background: rgba(255,255,255,.045);
            }
            .tcfs-row.tcfs-selected {
                border-color: rgba(77,184,168,.72);
                background: rgba(77,184,168,.105);
            }
            .tcfs-row-main {
                min-width: 0;
            }
            .tcfs-row-name {
                font-size: 13px;
                font-weight: 800;
                overflow: hidden;
                text-overflow: ellipsis;
                white-space: nowrap;
            }
            .tcfs-row-meta {
                display: flex;
                flex-wrap: wrap;
                gap: 5px;
                margin-top: 4px;
                color: rgba(245,239,227,.63);
                font-size: 11px;
            }
            .tcfs-actions {
                grid-column: 1 / -1;
                display: grid;
                grid-template-columns: repeat(3, minmax(0, 1fr));
                gap: 7px;
            }
            .tcfs-actions button,
            .tcfs-detail-actions button {
                padding: 6px 7px;
                font-size: 12px;
            }
            .tcfs-actions [data-action="reveal"],
            .tcfs-detail-actions [data-action="reveal"] {
                background: rgba(77,184,168,.18);
                border-color: rgba(77,184,168,.5);
            }
            .tcfs-token,
            .tcfs-row img,
            .tcfs-detail img {
                width: 38px;
                height: 38px;
                border-radius: 8px;
                object-fit: contain;
                background: linear-gradient(145deg, rgba(217,182,90,.22), rgba(77,184,168,.18));
                border: 1px solid rgba(255,255,255,.12);
            }
            .tcfs-token {
                display: flex;
                align-items: center;
                justify-content: center;
                color: #fff0bd;
                font: 850 13px/1 Arial, sans-serif;
                text-transform: uppercase;
            }
            .tcfs-empty {
                padding: 34px 14px;
                text-align: center;
                color: rgba(245,239,227,.58);
                font-size: 13px;
            }
            .tcfs-settings {
                display: none;
                padding: 10px 12px;
                border-bottom: 1px solid rgba(255,255,255,.08);
                background: rgba(0,0,0,.16);
            }
            .tcfs-settings.tcfs-open { display: block; }
            .tcfs-setting-row {
                display: flex;
                align-items: center;
                gap: 8px;
                margin-bottom: 8px;
                font-size: 12px;
            }
            .tcfs-setting-row label {
                display: flex;
                align-items: center;
                gap: 7px;
                flex: 1;
            }
            .tcfs-settings input[type="password"] {
                flex: 1;
                padding: 0 8px;
            }
            .tcfs-settings input[type="checkbox"] {
                width: 16px;
                height: 16px;
            }
            .tcfs-setting-note {
                margin: 5px 0 9px;
                color: rgba(245,239,227,.57);
                font-size: 11px;
                line-height: 1.35;
            }
            .tcfs-smallbtn {
                padding: 5px 9px;
                font-size: 11px;
                white-space: nowrap;
            }
            .tcfs-map-icon {
                background: transparent !important;
                border: 0 !important;
                overflow: visible !important;
            }
            .tcfs-map-pin {
                position: relative;
                width: 72px;
                height: 64px;
                transform: translate(-50%, -100%);
                cursor: pointer;
                pointer-events: auto;
            }
            .tcfs-map-label {
                position: absolute;
                left: 50%;
                top: 0;
                max-width: 92px;
                transform: translateX(-50%);
                padding: 2px 6px;
                border-radius: 6px;
                border: 1px solid rgba(255,226,152,.8);
                background: rgba(23,20,18,.88);
                color: #ffe1a0;
                font: 800 10px/1.2 Arial, sans-serif;
                white-space: nowrap;
                overflow: hidden;
                text-overflow: ellipsis;
                box-shadow: 0 3px 9px rgba(0,0,0,.34);
                pointer-events: none;
            }
            .tcfs-map-dot {
                position: absolute;
                left: 50%;
                top: 20px;
                width: 36px;
                height: 36px;
                transform: translateX(-50%);
                border-radius: 50%;
                border: 3px solid rgba(255,255,255,.9);
                background: radial-gradient(circle at 35% 25%, #d9b65a, #4db8a8 68%, #171412);
                box-shadow: 0 3px 11px rgba(0,0,0,.46), 0 0 0 2px rgba(217,182,90,.16);
                display: flex;
                align-items: center;
                justify-content: center;
                color: #fff;
                font: 850 11px/1 Arial, sans-serif;
                overflow: hidden;
                pointer-events: none;
            }
            .tcfs-map-dot img {
                width: 34px;
                height: 34px;
                object-fit: contain;
                transform: scale(.78);
                pointer-events: none;
            }
            .tcfs-map-tail {
                position: absolute;
                left: 50%;
                top: 52px;
                width: 10px;
                height: 10px;
                background: rgba(255,255,255,.88);
                transform: translateX(-50%) rotate(45deg);
                border-right: 2px solid rgba(0,0,0,.22);
                border-bottom: 2px solid rgba(0,0,0,.22);
                pointer-events: none;
            }
            #tcfs-toast {
                position: fixed;
                left: 50%;
                bottom: 82px;
                transform: translateX(-50%);
                max-width: min(420px, calc(100vw - 30px));
                z-index: 2147483002;
                opacity: 0;
                transition: opacity .18s ease;
                padding: 9px 13px;
                border-radius: 8px;
                border: 1px solid rgba(255,255,255,.13);
                background: rgba(23,20,18,.96);
                color: #f5efe3;
                box-shadow: 0 10px 30px rgba(0,0,0,.45);
                pointer-events: none;
                text-align: center;
                font: 700 12px/1.35 Arial, sans-serif;
            }
            #tcfs-toast.tcfs-show { opacity: 1; }

            /* v1.2 — compact Torn-header launcher and Find/Collect visual system */
            #tcfs-fab {
                width: 42px;
                height: 42px;
                padding: 0;
                justify-content: center;
                gap: 0;
                overflow: visible;
                border: 1px solid #5b5144;
                border-radius: 50%;
                background:
                    radial-gradient(circle at 50% 48%, rgba(235,163,55,.18) 0 32%, transparent 34%),
                    linear-gradient(180deg, #393735 0%, #242321 100%);
                color: #f0b14b;
                box-shadow:
                    inset 0 1px rgba(255,255,255,.12),
                    inset 0 -2px rgba(0,0,0,.48),
                    0 2px 8px rgba(0,0,0,.55);
                transition: border-color .16s ease, color .16s ease, box-shadow .2s ease,
                            filter .16s ease, transform .12s ease;
            }
            #tcfs-fab::before {
                inset: -4px;
                width: auto;
                height: auto;
                border: 1px solid rgba(231,155,46,.2);
                border-radius: 50%;
                background: transparent;
                opacity: 0;
                transform: scale(.82);
                pointer-events: none;
            }
            #tcfs-fab::after {
                content: "";
                position: absolute;
                inset: 5px;
                border: 1px solid rgba(240,177,75,.28);
                border-radius: 50%;
                pointer-events: none;
            }
            #tcfs-fab:hover,
            #tcfs-fab:focus-visible,
            #tcfs-fab.tcfs-open {
                width: 42px;
                gap: 0;
                border-color: #c98b31;
                background:
                    radial-gradient(circle at 50% 48%, rgba(244,174,59,.28) 0 32%, transparent 34%),
                    linear-gradient(180deg, #46413a 0%, #292621 100%);
                color: #ffd27d;
                box-shadow:
                    inset 0 1px rgba(255,255,255,.14),
                    0 2px 8px rgba(0,0,0,.58),
                    0 0 14px rgba(231,155,46,.28);
                transform: none;
            }
            #tcfs-fab:focus-visible { outline: 2px solid #f0b14b; outline-offset: 3px; }
            #tcfs-fab:active { transform: translateY(1px); }
            #tcfs-fab.tcfs-open::before,
            #tcfs-fab.tcfs-has-items::before {
                opacity: 1;
                transform: scale(1);
            }
            #tcfs-fab.tcfs-has-items {
                border-color: #d69838;
                box-shadow:
                    inset 0 1px rgba(255,255,255,.12),
                    0 2px 8px rgba(0,0,0,.58),
                    0 0 16px rgba(231,155,46,.34);
            }
            #tcfs-fab .cfc-icon,
            #tcfs-fab .cfc-icon svg { width: 24px; height: 24px; }
            #tcfs-fab .cfc-label {
                position: absolute;
                width: 1px;
                height: 1px;
                overflow: hidden;
                clip: rect(0 0 0 0);
                opacity: 0;
            }
            #tcfs-fab:hover .cfc-label,
            #tcfs-fab:focus-visible .cfc-label,
            #tcfs-fab.tcfs-open .cfc-label { width: 1px; opacity: 0; }
            #tcfs-fab .tcfs-badge {
                top: -4px;
                right: -7px;
                min-width: 18px;
                height: 18px;
                padding: 0 4px;
                border-color: #252321;
                background: #d7902d;
                color: #17130d;
                box-shadow: 0 2px 7px rgba(0,0,0,.55), 0 0 8px rgba(231,155,46,.32);
                font-size: 10px;
            }
            #tcfs-panel {
                width: 404px;
                border: 1px solid #49433b;
                border-radius: 7px;
                background:
                    linear-gradient(rgba(24,23,22,.975), rgba(17,17,16,.985)),
                    repeating-linear-gradient(115deg, transparent 0 8px, rgba(255,255,255,.015) 9px 10px);
                color: #ece8df;
                box-shadow: 0 22px 64px rgba(0,0,0,.7), 0 0 0 1px rgba(0,0,0,.6);
            }
            .tcfs-head {
                min-height: 50px;
                padding: 8px 10px 8px 12px;
                border-bottom-color: rgba(231,155,46,.28);
                background: linear-gradient(100deg, rgba(231,155,46,.16), rgba(255,255,255,.035) 46%, transparent);
            }
            .tcfs-brandmark {
                width: 32px;
                height: 32px;
                flex: 0 0 32px;
                display: grid;
                place-items: center;
                border: 1px solid rgba(231,155,46,.42);
                border-radius: 50%;
                color: #f0b14b;
                box-shadow: inset 0 0 9px rgba(231,155,46,.11);
            }
            .tcfs-brandmark svg { width: 21px; height: 21px; }
            .tcfs-title {
                color: #f3eee4;
                font-size: 14px;
                font-weight: 850;
                letter-spacing: .7px;
                line-height: 1.15;
                text-transform: uppercase;
            }
            .tcfs-title span { color: #c89546; letter-spacing: 0; }
            .tcfs-head-status {
                margin-top: 3px;
                color: #8f8a81;
                font-size: 10px;
                font-weight: 650;
                letter-spacing: .35px;
                text-transform: none;
            }
            .tcfs-iconbtn { border-radius: 5px; color: #bbb5aa; }
            .tcfs-tabs button.tcfs-active {
                border-color: rgba(231,155,46,.65);
                background: rgba(231,155,46,.13);
                color: #f2c477;
            }
            .tcfs-row.tcfs-selected { border-color: rgba(231,155,46,.52); background: rgba(231,155,46,.09); }
            .tcfs-pill { border-color: rgba(231,155,46,.34); background: rgba(231,155,46,.1); color: #f0c171; }
            .tcfs-teal { border-color: rgba(93,178,158,.34); background: rgba(93,178,158,.1); color: #92d1c1; }

            /* v1.2.1 — lighter, quieter UI with an optional dark theme */
            #tcfs-fab {
                width: 34px;
                height: 34px;
                border-color: #6a6258;
                background: linear-gradient(180deg, #403e3b, #292826);
                color: #e5a548;
                box-shadow: inset 0 1px rgba(255,255,255,.13), 0 2px 6px rgba(0,0,0,.42);
            }
            #tcfs-fab::before { inset: -3px; }
            #tcfs-fab::after { inset: 4px; }
            #tcfs-fab:hover,
            #tcfs-fab:focus-visible,
            #tcfs-fab.tcfs-open {
                width: 34px;
                border-color: #d19a4b;
                background: linear-gradient(180deg, #494640, #302e2a);
                box-shadow: inset 0 1px rgba(255,255,255,.15), 0 2px 7px rgba(0,0,0,.44), 0 0 9px rgba(229,165,72,.2);
            }
            #tcfs-fab .cfc-icon,
            #tcfs-fab .cfc-icon svg { width: 20px; height: 20px; }
            #tcfs-fab .tcfs-badge {
                top: -5px;
                right: -7px;
                min-width: 16px;
                height: 16px;
                border-width: 1px;
                font-size: 9px;
            }

            #tcfs-panel[data-theme] {
                --tcfs-bg: #f4f5f6;
                --tcfs-surface: #ffffff;
                --tcfs-soft: #eceff1;
                --tcfs-soft-hover: #e3e7ea;
                --tcfs-text: #272a2e;
                --tcfs-muted: #71767c;
                --tcfs-border: #d8dde1;
                --tcfs-accent: #b9751d;
                --tcfs-accent-soft: #fff2dc;
                --tcfs-accent-border: #e1b66e;
                width: 390px;
                border-color: var(--tcfs-border);
                border-radius: 10px;
                background: var(--tcfs-bg);
                color: var(--tcfs-text);
                box-shadow: 0 18px 48px rgba(15,20,24,.22), 0 2px 8px rgba(15,20,24,.08);
            }
            #tcfs-panel[data-theme="dark"] {
                --tcfs-bg: #202326;
                --tcfs-surface: #292d31;
                --tcfs-soft: #25292d;
                --tcfs-soft-hover: #34393e;
                --tcfs-text: #eef0f2;
                --tcfs-muted: #a7adb3;
                --tcfs-border: #3b4147;
                --tcfs-accent: #e0a24d;
                --tcfs-accent-soft: #3b3225;
                --tcfs-accent-border: #765c36;
                box-shadow: 0 20px 54px rgba(0,0,0,.48);
            }
            #tcfs-panel[data-theme] .tcfs-head {
                min-height: 44px;
                padding: 7px 9px 7px 11px;
                border-bottom-color: var(--tcfs-border);
                background: var(--tcfs-surface);
            }
            #tcfs-panel[data-theme] .tcfs-brandmark {
                width: 28px;
                height: 28px;
                flex-basis: 28px;
                border-color: var(--tcfs-accent-border);
                color: var(--tcfs-accent);
                box-shadow: none;
            }
            #tcfs-panel[data-theme] .tcfs-brandmark svg { width: 18px; height: 18px; }
            #tcfs-panel[data-theme] .tcfs-title {
                color: var(--tcfs-text);
                font-size: 13px;
                font-weight: 680;
                letter-spacing: .15px;
                text-transform: none;
            }
            #tcfs-panel[data-theme] .tcfs-title span,
            #tcfs-panel[data-theme] .tcfs-head-status,
            #tcfs-panel[data-theme] .tcfs-summary,
            #tcfs-panel[data-theme] .tcfs-detail-meta,
            #tcfs-panel[data-theme] .tcfs-row-meta,
            #tcfs-panel[data-theme] .tcfs-setting-note,
            #tcfs-panel[data-theme] .tcfs-empty { color: var(--tcfs-muted); }
            #tcfs-panel[data-theme] .tcfs-head-status {
                margin-top: 2px;
                font-size: 10px;
                font-weight: 500;
                letter-spacing: 0;
            }
            #tcfs-panel[data-theme] .tcfs-iconbtn,
            #tcfs-panel[data-theme] .tcfs-smallbtn,
            #tcfs-panel[data-theme] .tcfs-row button,
            #tcfs-panel[data-theme] .tcfs-detail-actions button,
            #tcfs-panel[data-theme] .tcfs-tabs button {
                border-color: var(--tcfs-border);
                background: var(--tcfs-surface);
                color: var(--tcfs-text);
                font-weight: 600;
            }
            #tcfs-panel[data-theme] .tcfs-iconbtn:hover,
            #tcfs-panel[data-theme] .tcfs-smallbtn:hover,
            #tcfs-panel[data-theme] .tcfs-row button:hover,
            #tcfs-panel[data-theme] .tcfs-detail-actions button:hover,
            #tcfs-panel[data-theme] .tcfs-tabs button:hover { background: var(--tcfs-soft-hover); }
            #tcfs-panel[data-theme] .tcfs-tabs,
            #tcfs-panel[data-theme] .tcfs-tools,
            #tcfs-panel[data-theme] .tcfs-summary,
            #tcfs-panel[data-theme] .tcfs-detail { border-bottom-color: var(--tcfs-border); }
            #tcfs-panel[data-theme] .tcfs-tabs { gap: 6px; padding: 7px 10px; }
            #tcfs-panel[data-theme] .tcfs-tabs button { padding: 7px 9px; border-radius: 7px; }
            #tcfs-panel[data-theme] .tcfs-tabs button.tcfs-active {
                border-color: var(--tcfs-accent-border);
                background: var(--tcfs-accent-soft);
                color: var(--tcfs-accent);
            }
            #tcfs-panel[data-theme] .tcfs-tools { padding: 8px 10px; }
            #tcfs-panel[data-theme] .tcfs-tools input,
            #tcfs-panel[data-theme] .tcfs-tools select,
            #tcfs-panel[data-theme] .tcfs-settings input,
            #tcfs-panel[data-theme] .tcfs-settings select {
                border-color: var(--tcfs-border);
                background: var(--tcfs-surface);
                color: var(--tcfs-text);
            }
            #tcfs-panel[data-theme] select option { background: var(--tcfs-surface); color: var(--tcfs-text); }
            #tcfs-panel[data-theme] .tcfs-summary { padding: 7px 11px; }
            #tcfs-panel[data-theme] .tcfs-detail { background: var(--tcfs-soft); }
            #tcfs-panel[data-theme] .tcfs-detail.tcfs-open {
                grid-template-columns: minmax(0, 1fr);
                gap: 9px;
            }
            #tcfs-panel[data-theme] .tcfs-list { padding: 7px; }
            #tcfs-panel[data-theme] .tcfs-row {
                grid-template-columns: minmax(0, 1fr);
                gap: 0;
                margin-bottom: 5px;
                padding: 9px 10px;
                border-color: transparent;
                border-radius: 7px;
                background: var(--tcfs-surface);
                box-shadow: 0 1px 2px rgba(15,20,24,.05);
            }
            #tcfs-panel[data-theme] .tcfs-row:hover { border-color: var(--tcfs-border); background: var(--tcfs-soft); }
            #tcfs-panel[data-theme] .tcfs-row.tcfs-selected {
                border-color: var(--tcfs-accent-border);
                background: var(--tcfs-accent-soft);
            }
            #tcfs-panel[data-theme] .tcfs-row-name { font-weight: 650; }
            #tcfs-panel[data-theme] .tcfs-value { color: var(--tcfs-accent); font-weight: 650; }
            #tcfs-panel[data-theme] .tcfs-pill {
                border: 0;
                background: var(--tcfs-accent-soft);
                color: var(--tcfs-accent);
            }
            #tcfs-panel[data-theme] .tcfs-settings {
                border-bottom-color: var(--tcfs-border);
                background: var(--tcfs-soft);
            }
            #tcfs-panel[data-theme] .tcfs-theme-icon { width: 17px; height: 17px; display: block; }
            #tcfs-panel[data-theme="light"] .tcfs-sun,
            #tcfs-panel[data-theme="dark"] .tcfs-moon { display: none; }

            /* v1.2.2 — compact controls and a useful full-height results area */
            #tcfs-fab {
                width: 30px;
                height: 30px;
            }
            #tcfs-fab:hover,
            #tcfs-fab:focus-visible,
            #tcfs-fab.tcfs-open { width: 30px; }
            #tcfs-fab .cfc-icon,
            #tcfs-fab .cfc-icon svg { width: 18px; height: 18px; }
            #tcfs-fab .tcfs-badge {
                top: -5px;
                right: -7px;
                min-width: 15px;
                height: 15px;
                padding: 0 3px;
                font-size: 8px;
            }
            #tcfs-panel[data-theme] {
                height: min(72vh, 580px);
                min-height: 360px;
            }
            #tcfs-panel[data-theme] .tcfs-head {
                min-height: 38px;
                padding: 5px 7px 5px 9px;
                gap: 5px;
            }
            #tcfs-panel[data-theme] .tcfs-brandmark {
                width: 24px;
                height: 24px;
                flex-basis: 24px;
            }
            #tcfs-panel[data-theme] .tcfs-brandmark svg { width: 16px; height: 16px; }
            #tcfs-panel[data-theme] .tcfs-title { font-size: 12px; }
            #tcfs-panel[data-theme] .tcfs-head-status { font-size: 9px; }
            #tcfs-panel[data-theme] .tcfs-iconbtn {
                width: 26px;
                height: 26px;
                min-height: 26px;
                padding: 0;
                font-size: 12px;
            }
            #tcfs-panel[data-theme] .tcfs-theme-icon { width: 15px; height: 15px; }
            #tcfs-panel[data-theme] .tcfs-tabs {
                justify-content: flex-start;
                gap: 5px;
                padding: 6px 9px;
            }
            #tcfs-panel[data-theme] .tcfs-tabs button {
                flex: 0 0 auto;
                min-height: 25px;
                padding: 4px 13px;
                border-radius: 6px;
                font-size: 11px;
            }
            #tcfs-panel[data-theme] .tcfs-tools { padding: 6px 9px; }
            #tcfs-panel[data-theme] .tcfs-tools input,
            #tcfs-panel[data-theme] .tcfs-tools select {
                height: 27px;
                font-size: 11px;
            }
            #tcfs-panel[data-theme] .tcfs-summary {
                min-height: 25px;
                padding: 5px 10px;
                font-size: 11px;
            }
            #tcfs-panel[data-theme] .tcfs-detail { padding: 8px 10px; }
            #tcfs-panel[data-theme] .tcfs-detail-actions {
                display: flex;
                flex-wrap: wrap;
                gap: 5px;
            }
            #tcfs-panel[data-theme] .tcfs-detail-actions button,
            #tcfs-panel[data-theme] .tcfs-smallbtn {
                min-height: 25px;
                padding: 4px 8px;
                font-size: 11px;
            }
            #tcfs-panel[data-theme] .tcfs-list {
                flex: 1 1 auto;
                min-height: 150px;
                overflow-y: auto;
                padding: 6px;
                scrollbar-width: auto;
                scrollbar-color: var(--tcfs-muted) var(--tcfs-soft);
            }
            #tcfs-panel[data-theme] .tcfs-list::-webkit-scrollbar { width: 10px; }
            #tcfs-panel[data-theme] .tcfs-list::-webkit-scrollbar-track { background: var(--tcfs-soft); }
            #tcfs-panel[data-theme] .tcfs-list::-webkit-scrollbar-thumb {
                border: 2px solid var(--tcfs-soft);
                border-radius: 999px;
                background: var(--tcfs-muted);
            }
            #tcfs-panel[data-theme] .tcfs-row {
                margin-bottom: 4px;
                padding: 7px 9px;
            }
            #tcfs-panel[data-theme] .tcfs-row.tcfs-has-icon {
                grid-template-columns: 24px minmax(0, 1fr);
                gap: 8px;
                align-items: center;
            }
            #tcfs-panel[data-theme] .tcfs-row .tcfs-item-icon {
                width: 22px;
                height: 22px;
                border-radius: 5px;
                object-fit: contain;
                background: transparent;
                border: 0;
                box-shadow: none;
            }
            #tcfs-panel[data-theme] .tcfs-row-name { font-size: 12px; }
            #tcfs-panel[data-theme] .tcfs-row-meta { margin-top: 2px; font-size: 10px; }
            #tcfs-panel[data-theme] .tcfs-settings .tcfs-setting-row:first-child {
                margin-bottom: 9px;
                padding-bottom: 8px;
                border-bottom: 1px solid var(--tcfs-border);
            }
            #tcfs-panel[data-theme].tcfs-settings-mode .tcfs-tabs,
            #tcfs-panel[data-theme].tcfs-settings-mode .tcfs-tools,
            #tcfs-panel[data-theme].tcfs-settings-mode .tcfs-summary,
            #tcfs-panel[data-theme].tcfs-settings-mode .tcfs-detail,
            #tcfs-panel[data-theme].tcfs-settings-mode .tcfs-list {
                display: none !important;
            }
            #tcfs-panel[data-theme].tcfs-settings-mode .tcfs-settings {
                flex: 1 1 auto;
                overflow-y: auto;
                border-bottom: 0;
            }
            @keyframes tcfs-new-find-pulse {
                0% { box-shadow: inset 0 1px rgba(255,255,255,.12), 0 2px 8px rgba(0,0,0,.58), 0 0 0 0 rgba(231,155,46,.48); }
                58% { box-shadow: inset 0 1px rgba(255,255,255,.12), 0 2px 8px rgba(0,0,0,.58), 0 0 0 9px rgba(231,155,46,0); }
                100% { box-shadow: inset 0 1px rgba(255,255,255,.12), 0 2px 8px rgba(0,0,0,.58), 0 0 0 0 rgba(231,155,46,0); }
            }
            #tcfs-fab.tcfs-new-find-pulse {
                animation: tcfs-new-find-pulse 1.25s ease-out 2;
            }

            @media (hover: none) {
                #tcfs-fab:hover:not(.tcfs-open) {
                    width: 30px;
                    gap: 0;
                    transform: none;
                }
                #tcfs-fab:hover:not(.tcfs-open) .cfc-label {
                    width: 0;
                    opacity: 0;
                }
            }
            @media (prefers-reduced-motion: reduce) {
                #tcfs-fab,
                #tcfs-fab::before,
                #tcfs-fab .cfc-label {
                    transition: none;
                }
                #tcfs-fab.tcfs-new-find-pulse {
                    animation: none;
                }
            }
            @media (max-width: 520px) {
                #tcfs-panel {
                    width: calc(100vw - 20px);
                    max-height: 72vh;
                }
                .tcfs-tools {
                    display: grid;
                    grid-template-columns: 1fr 118px;
                }
                .tcfs-summary {
                    flex-wrap: wrap;
                }
            }
        `;

        const style = document.createElement('style');
        style.id = 'tcfs-styles';
        style.textContent = css;
        document.head.appendChild(style);
    }

    function buildUI() {
        injectStyles();
        if (document.getElementById('tcfs-fab')) return;

        fab = document.createElement('button');
        fab.id = 'tcfs-fab';
        fab.type = 'button';
        fab.title = 'City Find / Collect';
        fab.setAttribute('aria-label', 'Open City Finds');
        fab.setAttribute('aria-controls', 'tcfs-panel');
        fab.setAttribute('aria-expanded', 'false');
        
        fab.innerHTML = `
            <div class="cfc-icon">
                <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.7" stroke-linecap="round" aria-hidden="true">
                    <circle cx="12" cy="12" r="6.2" />
                    <circle cx="12" cy="12" r="2.2" fill="currentColor" stroke="none" />
                    <path d="M12 2.2v3.2M12 18.6v3.2M2.2 12h3.2M18.6 12h3.2" />
                </svg>
            </div>
            <span class="cfc-label">Find / Collect</span>
            <span class="tcfs-badge" aria-label="0 active finds"></span>
        `;
        document.body.appendChild(fab);
        badge = fab.querySelector('.tcfs-badge');

        panel = document.createElement('div');
        panel.id = 'tcfs-panel';
        panel.dataset.theme = settings.theme;
        panel.setAttribute('role', 'dialog');
        panel.setAttribute('aria-label', 'City Finds');
        panel.innerHTML = `
            <div class="tcfs-head">
                <div class="tcfs-brandmark" aria-hidden="true">
                    <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.7" stroke-linecap="round">
                        <circle cx="12" cy="12" r="6.2"/><circle cx="12" cy="12" r="2.2" fill="currentColor" stroke="none"/>
                        <path d="M12 2.2v3.2M12 18.6v3.2M2.2 12h3.2M18.6 12h3.2"/>
                    </svg>
                </div>
                <div class="tcfs-title">City Finder <span>v${VERSION}</span><div class="tcfs-head-status">Scanner ready</div></div>
                <button class="tcfs-iconbtn" type="button" data-action="theme" title="Use dark theme" aria-label="Use dark theme">
                    <svg class="tcfs-theme-icon tcfs-moon" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M20.2 15.4A8.5 8.5 0 0 1 8.6 3.8a8.5 8.5 0 1 0 11.6 11.6Z"/></svg>
                    <svg class="tcfs-theme-icon tcfs-sun" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" aria-hidden="true"><circle cx="12" cy="12" r="3.6"/><path d="M12 2v2M12 20v2M4.9 4.9l1.4 1.4M17.7 17.7l1.4 1.4M2 12h2M20 12h2M4.9 19.1l1.4-1.4M17.7 6.3l1.4-1.4"/></svg>
                </button>
                <button class="tcfs-iconbtn" type="button" data-action="settings" title="Settings">&#9881;</button>
                <button class="tcfs-iconbtn" type="button" data-action="refresh" title="Refresh">&#8635;</button>
                <button class="tcfs-iconbtn" type="button" data-action="close" title="Close">x</button>
            </div>
            <div class="tcfs-settings"></div>
            <div class="tcfs-tabs" role="tablist" aria-label="Find views">
                <button type="button" data-tab="active" role="tab">Active</button>
                <button type="button" data-tab="history" role="tab">History</button>
            </div>
            <div class="tcfs-tools">
                <input type="search" data-role="search" placeholder="Search items" autocomplete="off">
                <select data-role="sort" title="Sort">
                    <option value="date">Date</option>
                    <option value="value">Value</option>
                    <option value="category">Category</option>
                    <option value="name">Name</option>
                </select>
            </div>
            <div class="tcfs-summary"></div>
            <div class="tcfs-detail"></div>
            <div class="tcfs-list"></div>
        `;
        document.body.appendChild(panel);

        settingsEl = panel.querySelector('.tcfs-settings');
        listEl = panel.querySelector('.tcfs-list');
        detailEl = panel.querySelector('.tcfs-detail');
        applyTheme();

        fab.addEventListener('click', () => togglePanel());
        positionHeaderFab();
        [250, 1000, 3000].forEach((delay) => setTimeout(positionHeaderFab, delay));

        panel.addEventListener('click', onPanelClick);
        panel.querySelector('[data-role="search"]').addEventListener('input', (event) => {
            settings.search = event.target.value;
            saveSettings();
            render();
        });
        panel.querySelector('[data-role="sort"]').addEventListener('change', (event) => {
            settings.sort = event.target.value;
            saveSettings();
            render();
        });
        document.addEventListener('keydown', onDocumentKeydown);

        window.addEventListener('resize', () => {
            positionHeaderFab();
            if (panel.classList.contains('tcfs-open')) anchorPanel();
        });

        renderSettings();
        render();

        if (settings.panelOpen) togglePanel(true);
    }

    function isTypingTarget(target) {
        const element = target && target.nodeType === 1 ? target : null;
        if (!element) return false;
        const tagName = element.tagName ? element.tagName.toLowerCase() : '';
        return tagName === 'input' ||
            tagName === 'textarea' ||
            tagName === 'select' ||
            element.isContentEditable;
    }

    function focusSearchShortcut() {
        if (!panel || !fab) return;
        if (!panel.classList.contains('tcfs-open')) togglePanel(true);
        if (settingsEl) settingsEl.classList.remove('tcfs-open');
        panel.classList.remove('tcfs-settings-mode');
        const searchInput = panel.querySelector('[data-role="search"]');
        if (searchInput) {
            searchInput.focus();
            searchInput.select();
        }
    }

    function onDocumentKeydown(event) {
        if (!panel || event.ctrlKey || event.metaKey || event.altKey) return;

        if (event.key === 'Escape' && panel.classList.contains('tcfs-open')) {
            event.preventDefault();
            togglePanel(false);
            return;
        }

        if (event.key === '/' && !isTypingTarget(event.target)) {
            event.preventDefault();
            focusSearchShortcut();
        }
    }

    function onPanelClick(event) {
        const tabEl = event.target.closest('[data-tab]');
        if (tabEl) {
            settings.tab = tabEl.dataset.tab === 'history' ? 'history' : 'active';
            saveSettings();
            selectedKey = null;
            render();
            return;
        }

        const actionEl = event.target.closest('[data-action]');
        if (!actionEl) return;

        const action = actionEl.dataset.action;
        const key = actionEl.closest('[data-key]') ? actionEl.closest('[data-key]').dataset.key : selectedKey;

        if (action === 'settings') {
            const open = !settingsEl.classList.contains('tcfs-open');
            settingsEl.classList.toggle('tcfs-open', open);
            panel.classList.toggle('tcfs-settings-mode', open);
            return;
        }
        if (action === 'theme') {
            settings.theme = settings.theme === 'dark' ? 'light' : 'dark';
            saveSettings();
            applyTheme();
            return;
        }
        if (action === 'refresh') {
            syncNow(true);
            return;
        }
        if (action === 'close') {
            togglePanel(false);
            return;
        }
        if (action === 'center') {
            centerItemByKey(key, true);
            return;
        }
        if (action === 'reveal') {
            revealForManualPickup(key);
            return;
        }
        if (action === 'picked') {
            markPicked(key);
            return;
        }
        if (action === 'select') {
            selectedKey = key;
            render();
            centerItemByKey(key, false);
            return;
        }
        if (action === 'restore') {
            restoreRecord(key);
            return;
        }
        if (action === 'open-api') {
            window.open('https://www.torn.com/preferences.php#tab=api', '_blank', 'noopener');
            return;
        }
        if (action === 'save-api') {
            saveApiSettings();
            return;
        }
        if (action === 'refresh-meta') {
            fetchItemMetadata(true);
            return;
        }
    }

    function applyTheme() {
        if (!panel) return;
        panel.dataset.theme = settings.theme;
        const button = panel.querySelector('[data-action="theme"]');
        if (button) {
            const label = settings.theme === 'dark' ? 'Use light theme' : 'Use dark theme';
            button.title = label;
            button.setAttribute('aria-label', label);
        }
    }

    function renderSettings() {
        if (!settingsEl) return;

        settingsEl.innerHTML = `
            <div class="tcfs-setting-row">
                <label title="Show small item icons in the list instead of text-only rows.">
                    <input type="checkbox" data-setting="showImages" ${settings.showImages ? 'checked' : ''}>
                    Show compact item icons
                </label>
            </div>
            <div class="tcfs-setting-row">
                <label>
                    <input type="checkbox" data-setting="apiEnabled" ${settings.apiEnabled ? 'checked' : ''}>
                    Fetch market values via Torn Public API
                </label>
            </div>
            <div id="tcfs-api-block" style="display: ${settings.apiEnabled ? 'block' : 'none'}; padding-left: 22px; margin-bottom: 6px;">
                <div class="tcfs-setting-row">
                    <input type="password" data-setting="apiKey" placeholder="Public API Key (16 chars)" value="${escapeAttr(settings.apiKey)}" maxlength="16" autocomplete="off">
                    <button class="tcfs-smallbtn" type="button" data-action="save-api">Save Key</button>
                    <button class="tcfs-smallbtn" type="button" data-action="open-api" title="Get Key from Torn Preferences">Get Key</button>
                </div>
                <div class="tcfs-setting-note">
                    Status: <strong>${escapeHtml(metaStatus)}</strong>${busyMeta ? ' (Syncing...)' : ''}. Cached values refresh auto every 12 hours.
                    <br>Uses only Torn's public <code>torn/items</code> selection. The key and returned values stay in private local userscript storage and are sent only to <code>api.torn.com</code>. Use a Public-access key.
                    <br><button class="tcfs-smallbtn" type="button" data-action="refresh-meta" style="margin-top:5px;" ${busyMeta ? 'disabled' : ''}>Force Update Now</button>
                </div>
            </div>
        `;

        settingsEl.querySelectorAll('input[type="checkbox"]').forEach((box) => {
            box.addEventListener('change', (event) => {
                const name = event.target.dataset.setting;
                settings[name] = event.target.checked;
                saveSettings();

                if (name === 'apiEnabled') {
                    document.getElementById('tcfs-api-block').style.display = settings.apiEnabled ? 'block' : 'none';
                    if (settings.apiEnabled && !itemMetaFetchedAt) fetchItemMetadata(false);
                }
                render();
            });
        });

    }

    function saveApiSettings() {
        const input = settingsEl.querySelector('input[data-setting="apiKey"]');
        if (!input) return;

        const key = cleanText(input.value);
        if (key && key.length !== 16) {
            showToast('API Key must be exactly 16 characters long.');
            return;
        }

        settings.apiKey = key;
        saveSettings();
        nextMetadataAttemptAt = 0;
        showToast('API key locally saved.');
        fetchItemMetadata(true);
    }

    function togglePanel(forceOpen) {
        const next = forceOpen === undefined ? !panel.classList.contains('tcfs-open') : Boolean(forceOpen);
        fab.classList.toggle('tcfs-open', next);
        fab.setAttribute('aria-expanded', String(next));
        fab.setAttribute('aria-label', next ? 'Close City Finds' : 'Open City Finds');
        if (next) {
            panel.classList.add('tcfs-open');
            render();
            anchorPanel();
        } else {
            panel.classList.remove('tcfs-open');
            if (settingsEl) settingsEl.classList.remove('tcfs-open');
            panel.classList.remove('tcfs-settings-mode');
        }
        settings.panelOpen = next;
        saveSettings();
    }

    function isVisibleAnchor(element) {
        if (!element || !element.isConnected) return false;
        const rect = element.getBoundingClientRect();
        return rect.width > 0 && rect.height > 0 && rect.bottom > 0 && rect.top < 90;
    }

    function firstVisible(selectors) {
        for (const selector of selectors) {
            try {
                const matches = document.querySelectorAll(selector);
                for (const element of matches) {
                    if (isVisibleAnchor(element)) return element;
                }
            } catch (_) {}
        }
        return null;
    }

    function exactTextAnchor(label) {
        const wanted = label.toUpperCase();
        const candidates = document.querySelectorAll('a, button, [role="button"], li, span');
        for (const element of candidates) {
            if (cleanText(element.textContent).toUpperCase() === wanted && isVisibleAnchor(element)) {
                return element.closest('a, button, [role="button"], li') || element;
            }
        }
        return null;
    }

    function positionHeaderFab() {
        if (!fab) return;

        const toolAnchor = firstVisible([
            '[title*="Torn Tools" i]',
            '[aria-label*="Torn Tools" i]',
            'img[alt*="Torn Tools" i]',
            'a[href*="torn.tools" i]',
            '[id*="torntools" i]',
            '[class*="torntools" i]'
        ]);
        const bustrAnchor = firstVisible([
            '[title*="BUSTR" i]',
            '[aria-label*="BUSTR" i]',
            'a[href*="bustr" i]',
            '[id*="bustr" i]',
            '[class*="bustr" i]'
        ]) || exactTextAnchor('BUSTR+');

        const buttonWidth = 30;
        let left;
        let top;

        if (toolAnchor) {
            const toolRect = toolAnchor.getBoundingClientRect();
            left = toolRect.right + 14;
            top = toolRect.top + (toolRect.height - buttonWidth) / 2;

            if (bustrAnchor) {
                const bustrRect = bustrAnchor.getBoundingClientRect();
                left = Math.min(left, bustrRect.left - buttonWidth - 14);
            }
        } else if (bustrAnchor) {
            const bustrRect = bustrAnchor.getBoundingClientRect();
            left = bustrRect.left - buttonWidth - 18;
            top = bustrRect.top + (bustrRect.height - buttonWidth) / 2;
        } else {
            left = window.innerWidth - buttonWidth - 250;
            top = 8;
        }

        left = Math.max(10, Math.min(window.innerWidth - buttonWidth - 10, left));
        top = Math.max(4, Math.min(52, Number.isFinite(top) ? top : 8));
        fab.style.left = Math.round(left) + 'px';
        fab.style.top = Math.round(top) + 'px';

        if (panel && panel.classList.contains('tcfs-open')) anchorPanel();
    }

    function placeFab(left, top, persist) {
        if (!fab) return;
        const pad = 10;
        const w = 46;
        const h = 46;

        const x = Math.max(pad, Math.min(window.innerWidth - w - pad, left));
        const y = Math.max(pad, Math.min(window.innerHeight - h - pad, top));

        fab.style.left = x + 'px';
        fab.style.top = y + 'px';
        fab.classList.toggle('tcfs-expand-left', x + (w / 2) > window.innerWidth / 2);

        settings.fabX = x;
        settings.fabY = y;
        if (persist) saveSettings();
    }

    function anchorPanel() {
        if (!fab || !panel) return;
        const fRect = fab.getBoundingClientRect();
        const pW = panel.offsetWidth || 380;
        const pH = panel.offsetHeight || 500;
        const pad = 12;

        let left = fRect.left + (fRect.width / 2) - (pW / 2);
        if (left + pW > window.innerWidth - pad) left = window.innerWidth - pW - pad;
        if (left < pad) left = pad;

        let top = fRect.top - pH - pad;
        if (top < pad) {
            top = fRect.bottom + pad;
            if (top + pH > window.innerHeight - pad) top = Math.max(pad, window.innerHeight - pH - pad);
        }

        panel.style.left = left + 'px';
        panel.style.top = top + 'px';
    }

    function makeFabDraggable() {
        let dragging = false;
        let suppressClick = false;
        let pointerId = null;
        let originX = 0;
        let originY = 0;
        let startX = 0;
        let startY = 0;

        fab.addEventListener('pointerdown', onStart);
        fab.addEventListener('pointermove', onMove);
        fab.addEventListener('pointerup', onEnd);
        fab.addEventListener('pointercancel', onCancel);
        fab.addEventListener('click', onClick);

        function onStart(event) {
            if (event.button !== 0 || pointerId !== null) return;

            dragging = false;
            suppressClick = false;
            pointerId = event.pointerId;
            originX = event.clientX;
            originY = event.clientY;
            const rect = fab.getBoundingClientRect();
            const cssLeft = parseFloat(fab.style.left);
            const cssTop = parseFloat(fab.style.top);
            startX = event.clientX - (Number.isFinite(cssLeft) ? cssLeft : rect.left);
            startY = event.clientY - (Number.isFinite(cssTop) ? cssTop : rect.top);

            try {
                fab.setPointerCapture(pointerId);
            } catch (_) {}
        }

        function onMove(event) {
            if (event.pointerId !== pointerId) return;

            if (!dragging) {
                const distance = Math.hypot(event.clientX - originX, event.clientY - originY);
                if (distance < DRAG_THRESHOLD_PX) return;
                dragging = true;
                suppressClick = true;
                fab.classList.add('tcfs-dragging');
            }

            if (event.cancelable) event.preventDefault();
            placeFab(event.clientX - startX, event.clientY - startY, false);
            if (panel.classList.contains('tcfs-open')) anchorPanel();
        }

        function finishPointer(event, cancelled) {
            if (event.pointerId !== pointerId) return;
            try {
                fab.releasePointerCapture(pointerId);
            } catch (_) {}
            pointerId = null;
            fab.classList.remove('tcfs-dragging');

            if (dragging) {
                saveSettings();
                if (panel.classList.contains('tcfs-open')) anchorPanel();
            }
            dragging = false;
            if (cancelled) suppressClick = false;
            else setTimeout(() => { suppressClick = false; }, 0);
        }

        function onEnd(event) {
            finishPointer(event, false);
        }

        function onCancel(event) {
            finishPointer(event, true);
        }

        function onClick(event) {
            if (suppressClick) {
                event.preventDefault();
                suppressClick = false;
                return;
            }
            togglePanel();
        }
    }

    function showToast(message) {
        if (!message) return;
        let toast = document.getElementById('tcfs-toast');
        if (!toast) {
            toast = document.createElement('div');
            toast.id = 'tcfs-toast';
            document.body.appendChild(toast);
        }

        clearTimeout(toastTimer);
        toast.textContent = cleanText(message);
        toast.classList.add('tcfs-show');

        toastTimer = setTimeout(() => {
            toast.classList.remove('tcfs-show');
        }, 3400);
    }

    function centerItemByKey(key, forceZoom) {
        if (!key || !tornReady()) return;
        const record = historyMap[key];
        if (!record) return;

        const latLng = getLatLng(record);
        if (!latLng) {
            showToast('Unable to parse coordinates for this item position.');
            return;
        }

        try {
            const lmap = getTorn().map.lmap;
            if (forceZoom) {
                lmap.setView(latLng, PICKUP_ZOOM, { animate: true });
            } else {
                lmap.panTo(latLng, { animate: true });
            }
        } catch (_) {}
    }

    function revealForManualPickup(key) {
        if (!key || !tornReady()) return;
        const record = historyMap[key];
        if (!record) return;

        const pin = markers[key];
        if (!pin) {
            showToast('Map pin context missing. Try centering on it first.');
            return;
        }

        clearTimeout(revealTimer);
        selectedKey = key;
        centerItemByKey(key, true);

        try {
            const el = pin.getElement();
            if (el) {
                const dot = el.querySelector('.tcfs-map-dot');
                if (dot) {
                    dot.style.pointerEvents = 'none';
                    dot.style.opacity = '0.05';
                }
                const label = el.querySelector('.tcfs-map-label');
                if (label) label.style.opacity = '0.05';
                const tail = el.querySelector('.tcfs-map-tail');
                if (tail) tail.style.opacity = '0.05';
            }
        } catch (_) {}

        showToast('Overlay hidden for 10s. Click the asset directly to pick up.');

        revealTimer = setTimeout(() => {
            renderMapPins();
        }, REVEAL_MS);
    }

    function markPicked(key) {
        if (!key) return;
        const record = historyMap[key];
        if (!record) return;

        record.status = 'picked';
        record.pickedAt = Date.now();
        saveHistory();

        if (selectedKey === key) selectedKey = null;
        showToast(`Logged "${record.title}" as manually collected.`);
        syncNow(false);
    }

    function restoreRecord(key) {
        if (!key) return;
        const record = historyMap[key];
        if (!record) return;

        record.status = 'active';
        record.pickedAt = null;
        record.goneAt = null;
        saveHistory();

        showToast(`Restored "${record.title}" to active trackers.`);
        syncNow(false);
    }

    function clearGoneHistory() {
        let count = 0;
        Object.keys(historyMap).forEach((key) => {
            const status = historyMap[key].status;
            if (status === 'gone' || status === 'picked') {
                delete historyMap[key];
                count++;
            }
        });

        if (count > 0) {
            saveHistory();
            if (selectedKey && !historyMap[selectedKey]) selectedKey = null;
            showToast(`Cleared ${count} past historical logs.`);
            render();
        } else {
            showToast('No inactive logs found to purge.');
        }
    }

    function getImageUrl(itemId) {
        if (!itemId) return '';
        return `https://www.torn.com/images/items/${itemId}/small.png`;
    }

    function buildRowToken(itemId, title) {
        if (!settings.showImages || !itemId) return '';
        return `<img class="tcfs-item-icon" src="${escapeAttr(getImageUrl(itemId))}" alt="" loading="lazy" referrerpolicy="no-referrer">`;
    }

    function matchFilter(record, searchLow) {
        if (!searchLow) return true;
        if (String(record.itemId).includes(searchLow)) return true;
        if (record.title.toLowerCase().includes(searchLow)) return true;
        if (getRecordCategory(record).toLowerCase().includes(searchLow)) return true;
        return false;
    }

    function getSortedRecords() {
        const searchLow = cleanText(settings.search).toLowerCase();
        const records = Object.values(historyMap)
            .filter((r) => settings.tab === 'history' ? r.status !== 'active' : r.status === 'active')
            .filter((r) => matchFilter(r, searchLow));

        const mode = settings.sort;
        records.sort((a, b) => {
            if (mode === 'name') return a.title.localeCompare(b.title);
            if (mode === 'category') return getRecordCategory(a).localeCompare(getRecordCategory(b));
            if (mode === 'value') {
                const valA = getRecordValue(a) || 0;
                const valB = getRecordValue(b) || 0;
                return valB - valA;
            }
            const timeA = Number(a.foundAt || 0);
            const timeB = Number(b.foundAt || 0);
            return timeB - timeA;
        });

        return records;
    }

    function renderSummary(records) {
        const summaryEl = panel.querySelector('.tcfs-summary');
        if (!summaryEl) return;

        let totalVal = 0;
        let hasVal = false;
        records.forEach((r) => {
            const v = getRecordValue(r);
            if (v !== null) {
                totalVal += v;
                hasVal = true;
            }
        });

        const isHistory = settings.tab === 'history';
        const countStr = isHistory
            ? `${records.length} past ${records.length === 1 ? 'item' : 'items'}`
            : `${records.length} active ${records.length === 1 ? 'find' : 'finds'}`;
        const valStr = hasVal ? ` &middot; Total Value: <span class="tcfs-pill">${formatMoney(totalVal)}</span>` : '';
        summaryEl.innerHTML = `<div>${countStr}${valStr}</div>`;
    }

    function renderDetailBlock() {
        if (!detailEl) return;
        if (!selectedKey || !historyMap[selectedKey]) {
            detailEl.innerHTML = '';
            detailEl.classList.remove('tcfs-open');
            return;
        }

        const record = historyMap[selectedKey];
        const val = getRecordValue(record);
        const cat = getRecordCategory(record);

        let statusLine = `Seen: ${formatShortTime(record.lastSeenAt)}`;
        if (record.status === 'picked') statusLine = `Collected: ${formatTime(record.pickedAt)}`;
        if (record.status === 'gone') statusLine = `Vanished: ${formatTime(record.goneAt)}`;

        const actionBtn = record.status === 'active' 
            ? `<button type="button" data-action="reveal" title="Hide wrapper box temporarily to allow click-through pickup">Reveal Asset</button>
               <button type="button" data-action="picked" title="Log this item as picked manual">Mark Collected</button>`
            : `<button type="button" data-action="restore" title="Restore back into active tracking metrics">Restore Item</button><div></div>`;

        detailEl.innerHTML = `
            <div>
                <div class="tcfs-detail-name" title="${escapeAttr(record.title)}">${escapeHtml(record.title)}</div>
                <div class="tcfs-detail-meta">
                    ${escapeHtml(cat)} &middot; ${statusLine}
                    <br>${val !== null ? `<span class="tcfs-pill tcfs-teal">${formatMoney(val)}</span>` : '<span class="tcfs-pill">Value unknown</span>'}
                </div>
            </div>
            <div class="tcfs-detail-actions">
                <button type="button" data-action="center" title="Snap city map directly onto these coordinates">Center Camera</button>
                ${actionBtn}
            </div>
        `;
        detailEl.classList.add('tcfs-open');
    }

    function render() {
        if (!panel || !panel.classList.contains('tcfs-open')) return;

        panel.querySelectorAll('[data-tab]').forEach((button) => {
            const active = button.dataset.tab === settings.tab;
            button.classList.toggle('tcfs-active', active);
            button.setAttribute('aria-selected', String(active));
        });

        const searchInput = panel.querySelector('[data-role="search"]');
        if (searchInput && searchInput.value !== settings.search) searchInput.value = settings.search;
        const sortSelect = panel.querySelector('[data-role="sort"]');
        if (sortSelect && sortSelect.value !== settings.sort) sortSelect.value = settings.sort;

        const records = getSortedRecords();
        renderSummary(records);
        renderDetailBlock();

        if (records.length === 0) {
            const emptyText = settings.search
                ? 'No search results found matching filters.'
                : (settings.tab === 'history' ? 'No past items logged yet.' : 'No active finds right now.');
            listEl.innerHTML = `<div class="tcfs-empty">${emptyText}</div>`;
            return;
        }

        listEl.innerHTML = records.map((r) => {
            const isSel = r.key === selectedKey;
            const val = getRecordValue(r);
            const cat = getRecordCategory(r);
            const token = buildRowToken(r.itemId, r.title);

            let subText = escapeHtml(cat);
            if (val !== null) subText += ` &middot; <span class="tcfs-value">${formatMoney(val)}</span>`;
            if (settings.tab === 'history') {
                const statusText = r.status === 'picked' ? 'Collected' : 'Vanished';
                const statusTime = r.status === 'picked' ? r.pickedAt : r.goneAt;
                subText += ` &middot; ${statusText}: ${formatShortTime(statusTime)}`;
            }

            return `
                <div class="tcfs-row ${token ? 'tcfs-has-icon' : ''} ${isSel ? 'tcfs-selected' : ''}" data-key="${escapeAttr(r.key)}" data-action="select" style="cursor:pointer;">
                    ${token}
                    <div class="tcfs-row-main">
                        <div class="tcfs-row-name" title="${escapeAttr(r.title)}">${escapeHtml(r.title)}</div>
                        <div class="tcfs-row-meta">${subText}</div>
                    </div>
                </div>
            `;
        }).join('');

        const selectedRow = listEl.querySelector(`.tcfs-row[data-key="${CSS.escape(selectedKey || '')}"]`);
        if (selectedRow && !isElementInViewport(selectedRow, listEl)) {
            selectedRow.scrollIntoView({ block: 'nearest' });
        }
    }

    function isElementInViewport(el, parent) {
        const e = el.getBoundingClientRect();
        const p = parent.getBoundingClientRect();
        return e.top >= p.top && e.bottom <= p.bottom;
    }

    function updateFabCounter() {
        if (!badge) return;
        const count = visibleActiveItems().length;
        fab.classList.toggle('tcfs-has-items', count > 0);
        badge.setAttribute('aria-label', `${count} active ${count === 1 ? 'find' : 'finds'}`);
        if (count > 0) {
            badge.innerText = count;
            badge.style.display = 'inline-flex';
        } else {
            badge.innerText = '';
            badge.style.display = 'none';
        }

        const status = panel && panel.querySelector('.tcfs-head-status');
        if (status) {
            status.textContent = count > 0
                ? `${count} active ${count === 1 ? 'find' : 'finds'} · ready to collect`
                : 'Scanner ready · no active finds';
        }
    }

    function pulseNewFind(count) {
        if (!fab || !count) return;
        clearTimeout(newFindPulseTimer);
        fab.classList.remove('tcfs-new-find-pulse');
        requestAnimationFrame(() => {
            fab.classList.add('tcfs-new-find-pulse');
            newFindPulseTimer = setTimeout(() => {
                if (fab) fab.classList.remove('tcfs-new-find-pulse');
            }, 2600);
        });
    }

    function clearMarkers() {
        Object.keys(markers).forEach((key) => {
            try {
                markers[key].remove();
            } catch (_) {}
        });
        markers = {};
    }

    function renderMapPins() {
        clearMarkers();
        if (!tornReady()) return;

        const L = getLeaflet();
        const torn = getTorn();
        markerMap = torn.map.lmap;

        activeItems.forEach((item) => {
            const record = historyMap[item.key];
            if (record && record.status === 'picked') return;

            const latLng = getLatLng(item);
            if (!latLng) return;

            const isSel = item.key === selectedKey;
            const labelHtml = escapeHtml(item.title);

            const pinInner = escapeHtml(item.title.slice(0, 2));

            const html = `
                <div class="tcfs-map-pin" data-key="${escapeAttr(item.key)}">
                    <div class="tcfs-map-label">${labelHtml}</div>
                    <div class="tcfs-map-dot" style="
                        border-color: ${isSel ? '#85B200' : 'rgba(255,255,255,0.9)'}; 
                        box-shadow: ${isSel ? '0 0 14px #85B200' : '0 3px 11px rgba(0,0,0,0.46)'};
                    ">
                        ${pinInner}
                    </div>
                    <div class="tcfs-map-tail"></div>
                </div>
            `;

            try {
                const icon = L.divIcon({
                    html: html,
                    className: 'tcfs-map-icon',
                    iconSize: [72, 64],
                    iconAnchor: [36, 64]
                });

                const marker = L.marker(latLng, { icon: icon, zIndexOffset: isSel ? 30000 : 20000 });
                marker.addTo(torn.map.lmap);
                markers[item.key] = marker;
            } catch (_) {}
        });

        const container = getTorn().map.lmap.getPane('markerPane');
        if (container && !container.dataset.tcfsManaged) {
            container.dataset.tcfsManaged = 'true';
            container.addEventListener('click', (event) => {
                const pin = event.target.closest('.tcfs-map-pin');
                if (!pin) return;

                event.stopPropagation();
                const key = pin.dataset.key;
                if (key && historyMap[key]) {
                    selectedKey = key;
                    if (!panel.classList.contains('tcfs-open')) togglePanel(true);
                    render();
                    renderMapPins();
                }
            });
        }
        lastRenderedItemSignature = markerSignature();
    }

    function syncNow(explicitManual) {
        if (!tornReady()) {
            if (explicitManual) showToast('Torn city map system is not fully initialized yet.');
            return;
        }

        const freshItems = getPageItems();
        const hadTrackedActiveItems = activeItems.length > 0 || Object.values(historyMap).some((record) => record.status === 'active');

        if (freshItems.length === 0 && hadTrackedActiveItems) {
            consecutiveEmptyScans++;
            if (consecutiveEmptyScans < EMPTY_SCAN_CONFIRMATIONS) {
                if (explicitManual) showToast('Map item data is temporarily empty. Waiting for confirmation before changing history.');
                return;
            }
        } else {
            consecutiveEmptyScans = 0;
        }

        activeItems = freshItems;

        const newCount = updateHistory(freshItems, true);
        updateFabCounter();
        pulseNewFind(newCount);
        if (getTorn().map.lmap !== markerMap || markerSignature() !== lastRenderedItemSignature) renderMapPins();
        render();

        if (settings.apiEnabled && settings.apiKey &&
            Date.now() - itemMetaFetchedAt >= METADATA_CACHE_MAX_AGE_MS) {
            fetchItemMetadata(false);
        }

        if (explicitManual) showToast(`Scan complete. Found ${freshItems.length} active loot target coordinates.`);
    }

    function fetchItemMetadata(force) {
        if (!settings.apiEnabled || !settings.apiKey) {
            metaStatus = 'Off';
            renderSettings();
            return;
        }
        if (busyMeta) return;

        const now = Date.now();
        if (!force && (now - itemMetaFetchedAt < METADATA_CACHE_MAX_AGE_MS)) {
            metaStatus = 'Cached';
            return;
        }
        if (!force && now < nextMetadataAttemptAt) return;

        busyMeta = true;
        nextMetadataAttemptAt = now + METADATA_RETRY_MS;
        metaStatus = 'Syncing...';
        renderSettings();

        if (typeof GM_xmlhttpRequest !== 'function') {
            busyMeta = false;
            metaStatus = 'No Grant';
            renderSettings();
            return;
        }

        GM_xmlhttpRequest({
            method: 'GET',
            url: `https://api.torn.com/torn/?selections=items&key=${settings.apiKey}`,
            responseType: 'json',
            timeout: 10000,
            onload(res) {
                busyMeta = false;
                try {
                    const data = res.response || JSON.parse(res.responseText);
                    if (data && data.items && typeof data.items === 'object') {
                        const parsedMeta = {};
                        Object.keys(data.items).forEach((id) => {
                            const info = data.items[id];
                            parsedMeta[String(id)] = {
                                name: cleanText(info.name || ''),
                                category: cleanText(info.type || 'Unknown'),
                                value: Math.max(0, parseInt(info.market_value, 10) || 0)
                            };
                        });

                        itemMeta = parsedMeta;
                        itemMetaFetchedAt = Date.now();
                        nextMetadataAttemptAt = itemMetaFetchedAt + METADATA_CACHE_MAX_AGE_MS;
                        metaStatus = 'Cached';

                        STORE.set('itemMeta', itemMeta);
                        STORE.set('itemMetaFetchedAt', itemMetaFetchedAt);

                        showToast('Market metadata successfully synced with Torn Public API.');
                        syncNow(false);
                    } else if (data && data.error && typeof data.error === 'object') {
                        const errorCode = Number(data.error.code);
                        metaStatus = 'API Error ' + (data.error.code || '?');
                        if (errorCode === 2) {
                            settings.apiKey = '';
                            settings.apiEnabled = false;
                            saveSettings();
                            metaStatus = 'Invalid Key';
                        } else if (errorCode === 13 || errorCode === 18) {
                            settings.apiEnabled = false;
                            saveSettings();
                        }
                        showToast(`API sync warning: ${data.error.error || 'Unknown error code'}`);
                    } else {
                        metaStatus = 'Bad Format';
                    }
                } catch (_) {
                    metaStatus = 'Parse Fail';
                }
                renderSettings();
            },
            onerror() {
                busyMeta = false;
                metaStatus = 'Net Error';
                renderSettings();
            },
            ontimeout() {
                busyMeta = false;
                metaStatus = 'Timeout';
                renderSettings();
            }
        });
    }

    function initLoop() {
        buildUI();
        if (settings.apiEnabled && (!itemMetaFetchedAt || Date.now() - itemMetaFetchedAt > METADATA_CACHE_MAX_AGE_MS)) {
            fetchItemMetadata(false);
        }

        clearInterval(syncTimer);
        syncNow(false);
        syncTimer = setInterval(() => {
            syncNow(false);
        }, POLL_MS);
    }

    function tryStart() {
        if (document.body && tornReady()) {
            initLoop();
            return true;
        }
        return false;
    }

    if (!tryStart()) {
        const startObserver = new MutationObserver((mutations, obs) => {
            if (tryStart()) obs.disconnect();
        });
        startObserver.observe(document.documentElement, { childList: true, subtree: true });
    }
})();
