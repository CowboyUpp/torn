// ==UserScript==
// @name         Torn Cracking Heat Badge
// @namespace    https://greasyfork.org/users/cowboyup
// @version      1.0.2
// @description  Shows your hottest Cracking rig component as a compact, color-coded heat badge on the Crimes overview tile.
// @author       cowboyup
// @copyright    2026, cowboyup
// @license      MIT
// @match        https://www.torn.com/page.php?sid=crimes*
// @match        https://www.torn.com/loader.php?sid=crimes*
// @icon         https://www.google.com/s2/favicons?sz=64&domain=torn.com
// @run-at       document-idle
// @grant        none
// @noframes
// ==/UserScript==

// SPDX-License-Identifier: MIT
// Copyright (c) 2026 cowboyup

(function () {
  'use strict';

  const BADGE_ID = 'tchb-cracking-heat';
  const STYLE_ID = 'tchb-styles';
  const STORAGE_KEY = 'tchb-cracking-hottest-v1';
  const CRACKING_HASH = '#/cracking';
  const SCAN_INTERVAL_MS = 1000;
  const MUTATION_SCAN_THROTTLE_MS = 250;
  const MAX_CACHE_AGE_MS = 7 * 24 * 60 * 60 * 1000;

  let scanQueued = false;
  let lastScanAt = 0;

  function isCrackingRoute() {
    return location.hash.startsWith(CRACKING_HASH);
  }

  function addStyles() {
    if (document.getElementById(STYLE_ID)) return;

    const style = document.createElement('style');
    style.id = STYLE_ID;
    style.textContent = `
      .tchb-host {
        position: relative !important;
      }

      #${BADGE_ID} {
        position: absolute;
        top: 7px;
        right: 7px;
        z-index: 5;
        display: inline-flex;
        align-items: center;
        justify-content: center;
        gap: 3px;
        min-width: 40px;
        height: 22px;
        box-sizing: border-box;
        padding: 0 6px 0 5px;
        border: 1px solid rgba(255, 255, 255, 0.22);
        border-radius: 11px;
        color: #fff;
        background: rgba(30, 33, 37, 0.9);
        box-shadow: 0 1px 4px rgba(0, 0, 0, 0.45);
        font: 700 11px/1 Arial, sans-serif;
        letter-spacing: 0;
        pointer-events: none;
        user-select: none;
      }

      #${BADGE_ID} svg {
        width: 12px;
        height: 14px;
        flex: 0 0 auto;
        fill: currentColor;
      }

      #${BADGE_ID}[data-level="cool"] { color: #63d471; }
      #${BADGE_ID}[data-level="warm"] { color: #ffc145; }
      #${BADGE_ID}[data-level="hot"] { color: #ff7b39; }
      #${BADGE_ID}[data-level="critical"] {
        color: #ff4d4d;
        border-color: rgba(255, 77, 77, 0.48);
        background: rgba(60, 21, 24, 0.94);
      }
      #${BADGE_ID}[data-level="unknown"] { color: #aeb4bc; }

      @media (max-width: 784px) {
        #${BADGE_ID} {
          top: 5px;
          right: 5px;
          min-width: 36px;
          height: 20px;
          padding: 0 5px 0 4px;
          font-size: 10px;
        }
      }
    `;
    document.head.appendChild(style);
  }

  function parseHeat(text) {
    const match = String(text || '').replace(',', '.').match(/(\d+(?:\.\d+)?)\s*%?/);
    if (!match) return null;
    const value = Number(match[1]);
    return Number.isFinite(value) && value >= 0 ? value : null;
  }

  function readHottestComponent() {
    const readings = [];
    const rigRoots = document.querySelectorAll(
      'div.crime-root.cracking-root div[class^="rig___"], ' +
      'div.crime-root.cracking-root div[class*="rig___"]'
    );

    for (const rig of rigRoots) {
      const value = rig.querySelector(
        'div[class*="hottest___"] span[class^="value___"], ' +
        'div[class*="hottest___"] span[class*="value___"], ' +
        'div[class*="hottest___"]'
      );
      const heat = parseHeat(value && value.textContent);
      if (heat !== null) readings.push(heat);
    }

    if (readings.length) return Math.max(...readings);

    // Text fallback for Torn CSS-module renames.
    const root = document.querySelector('div.crime-root.cracking-root, .crimes-app');
    if (!root) return null;
    const candidates = root.querySelectorAll('span, div, li, p');
    for (const element of candidates) {
      const text = (element.textContent || '').replace(/\s+/g, ' ').trim();
      if (text.length > 120) continue;
      const match = text.match(/hottest\s+component\s*:?\s*(\d+(?:[.,]\d+)?)\s*%/i);
      if (!match) continue;
      const heat = parseHeat(match[1]);
      if (heat !== null) readings.push(heat);
    }
    return readings.length ? Math.max(...readings) : null;
  }

  function saveHeat(heat) {
    const previous = loadHeat(false);
    if (previous && previous.heat === heat && Date.now() - previous.capturedAt < 15000) return;

    try {
      localStorage.setItem(STORAGE_KEY, JSON.stringify({ heat, capturedAt: Date.now() }));
    } catch (_) {
      // The live value can still be displayed during this page session.
    }
  }

  function loadHeat(enforceMaxAge = true) {
    try {
      const stored = JSON.parse(localStorage.getItem(STORAGE_KEY) || 'null');
      if (!stored || !Number.isFinite(stored.heat) || !Number.isFinite(stored.capturedAt)) return null;
      if (enforceMaxAge && Date.now() - stored.capturedAt > MAX_CACHE_AGE_MS) return null;
      return stored;
    } catch (_) {
      return null;
    }
  }

  function displayedHeat(snapshot) {
    if (!snapshot) return null;
    const elapsedMinutes = Math.floor(Math.max(0, Date.now() - snapshot.capturedAt) / 60000);

    // Torn only displays 100% even though an overheated component may internally
    // reach 150%. Keep a conservative 50-minute buffer for a capped reading.
    const hiddenHeatBuffer = snapshot.heat >= 100 ? 50 : 0;
    return Math.min(100, Math.max(0, snapshot.heat + hiddenHeatBuffer - elapsedMinutes));
  }

  function heatLevel(heat) {
    if (heat === null) return 'unknown';
    if (heat >= 100) return 'critical';
    if (heat >= 80) return 'hot';
    if (heat >= 50) return 'warm';
    return 'cool';
  }

  function findCrackingTile() {
    const links = Array.from(document.querySelectorAll('a[href]')).filter((link) => {
      const href = link.getAttribute('href') || '';
      return /#\/cracking(?:$|[/?])/i.test(href);
    });

    if (links.length) {
      links.sort((a, b) => {
        const aArea = a.getBoundingClientRect().width * a.getBoundingClientRect().height;
        const bArea = b.getBoundingClientRect().width * b.getBoundingClientRect().height;
        return bArea - aArea;
      });
      return links[0];
    }

    // Accessibility/text fallback if the route is attached by a click handler.
    const walker = document.createTreeWalker(document.body, NodeFilter.SHOW_ELEMENT);
    let node;
    while ((node = walker.nextNode())) {
      if (!/^(cracking)$/i.test((node.textContent || '').trim())) continue;
      const clickable = node.closest('a, button, [role="link"]');
      if (clickable) return clickable;
    }
    return null;
  }

  function flameSvg() {
    return '<svg viewBox="0 0 24 28" aria-hidden="true"><path d="M13.7 1.2c.7 4.3-2 6.2-3.7 8.5-1.3 1.8-1.4 3.7-.1 5.1-.1-3.2 2.4-5 4.2-7.1 3.2 2.6 6 6 6 10.7 0 5.1-3.7 8.4-8.2 8.4-4.7 0-8.3-3.4-8.3-8.2 0-3.7 2.1-7.1 5.4-10.2 1.8-1.7 3.4-3.6 4.7-7.2z"/></svg>';
  }

  function renderOverviewBadge() {
    if (isCrackingRoute()) {
      document.getElementById(BADGE_ID)?.remove();
      return;
    }

    const tile = findCrackingTile();
    if (!tile) return;

    document.querySelectorAll('.tchb-host').forEach((host) => {
      if (host !== tile) host.classList.remove('tchb-host');
    });

    const existing = document.getElementById(BADGE_ID);
    if (existing && existing.parentElement !== tile) existing.remove();

    const snapshot = loadHeat();
    const heat = displayedHeat(snapshot);
    const rounded = heat === null ? null : Math.round(heat);
    const badge = document.getElementById(BADGE_ID) || document.createElement('span');
    const renderKey = `${rounded === null ? 'unknown' : rounded}:${snapshot ? snapshot.capturedAt : 0}`;
    badge.id = BADGE_ID;
    if (badge.dataset.renderKey !== renderKey) {
      badge.dataset.renderKey = renderKey;
      badge.dataset.level = heatLevel(rounded);
      badge.setAttribute('aria-label', rounded === null
        ? 'Cracking hottest component unknown'
        : `Cracking hottest component ${rounded} percent`);
      badge.title = rounded === null
        ? 'Open Cracking once to read your hottest rig component.'
        : `Hottest component: ${rounded}%${snapshot
          ? snapshot.heat >= 100
            ? ' (conservative upper-bound cooldown estimate)'
            : ' (cooldown estimate)'
          : ''}`;
      badge.innerHTML = `${flameSvg()}<span>${rounded === null ? '—' : rounded}%</span>`;
    }

    tile.classList.add('tchb-host');
    if (!badge.parentElement) tile.appendChild(badge);
  }

  function scan() {
    scanQueued = false;
    lastScanAt = performance.now();
    addStyles();

    if (isCrackingRoute()) {
      const heat = readHottestComponent();
      if (heat !== null) saveHeat(heat);
      document.getElementById(BADGE_ID)?.remove();
      document.querySelectorAll('.tchb-host').forEach((host) => host.classList.remove('tchb-host'));
    } else {
      renderOverviewBadge();
    }
  }

  function queueScan() {
    if (scanQueued) return;
    scanQueued = true;
    const elapsed = performance.now() - lastScanAt;
    const delay = Math.max(0, MUTATION_SCAN_THROTTLE_MS - elapsed);
    if (delay) {
      setTimeout(() => requestAnimationFrame(scan), delay);
    } else {
      requestAnimationFrame(scan);
    }
  }

  const observer = new MutationObserver(queueScan);
  observer.observe(document.documentElement, { childList: true, subtree: true });

  window.addEventListener('hashchange', queueScan, { passive: true });
  window.addEventListener('pageshow', queueScan, { passive: true });
  window.addEventListener('focus', queueScan, { passive: true });

  setInterval(queueScan, SCAN_INTERVAL_MS);

  queueScan();
})();
