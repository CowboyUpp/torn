// ==UserScript==
// @name         Torn City Safe Finder
// @namespace    https://github.com/CowboyUpp/torn
// @version      1.1.0
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
// @downloadURL  https://update.greasyfork.org/scripts/583629/Torn%20City%20Safe%20Finder.user.js
// @updateURL    https://update.greasyfork.org/scripts/583629/Torn%20City%20Safe%20Finder.meta.js
// ==/UserScript==

(function () {
    'use strict';

    const VERSION = '1.1.0';
    const STORE_PREFIX = 'tcfs_';
    const POLL_MS = 1800;
    const REVEAL_MS = 10000;
    const PICKUP_ZOOM = 6;
    const METADATA_CACHE_MAX_AGE_MS = 12 * 60 * 60 * 1000;

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
            try {
                if (typeof GM_setValue === 'function') GM_setValue(STORE_PREFIX + key, value);
            } catch (_) {}

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

    function updateHistory(items) {
        const now = Date.now();
        const activeKeys = new Set(items.map((item) => item.key));
        let changed = false;

        items.forEach((item) => {
            const enriched = enrichItem(item);
            const existing = historyMap[item.key];

            if (!existing) {
                historyMap[item.key] = makeRecord(item, now);
                changed = true;
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
            changed = true;
        });

        Object.keys(historyMap).forEach((key) => {
            const record = historyMap[key];
            if (record.status === 'active' && !activeKeys.has(key)) {
                record.status = 'gone';
                record.goneAt = now;
                changed = true;
            }
        });

        if (changed) saveHistory();
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
                display: flex;
                align-items: center;
                gap: 10px;
                padding: 10px 16px;
                
                /* Gritty Steel Texturing & Industrial Bevel System */
                background: linear-gradient(135deg, #444444 0%, #2b2b2b 50%, #1f1f1f 100%);
                border: 2px solid #555555;
                border-top-color: #777777;
                border-left-color: #666666;
                border-bottom-color: #333333;
                border-right-color: #444444;
                border-radius: 6px;
                
                /* Heavy Dimensional Drop Shadows */
                box-shadow: 
                    inset 0 1px 0px rgba(255,255,255,0.15),
                    inset 0 -1px 3px rgba(0,0,0,0.6),
                    0 4px 12px rgba(0, 0, 0, 0.65),
                    0 0 1px rgba(0,0,0,0.9);
                
                cursor: pointer;
                user-select: none;
                touch-action: none;
                font-family: "Helvetica Neue", Helvetica, Arial, sans-serif;
            }
            #tcfs-fab .cfc-icon {
                display: flex;
                align-items: center;
                justify-content: center;
                opacity: 0.8;
                transition: transform 0.2s ease, opacity 0.2s ease;
            }
            #tcfs-fab .cfc-label {
                color: #d1c7bd;
                font-size: 13px;
                font-weight: 700;
                text-transform: uppercase;
                letter-spacing: 0.5px;
                text-shadow: 1px 1px 2px rgba(0, 0, 0, 0.9);
            }
            #tcfs-fab .tcfs-badge {
                background-color: #1a1a1a;
                color: #85B200; /* Torn Safe Green Accent */
                font-size: 11px;
                font-weight: bold;
                padding: 2px 6px;
                border-radius: 3px;
                border: 1px solid #333333;
                box-shadow: inset 0 1px 3px rgba(0,0,0,0.8);
                display: none;
            }
            #tcfs-fab:hover {
                background: linear-gradient(135deg, #555555 0%, #363636 50%, #262626 100%);
                border-color: #777777;
                border-top-color: #999999;
                border-left-color: #888888;
                box-shadow: 
                    inset 0 1px 0px rgba(255,255,255,0.25),
                    inset 0 -1px 3px rgba(0,0,0,0.5),
                    0 6px 14px rgba(0, 0, 0, 0.75),
                    0 0 4px rgba(255, 184, 71, 0.15);
            }
            #tcfs-fab:hover .cfc-label {
                color: #fff3e3;
            }
            #tcfs-fab:hover .cfc-icon {
                opacity: 1;
                transform: scale(1.05);
            }
            #tcfs-fab:active {
                background: linear-gradient(135deg, #222222 0%, #1f1f1f 100%);
                box-shadow: 
                    inset 0 2px 4px rgba(0,0,0,0.8),
                    0 2px 5px rgba(0, 0, 0, 0.5);
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
            .tcfs-tools select { width: 116px; padding: 0 6px; }
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
        fab.title = 'City items';
        
        // Formatted Option 1 inner element setup (incorporating standard map loot abstract inline vectors)
        fab.innerHTML = `
            <div class="cfc-icon">
                <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="#d1c7bd" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round">
                    <path d="M2 22 18 6M16 4l4 4M19 3l1.5 1.5M14 2l8 8" />
                    <path d="M12 11a4 4 0 1 1-8 0 4 4 0 0 1 8 0Z" fill="rgba(0,0,0,0.3)" />
                </svg>
            </div>
            <div class="cfc-label">City Find Collect</div>
            <span class="tcfs-badge"></span>
        `;
        document.body.appendChild(fab);
        badge = fab.querySelector('.tcfs-badge');

        panel = document.createElement('div');
        panel.id = 'tcfs-panel';
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
            settings.fabX == null ? window.innerWidth - 220 : settings.fabX,
            settings.fabY == null ? window.innerHeight - 80 : settings.fabY
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
            const rect = fab.getBoundingClientRect();
            placeFab(rect.left, rect.top);
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
        showToast('API key locally saved.');
        fetchItemMetadata(true);
    }

    function togglePanel(forceOpen) {
        const next = forceOpen === undefined ? !panel.classList.contains('tcfs-open') : Boolean(forceOpen);
        if (next) {
            panel.classList.add('tcfs-open');
            anchorPanel();
        } else {
            panel.classList.remove('tcfs-open');
        }
        settings.panelOpen = next;
        saveSettings();
    }

    function placeFab(left, top) {
        if (!fab) return;
        const pad = 10;
        const w = fab.offsetWidth || 150;
        const h = fab.offsetHeight || 38;

        const x = Math.max(pad, Math.min(window.innerWidth - w - pad, left));
        const y = Math.max(pad, Math.min(window.innerHeight - h - pad, top));

        fab.style.left = x + 'px';
        fab.style.top = y + 'px';

        settings.fabX = x;
        settings.fabY = y;
        saveSettings();
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
        let startX = 0;
        let startY = 0;
        let moveX = 0;
        let moveY = 0;

        fab.addEventListener('mousedown', onStart);
        fab.addEventListener('touchstart', onStart, { passive: false });

        function onStart(event) {
            if (event.button && event.button !== 0) return;
            const clientX = event.touches ? event.touches[0].clientX : event.clientX;
            const clientY = event.touches ? event.touches[0].clientY : event.clientY;

            dragging = false;
            const rect = fab.getBoundingClientRect();
            startX = clientX - rect.left;
            startY = clientY - rect.top;

            window.addEventListener('mousemove', onMove);
            window.addEventListener('mouseup', onEnd);
            window.addEventListener('touchmove', onMove, { passive: false });
            window.addEventListener('touchend', onEnd);
        }

        function onMove(event) {
            const clientX = event.touches ? event.touches[0].clientX : event.clientX;
            const clientY = event.touches ? event.touches[0].clientY : event.clientY;

            if (!dragging) {
                dragging = true;
                if (event.cancelable) event.preventDefault();
            }

            moveX = clientX - startX;
            moveY = clientY - startY;
            placeFab(moveX, moveY);
        }

        function onEnd() {
            window.removeEventListener('mousemove', onMove);
            window.removeEventListener('mouseup', onEnd);
            window.removeEventListener('touchmove', onMove);
            window.removeEventListener('touchend', onEnd);

            if (!dragging) {
                togglePanel();
            } else if (panel.classList.contains('tcfs-open')) {
                anchorPanel();
            }
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
        toast.innerHTML = cleanText(message);
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
        showToast(`Logged "${escapeHtml(record.title)}" as manually collected.`);
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

        showToast(`Restored "${escapeHtml(record.title)}" to active trackers.`);
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
        if (count > 0) {
            badge.innerText = count;
            badge.style.display = 'block';
        } else {
            badge.style.display = 'none';
        }
    }

    function clearMarkers() {
        const L = getLeaflet();
        const torn = getTorn();
        if (!L || !torn || !torn.map || !torn.map.lmap) return;

        Object.keys(markers).forEach((key) => {
            try {
                markers[key].removeFrom(torn.map.lmap);
            } catch (_) {}
        });
        markers = {};
    }

    function renderMapPins() {
        clearMarkers();
        if (!tornReady()) return;

        const L = getLeaflet();
        const torn = getTorn();
        const now = Date.now();

        activeItems.forEach((item) => {
            const record = historyMap[item.key];
            if (record && record.status === 'picked') return;

            const latLng = getLatLng(item);
            if (!latLng) return;

            const isSel = item.key === selectedKey;
            const meta = metadataFor(item.itemId);
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
    }

    function syncNow(explicitManual) {
        if (!tornReady()) {
            if (explicitManual) showToast('Torn city map system is not fully initialized yet.');
            return;
        }

        const freshItems = getPageItems();
        activeItems = freshItems;

        updateHistory(freshItems);
        updateFabCounter();
        renderMapPins();
        render();

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

        busyMeta = true;
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
                        metaStatus = 'Cached';

                        STORE.set('itemMeta', itemMeta);
                        STORE.set('itemMetaFetchedAt', itemMetaFetchedAt);

                        showToast('Market metadata successfully synced with Torn Public API.');
                        syncNow(false);
                    } else if (data && data.error && typeof data.error === 'object') {
                        metaStatus = 'API Error ' + (data.error.code || '?');
                        showToast(`API sync warning: ${escapeHtml(data.error.error || 'Unknown error code')}`);
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

    const startObserver = new MutationObserver((mutations, obs) => {
        if (document.body && tornReady()) {
            initLoop();
            obs.disconnect();
        }
    });
    startObserver.observe(document.documentElement, { childList: true, subtree: true });
})();
