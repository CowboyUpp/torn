// ==UserScript==
// @name         Torn City Map Finder
// @namespace    https://github.com/CowboyUpp/torn
// @version      1.1.4
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
// @downloadURL none
// @updateURL   none
// ==/UserScript==

(function () {
    'use strict';

    const VERSION = '1.1.4';
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

        items.forEach((item) => {
            const enriched = enrichItem(item);
            const existing = historyMap[item.key];

            if (!existing) {
                historyMap[item.key] = makeRecord(item, now);
                dirty = true;
                persistImmediately = true;
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
            @media (hover: none) {
                #tcfs-fab:hover:not(.tcfs-open) {
                    width: 46px;
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
        fab.title = 'City Finds';
        fab.setAttribute('aria-label', 'Open City Finds');
        fab.setAttribute('aria-controls', 'tcfs-panel');
        fab.setAttribute('aria-expanded', 'false');
        
        fab.innerHTML = `
            <div class="cfc-icon">
                <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">
                    <path d="M18 10c0 4.7-6 10.5-6 10.5S6 14.7 6 10a6 6 0 1 1 12 0Z" />
                    <circle cx="12" cy="10" r="2.25" />
                </svg>
            </div>
            <span class="cfc-label">City Finds</span>
            <span class="tcfs-badge" aria-label="0 active finds"></span>
        `;
        document.body.appendChild(fab);
        badge = fab.querySelector('.tcfs-badge');

        panel = document.createElement('div');
        panel.id = 'tcfs-panel';
        panel.setAttribute('role', 'dialog');
        panel.setAttribute('aria-label', 'City Finds');
        panel.innerHTML = `
            <div class="tcfs-head">
                <div class="tcfs-title">City Finder <span>v${VERSION}</span></div>
                <button class="tcfs-iconbtn" type="button" data-action="settings" title="Settings">&#9881;</button>
                <button class="tcfs-iconbtn" type="button" data-action="refresh" title="Refresh">&#8635;</button>
                <button class="tcfs-iconbtn" type="button" data-action="close" title="Close">x</button>
            </div>
            <div class="tcfs-settings"></div>
            <div class="tcfs-tabs">
                <button type="button" data-tab="active">Active</button>
                <button type="button" data-tab="history">History</button>
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

        makeFabDraggable();
        placeFab(
            settings.fabX == null ? window.innerWidth - 62 : settings.fabX,
            settings.fabY == null ? window.innerHeight - 80 : settings.fabY,
            true
        );

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

        window.addEventListener('resize', () => {
            placeFab(settings.fabX, settings.fabY, true);
            if (panel.classList.contains('tcfs-open')) anchorPanel();
        });

        renderSettings();
        render();

        if (settings.panelOpen) togglePanel(true);
    }

    function onPanelClick(event) {
        const tab = event.target.closest('[data-tab]');
        if (tab) {
            settings.tab = tab.dataset.tab;
            saveSettings();
            render();
            return;
        }

        const actionEl = event.target.closest('[data-action]');
        if (!actionEl) return;

        const action = actionEl.dataset.action;
        const key = actionEl.closest('[data-key]') ? actionEl.closest('[data-key]').dataset.key : selectedKey;

        if (action === 'settings') {
            settingsEl.classList.toggle('tcfs-open');
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
        if (action === 'clear-history') {
            clearGoneHistory();
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

    function renderSettings() {
        if (!settingsEl) return;

        settingsEl.innerHTML = `
            <div class="tcfs-setting-row">
                <label>
                    <input type="checkbox" data-setting="showImages" ${settings.showImages ? 'checked' : ''}>
                    Show item images in list
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
            <div class="tcfs-setting-row">
                <label style="flex: initial;">Max history logs:</label>
                <select data-setting="historyLimit" style="width: 80px; height:26px; padding:0 3px;">
                    <option value="100" ${Number(settings.historyLimit) === 100 ? 'selected' : ''}>100</option>
                    <option value="250" ${Number(settings.historyLimit) === 250 ? 'selected' : ''}>250</option>
                    <option value="500" ${Number(settings.historyLimit) === 500 ? 'selected' : ''}>500</option>
                    <option value="1000" ${Number(settings.historyLimit) === 1000 ? 'selected' : ''}>1000</option>
                </select>
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
                if (name === 'showImages') renderMapPins();
                render();
            });
        });

        settingsEl.querySelector('select[data-setting="historyLimit"]').addEventListener('change', (event) => {
            settings.historyLimit = Math.max(50, parseInt(event.target.value, 10) || 500);
            saveSettings();
            trimHistory();
            saveHistory();
            render();
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
        }
        settings.panelOpen = next;
        saveSettings();
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
        return `https://www.torn.com/images/items/${itemId}/medium.png`;
    }

    function buildRowToken(itemId, title) {
        if (settings.showImages && itemId) {
            return `<img src="${getImageUrl(itemId)}" alt="Item" loading="lazy">`;
        }
        const token = cleanText(title).slice(0, 2);
        return `<div class="tcfs-token">${escapeHtml(token)}</div>`;
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
        const records = Object.values(historyMap).filter((r) => {
            if (settings.tab === 'active') return r.status === 'active';
            return r.status === 'gone' || r.status === 'picked';
        }).filter((r) => matchFilter(r, searchLow));

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

        const countStr = `${records.length} ${settings.tab === 'active' ? 'active lookups' : 'logged tracks'}`;
        const valStr = hasVal ? ` &middot; Total Value: <span class="tcfs-pill">${formatMoney(totalVal)}</span>` : '';
        const clearBtn = settings.tab === 'history' && records.length > 0 ? `<button class="tcfs-smallbtn" type="button" data-action="clear-history" style="margin-left:auto; height:24px; padding:0 6px;">Clear Archive</button>` : '';

        summaryEl.innerHTML = `<div>${countStr}${valStr}</div>${clearBtn}`;
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
            ${buildRowToken(record.itemId, record.title)}
            <div>
                <div class="tcfs-detail-name" title="${escapeAttr(record.title)}">${escapeHtml(record.title)}</div>
                <div class="tcfs-detail-meta">
                    Loc: [${record.x}, ${record.y}] &middot; ${escapeHtml(cat)}
                    <br>${val !== null ? `<span class="tcfs-pill tcfs-teal">${formatMoney(val)}</span>` : '<span class="tcfs-pill">Value unknown</span>'} &middot; ${statusLine}
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

        panel.querySelectorAll('[data-tab]').forEach((btn) => {
            btn.classList.toggle('tcfs-active', btn.dataset.tab === settings.tab);
        });

        const searchInput = panel.querySelector('[data-role="search"]');
        if (searchInput && searchInput.value !== settings.search) searchInput.value = settings.search;
        const sortSelect = panel.querySelector('[data-role="sort"]');
        if (sortSelect && sortSelect.value !== settings.sort) sortSelect.value = settings.sort;

        const records = getSortedRecords();
        renderSummary(records);
        renderDetailBlock();

        if (records.length === 0) {
            listEl.innerHTML = `<div class="tcfs-empty">${settings.search ? 'No search results found matching filters.' : 'No tracked item context matching this category.'}</div>`;
            return;
        }

        listEl.innerHTML = records.map((r) => {
            const isSel = r.key === selectedKey;
            const val = getRecordValue(r);
            const cat = getRecordCategory(r);

            let subText = `[${r.x}, ${r.y}] &middot; ${escapeHtml(cat)}`;
            if (val !== null) subText += ` &middot; <span style="color:#ffe1a0; font-weight:700;">${formatMoney(val)}</span>`;

            return `
                <div class="tcfs-row ${isSel ? 'tcfs-selected' : ''}" data-key="${escapeAttr(r.key)}" data-action="select" style="cursor:pointer;">
                    ${buildRowToken(r.itemId, r.title)}
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

            let pinInner = escapeHtml(item.title.slice(0, 2));
            if (settings.showImages && item.itemId) {
                pinInner = `<img src="${getImageUrl(item.itemId)}" alt="Pin" loading="lazy">`;
            }

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

        updateHistory(freshItems, true);
        updateFabCounter();
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
