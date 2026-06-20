// ==UserScript==
// @name         Torn City Safe Finder
// @namespace    https://github.com/CowboyUpp/torn
// @version      1.0.0
// @description  Safety-first city item helper: map pins, floating item window, local history, optional Public API values, and no automated pickup.
// @author       CowboyUpp
// @match        https://www.torn.com/city.php*
// @match        https://*.torn.com/city.php*
// @run-at       document-idle
// @license      MIT; https://opensource.org/licenses/MIT
// @grant        GM_getValue
// @grant        GM_setValue
// @grant        GM_xmlhttpRequest
// @grant        unsafeWindow
// @connect      api.torn.com
// ==/UserScript==

(function () {
    'use strict';

    const VERSION = '1.0.0';
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
                width: 52px;
                height: 52px;
                border: 1px solid rgba(255,255,255,.22);
                border-radius: 50%;
                background: radial-gradient(circle at 34% 28%, #ffe5a3 0%, #d09b39 32%, #2f2118 100%);
                color: #fff8db;
                box-shadow: 0 8px 24px rgba(0,0,0,.44);
                cursor: pointer;
                z-index: 2147483000;
                display: flex;
                align-items: center;
                justify-content: center;
                user-select: none;
                touch-action: none;
                font: 800 14px/1 Arial, sans-serif;
            }
            #tcfs-fab .tcfs-badge {
                position: absolute;
                top: -4px;
                right: -4px;
                min-width: 18px;
                height: 18px;
                padding: 0 4px;
                border-radius: 9px;
                background: #d9534f;
                color: #fff;
                font-size: 11px;
                line-height: 18px;
                text-align: center;
                box-shadow: 0 2px 7px rgba(0,0,0,.38);
                display: none;
                box-sizing: border-box;
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
        fab.innerHTML = '<span>CF</span><span class="tcfs-badge"></span>';
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
            settings.fabX == null ? window.innerWidth - 70 : settings.fabX,
            settings.fabY == null ? window.innerHeight - 150 : settings.fabY
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
                    Show item images
                </label>
                <button class="tcfs-smallbtn" type="button" data-action="clear-history">Clear old</button>
            </div>
            <div class="tcfs-setting-note">Image mode may load Torn item assets. Leave it off for the strictest no-extra-asset setup.</div>
            <div class="tcfs-setting-row">
                <label>
                    <input type="checkbox" data-setting="apiEnabled" ${settings.apiEnabled ? 'checked' : ''}>
                    Use Public API values/categories
                </label>
                <button class="tcfs-smallbtn" type="button" data-action="open-api">Open key page</button>
            </div>
            <div class="tcfs-setting-row">
                <input type="password" data-setting="apiKey" placeholder="Public API key" value="${escapeAttr(settings.apiKey)}" autocomplete="off" spellcheck="false">
                <button class="tcfs-smallbtn" type="button" data-action="save-api">Save</button>
                <button class="tcfs-smallbtn" type="button" data-action="refresh-meta">Refresh</button>
            </div>
            <div class="tcfs-setting-note">Use a Public key from Torn's API preferences. Stored locally only. Metadata: ${escapeHtml(metaStatus)}.</div>
        `;

        settingsEl.querySelectorAll('[data-setting="showImages"], [data-setting="apiEnabled"]').forEach((input) => {
            input.addEventListener('change', () => {
                const settingName = input.dataset.setting;
                settings[input.dataset.setting] = input.checked;
                saveSettings();
                renderSettings();
                if (settingName === 'showImages') clearMarkers();
                syncMarkers(visibleActiveItems());
                render();
                if (settingName === 'apiEnabled' && input.checked) fetchItemMetadata(false);
            });
        });
    }

    function saveApiSettings() {
        const keyInput = settingsEl.querySelector('[data-setting="apiKey"]');
        settings.apiKey = cleanText(keyInput ? keyInput.value : '').replace(/\s+/g, '');
        settings.apiEnabled = Boolean(settings.apiKey) && settings.apiEnabled;
        saveSettings();
        renderSettings();

        if (!settings.apiKey) {
            metaStatus = 'Off';
            toast('API key cleared');
            render();
            return;
        }

        if (!settings.apiEnabled) {
            settings.apiEnabled = true;
            saveSettings();
            renderSettings();
        }

        fetchItemMetadata(true);
    }

    function makeFabDraggable() {
        let dragging = false;
        let moved = false;
        let offsetX = 0;
        let offsetY = 0;
        let startX = 0;
        let startY = 0;

        fab.addEventListener('pointerdown', (event) => {
            dragging = true;
            moved = false;
            startX = event.clientX;
            startY = event.clientY;
            const rect = fab.getBoundingClientRect();
            offsetX = event.clientX - rect.left;
            offsetY = event.clientY - rect.top;
            fab.setPointerCapture(event.pointerId);
            event.preventDefault();
        });

        fab.addEventListener('pointermove', (event) => {
            if (!dragging) return;
            if (Math.abs(event.clientX - startX) > 5 || Math.abs(event.clientY - startY) > 5) moved = true;
            placeFab(event.clientX - offsetX, event.clientY - offsetY);
        });

        fab.addEventListener('pointerup', (event) => {
            if (!dragging) return;
            dragging = false;
            try {
                fab.releasePointerCapture(event.pointerId);
            } catch (_) {}

            if (moved) {
                const rect = fab.getBoundingClientRect();
                settings.fabX = rect.left;
                settings.fabY = rect.top;
                saveSettings();
                if (panel.classList.contains('tcfs-open')) anchorPanel();
            } else {
                togglePanel();
            }
        });
    }

    function placeFab(x, y) {
        const left = Math.max(6, Math.min(Number(x) || 6, window.innerWidth - 58));
        const top = Math.max(6, Math.min(Number(y) || 6, window.innerHeight - 58));
        fab.style.left = left + 'px';
        fab.style.top = top + 'px';
    }

    function togglePanel(force) {
        const open = force === undefined ? !panel.classList.contains('tcfs-open') : Boolean(force);
        panel.classList.toggle('tcfs-open', open);
        settings.panelOpen = open;
        saveSettings();

        if (open) {
            anchorPanel();
            syncNow(true);
        }
    }

    function anchorPanel() {
        const rect = fab.getBoundingClientRect();
        const width = Math.min(380, window.innerWidth - 20);
        let left = rect.left + rect.width / 2 - width / 2;
        left = Math.max(10, Math.min(left, window.innerWidth - width - 10));
        panel.style.width = width + 'px';
        panel.style.left = left + 'px';

        if (rect.top > window.innerHeight / 2) {
            panel.style.bottom = (window.innerHeight - rect.top + 10) + 'px';
            panel.style.top = 'auto';
        } else {
            panel.style.top = (rect.bottom + 10) + 'px';
            panel.style.bottom = 'auto';
        }
    }

    function markerHtml(item) {
        const label = escapeHtml(item.title);
        const body = settings.showImages && item.itemId
            ? `<img src="https://www.torn.com/images/items/${encodeURIComponent(item.itemId)}/small.png" alt="">`
            : escapeHtml(initials(item.title));

        return `
            <div class="tcfs-map-pin" title="${escapeAttr(item.title)}">
                <div class="tcfs-map-label">${label}</div>
                <div class="tcfs-map-dot">${body}</div>
                <div class="tcfs-map-tail"></div>
            </div>
        `;
    }

    function initials(title) {
        const words = cleanText(title).split(/\s+/).filter(Boolean);
        const letters = words.length > 1 ? words[0][0] + words[1][0] : cleanText(title).slice(0, 2);
        return (letters || 'IT').toUpperCase();
    }

    function itemVisual(record) {
        if (settings.showImages && record.itemId) {
            return `<img src="https://www.torn.com/images/items/${encodeURIComponent(record.itemId)}/small.png" alt="">`;
        }
        return `<div class="tcfs-token">${escapeHtml(initials(record.title))}</div>`;
    }

    function syncMarkers(items) {
        if (!tornReady()) return;
        const L = getLeaflet();
        const map = getTorn().map.lmap;
        const visibleKeys = new Set(items.map((item) => item.key));

        items.forEach((item) => {
            if (markers[item.key]) return;
            const latLng = getLatLng(item);
            if (!latLng) return;

            const icon = L.divIcon({
                className: 'tcfs-map-icon',
                html: markerHtml(item),
                iconSize: [72, 64],
                iconAnchor: [36, 62]
            });

            const marker = L.marker(latLng, {
                icon,
                interactive: true,
                keyboard: false,
                zIndexOffset: 900000
            }).addTo(map);

            marker.on('click', (event) => {
                try {
                    if (event && event.originalEvent) {
                        event.originalEvent.preventDefault();
                        event.originalEvent.stopPropagation();
                    }
                } catch (_) {}

                selectedKey = item.key;
                settings.tab = 'active';
                saveSettings();
                togglePanel(true);
                render();
            });

            markers[item.key] = marker;
        });

        Object.keys(markers).forEach((key) => {
            if (!visibleKeys.has(key)) removeMarker(key);
        });
    }

    function removeMarker(key) {
        if (!markers[key]) return;
        try {
            getTorn().map.lmap.removeLayer(markers[key]);
        } catch (_) {}
        delete markers[key];
    }

    function clearMarkers() {
        Object.keys(markers).forEach(removeMarker);
    }

    function setMarkersHidden(hidden) {
        Object.values(markers).forEach((marker) => {
            try {
                const el = marker.getElement && marker.getElement();
                if (!el) return;
                if (hidden) {
                    el.dataset.tcfsOldDisplay = el.style.display || '';
                    el.style.setProperty('display', 'none', 'important');
                    el.style.setProperty('pointer-events', 'none', 'important');
                } else {
                    el.style.display = el.dataset.tcfsOldDisplay || '';
                    el.style.removeProperty('pointer-events');
                    delete el.dataset.tcfsOldDisplay;
                }
            } catch (_) {}
        });
    }

    function centerItemByKey(key, zoomIn) {
        const item = activeItems.find((entry) => entry.key === key) || historyMap[key];
        if (!item || !tornReady()) {
            toast('Item is not available on the map right now');
            return;
        }

        const latLng = getLatLng(item);
        if (!latLng) {
            toast('Could not locate this item on the map');
            return;
        }

        try {
            const map = getTorn().map.lmap;
            const zoom = zoomIn ? Math.max(map.getZoom(), PICKUP_ZOOM) : map.getZoom();
            map.setView(latLng, zoom, { animate: true });
        } catch (_) {
            toast('Map move failed');
        }
    }

    function revealForManualPickup(key) {
        if (!key) return;
        centerItemByKey(key, true);
        setMarkersHidden(true);
        clearTimeout(revealTimer);
        revealTimer = setTimeout(() => setMarkersHidden(false), REVEAL_MS);
        toast('Marker hidden. Click the original Torn item on the map.');
    }

    function markPicked(key) {
        if (!key || !historyMap[key]) return;
        historyMap[key].status = 'picked';
        historyMap[key].pickedAt = Date.now();
        historyMap[key].goneAt = historyMap[key].goneAt || Date.now();
        saveHistory();
        removeMarker(key);
        if (selectedKey === key) selectedKey = null;
        render();
        updateBadge();
        toast('Marked as picked');
    }

    function restoreRecord(key) {
        if (!key || !historyMap[key]) return;
        historyMap[key].status = 'gone';
        historyMap[key].pickedAt = null;
        saveHistory();
        render();
        syncMarkers(visibleActiveItems());
    }

    function clearGoneHistory() {
        Object.keys(historyMap).forEach((key) => {
            if (historyMap[key].status !== 'active') delete historyMap[key];
        });
        saveHistory();
        selectedKey = selectedKey && historyMap[selectedKey] ? selectedKey : null;
        render();
        toast('Old history cleared');
    }

    function sortedRecords(records) {
        const query = cleanText(settings.search).toLowerCase();
        const filtered = query
            ? records.filter((record) => {
                const haystack = [record.title, getRecordCategory(record), record.itemId].join(' ').toLowerCase();
                return haystack.includes(query);
            })
            : records.slice();

        filtered.sort((a, b) => {
            if (settings.sort === 'value') {
                const av = getRecordValue(a);
                const bv = getRecordValue(b);
                if (av == null && bv == null) return Number(b.foundAt || 0) - Number(a.foundAt || 0);
                if (av == null) return 1;
                if (bv == null) return -1;
                return bv - av;
            }
            if (settings.sort === 'category') {
                const ac = getRecordCategory(a);
                const bc = getRecordCategory(b);
                return ac.localeCompare(bc) || cleanText(a.title).localeCompare(cleanText(b.title));
            }
            if (settings.sort === 'name') {
                return cleanText(a.title).localeCompare(cleanText(b.title));
            }
            return Number(b.foundAt || 0) - Number(a.foundAt || 0);
        });

        return filtered;
    }

    function render() {
        if (!panel || !listEl) return;

        const active = visibleActiveItems().map(enrichItem);
        const records = settings.tab === 'active'
            ? active.map((item) => historyMap[item.key] || makeRecord(item, Date.now()))
            : Object.values(historyMap);

        panel.querySelectorAll('[data-tab]').forEach((button) => {
            button.classList.toggle('tcfs-active', button.dataset.tab === settings.tab);
        });

        const searchInput = panel.querySelector('[data-role="search"]');
        if (searchInput && document.activeElement !== searchInput) searchInput.value = settings.search || '';
        const sortSelect = panel.querySelector('[data-role="sort"]');
        if (sortSelect) sortSelect.value = settings.sort || 'date';

        renderSummary(active);
        renderSelected();

        const sorted = sortedRecords(records);
        if (!sorted.length) {
            listEl.innerHTML = `<div class="tcfs-empty">${settings.tab === 'active' ? 'No city items visible right now.' : 'No item history yet.'}</div>`;
            return;
        }

        listEl.innerHTML = sorted.map((record) => rowHtml(record)).join('');
    }

    function renderSummary(active) {
        const summary = panel.querySelector('.tcfs-summary');
        const activeCount = active.length;
        const historyCount = Object.keys(historyMap).length;
        const valued = active.map(getRecordValue).filter((value) => typeof value === 'number');
        const total = valued.length ? valued.reduce((sum, value) => sum + value, 0) : null;

        summary.innerHTML = `
            <span class="tcfs-pill">${activeCount} active</span>
            <span class="tcfs-pill tcfs-teal">${historyCount} logged</span>
            <span>${formatMoney(total)}</span>
            <span style="margin-left:auto">${escapeHtml(metaStatus)}</span>
        `;
    }

    function renderSelected() {
        const record = selectedKey ? historyMap[selectedKey] : null;
        if (!record) {
            detailEl.classList.remove('tcfs-open');
            detailEl.innerHTML = '';
            return;
        }

        detailEl.classList.add('tcfs-open');
        detailEl.dataset.key = record.key;
        detailEl.innerHTML = `
            ${itemVisual(record)}
            <div>
                <div class="tcfs-detail-name">${escapeHtml(record.title)}</div>
                <div class="tcfs-detail-meta">${escapeHtml(getRecordCategory(record))} | ${formatMoney(getRecordValue(record))} | ${escapeHtml(record.status || 'seen')}</div>
            </div>
            <div class="tcfs-detail-actions" data-key="${escapeAttr(record.key)}">
                <button type="button" data-action="center">Center</button>
                <button type="button" data-action="reveal">Reveal</button>
                <button type="button" data-action="${record.status === 'picked' ? 'restore' : 'picked'}">${record.status === 'picked' ? 'Restore' : 'Picked'}</button>
            </div>
        `;
    }

    function rowHtml(record) {
        const active = record.status === 'active';
        const selected = record.key === selectedKey;
        const value = getRecordValue(record);
        const category = getRecordCategory(record);
        const time = settings.sort === 'date' ? formatShortTime(record.foundAt) : formatTime(record.foundAt);

        return `
            <div class="tcfs-row ${selected ? 'tcfs-selected' : ''}" data-key="${escapeAttr(record.key)}">
                ${itemVisual(record)}
                <div class="tcfs-row-main">
                    <div class="tcfs-row-name">${escapeHtml(record.title)}</div>
                    <div class="tcfs-row-meta">
                        <span>${escapeHtml(category)}</span>
                        <span>${formatMoney(value)}</span>
                        <span>${escapeHtml(record.status || 'seen')}</span>
                        <span>${escapeHtml(time)}</span>
                    </div>
                </div>
                <div class="tcfs-actions">
                    <button type="button" data-action="select">Details</button>
                    <button type="button" data-action="center" ${active ? '' : 'disabled'}>Center</button>
                    ${active
                        ? '<button type="button" data-action="reveal">Reveal</button>'
                        : `<button type="button" data-action="${record.status === 'picked' ? 'restore' : 'picked'}">${record.status === 'picked' ? 'Restore' : 'Picked'}</button>`}
                </div>
            </div>
        `;
    }

    function updateBadge() {
        if (!badge) return;
        const count = visibleActiveItems().length;
        badge.style.display = count ? 'block' : 'none';
        badge.textContent = count > 99 ? '99+' : String(count);
    }

    function toast(message) {
        let el = document.getElementById('tcfs-toast');
        if (!el) {
            el = document.createElement('div');
            el.id = 'tcfs-toast';
            document.body.appendChild(el);
        }

        el.textContent = message;
        el.classList.add('tcfs-show');
        clearTimeout(toastTimer);
        toastTimer = setTimeout(() => el.classList.remove('tcfs-show'), 2300);
    }

    function syncNow(userInitiated) {
        if (!tornReady()) {
            if (userInitiated) toast('City map is still loading');
            return;
        }

        if (document.visibilityState !== 'visible') return;

        activeItems = getPageItems();
        updateHistory(activeItems);
        syncMarkers(visibleActiveItems());
        updateBadge();
        render();
    }

    function scheduleSync() {
        clearInterval(syncTimer);
        syncTimer = setInterval(() => syncNow(false), POLL_MS);
    }

    function requestText(url) {
        return new Promise((resolve, reject) => {
            if (typeof GM_xmlhttpRequest === 'function') {
                GM_xmlhttpRequest({
                    method: 'GET',
                    url,
                    timeout: 20000,
                    onload: (response) => resolve(response.responseText || ''),
                    onerror: () => reject(new Error('API request failed')),
                    ontimeout: () => reject(new Error('API request timed out'))
                });
                return;
            }

            fetch(url, { credentials: 'omit' })
                .then((response) => response.text())
                .then(resolve)
                .catch(reject);
        });
    }

    async function fetchItemMetadata(force) {
        if (busyMeta) return;
        if (!settings.apiEnabled || !settings.apiKey) {
            metaStatus = 'API off';
            renderSettings();
            render();
            return;
        }

        const age = Date.now() - itemMetaFetchedAt;
        if (!force && itemMetaFetchedAt && age < METADATA_CACHE_MAX_AGE_MS && Object.keys(itemMeta).length) {
            metaStatus = 'Cached';
            renderSettings();
            render();
            return;
        }

        busyMeta = true;
        metaStatus = 'Loading values';
        renderSettings();
        render();

        try {
            const url = 'https://api.torn.com/torn/?selections=items&key=' + encodeURIComponent(settings.apiKey);
            const text = await requestText(url);
            const data = JSON.parse(text);

            if (data.error) {
                throw new Error(data.error.error || data.error.code || 'Torn API error');
            }

            const nextMeta = {};
            Object.keys(data.items || {}).forEach((itemId) => {
                const item = data.items[itemId];
                if (!item || typeof item !== 'object') return;
                const value = Number(item.market_value);
                nextMeta[String(itemId)] = {
                    title: cleanText(item.name || item.title || ''),
                    category: cleanText(item.type || item.category || 'Unknown') || 'Unknown',
                    value: Number.isFinite(value) ? value : null
                };
            });

            itemMeta = nextMeta;
            itemMetaFetchedAt = Date.now();
            STORE.set('itemMeta', itemMeta);
            STORE.set('itemMetaFetchedAt', itemMetaFetchedAt);
            metaStatus = Object.keys(itemMeta).length ? 'Values ready' : 'No values';
            updateHistory(activeItems);
            toast('Item values updated');
        } catch (error) {
            metaStatus = 'API error';
            toast('Could not load item values');
        } finally {
            busyMeta = false;
            renderSettings();
            syncMarkers(visibleActiveItems());
            render();
        }
    }

    async function waitForTorn() {
        const started = Date.now();
        while (Date.now() - started < 30000) {
            if (tornReady()) return true;
            await new Promise((resolve) => setTimeout(resolve, 500));
        }
        return false;
    }

    function watchVisibility() {
        document.addEventListener('visibilitychange', () => {
            if (document.visibilityState === 'visible') syncNow(false);
        });
    }

    async function boot() {
        buildUI();
        watchVisibility();
        const ready = await waitForTorn();
        if (!ready) {
            toast('City map was not detected');
            return;
        }

        syncNow(false);
        scheduleSync();
        if (settings.apiEnabled && settings.apiKey) fetchItemMetadata(false);
        console.log('[Torn City Safe Finder] ready v' + VERSION);
    }

    if (document.readyState === 'loading') {
        document.addEventListener('DOMContentLoaded', boot);
    } else {
        boot();
    }
})();
