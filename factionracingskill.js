// ==UserScript==
// @name         Nuclear Blast #8085 — Racing Skills
// @namespace    torn.com
// @version      1.4
// @description  Displays racing skills for all members of faction Nuclear Blast (8085) in a centered card popup
// @author       cowboyup
// @match        https://www.torn.com/page.php?sid=racing*
// @match        https://www.torn.com/loader.php?sid=racing*
// @grant        none
// ==/UserScript==

(function () {
  'use strict';

  const STORAGE_KEY = 'nb_torn_api_key';
  const FACTION_ID  = 8085;
  let API_KEY       = localStorage.getItem(STORAGE_KEY) || '';
  let members       = [];
  let maxSkill      = 100;
  let scriptInjected = false;

  function init() {
    if (document.getElementById('nb-racing-btn') || scriptInjected) return;

    const btn = document.createElement('button');
    btn.id = 'nb-racing-btn';
    btn.textContent = '🏁 Racing Skills';
    btn.style.cssText = `
      position: fixed; bottom: 120px; right: 16px; z-index: 99999;
      background: #185FA5; color: #fff; border: none; border-radius: 8px;
      padding: 10px 18px; font-size: 14px; cursor: pointer; box-shadow: 0 2px 8px rgba(0,0,0,0.3);
      touch-action: manipulation;
    `;
    document.body.appendChild(btn);

    btn.addEventListener('click', () => {
      if (document.getElementById('nb-racing-modal-backdrop')) {
        document.getElementById('nb-racing-modal-backdrop').remove();
      } else {
        openPopup();
      }
    });
    scriptInjected = true;
  }

  const observer = new MutationObserver(() => {
    if (window.location.href.includes('sid=racing')) {
      init();
    }
  });
  observer.observe(document.documentElement, { subtree: true, childList: true });

  // ── Popup Modal ────────────────────────────────────────────────────────────
  function openPopup() {
    const backdrop = document.createElement('div');
    backdrop.id = 'nb-racing-modal-backdrop';
    backdrop.style.cssText = `
      position: fixed !important;
      top: 0 !important; left: 0 !important;
      width: 100vw !important; height: 100vh !important;
      background: rgba(0, 0, 0, 0.6) !important;
      z-index: 999998 !important;
      display: flex !important;
      align-items: center !important;
      justify-content: center !important;
      box-sizing: border-box !important;
      padding: 12px !important;
    `;

    const modal = document.createElement('div');
    modal.id = 'nb-racing-overlay';
    modal.style.cssText = `
      width: 92vw !important;
      max-width: 760px !important;
      height: 75vh !important;
      max-height: 580px !important;
      background: #fff !important;
      color: #111 !important;
      border-radius: 12px !important;
      box-shadow: 0 12px 36px rgba(0,0,0,0.4) !important;
      display: flex !important;
      flex-direction: column !important;
      font-family: Arial, sans-serif !important;
      font-size: 13px !important;
      box-sizing: border-box !important;
      overflow: hidden !important;
    `;

    modal.innerHTML = `
      <div style="padding:14px; border-bottom:1px solid #e5e5e5; display:flex; align-items:center; gap:8px; flex-wrap:wrap; background:#fcfcfc;">
        <span style="font-size:15px; font-weight:600; color:#111;">Nuclear Blast #8085</span>
        <span id="nb-count" style="font-size:11px; background:#e2e8f0; padding:2px 8px; border-radius:20px;">Loading…</span>
        <div style="margin-left:auto; display:flex; gap:6px; flex-wrap:wrap; width:100%; margin-top:8px;">
          <input id="nb-search" type="text" placeholder="Search..." style="padding:6px 8px; border:1px solid #ccc; border-radius:6px; font-size:12px; flex:2; min-width:100px;" />
          <select id="nb-sort" style="padding:6px 6px; border:1px solid #ccc; border-radius:6px; font-size:12px; flex:1;">
            <option value="racing_skill">Skill</option>
            <option value="racing_wins">Wins</option>
            <option value="racing_points">Points</option>
            <option value="name">Name</option>
          </select>
          <select id="nb-dir" style="padding:6px 6px; border:1px solid #ccc; border-radius:6px; font-size:12px;">
            <option value="desc">Desc</option>
            <option value="asc">Asc</option>
          </select>
          <button id="nb-change-key" title="Change API key" style="padding:6px 10px; border:1px solid #ccc; border-radius:6px; font-size:12px; cursor:pointer; background:#f1f5f9;">🔑</button>
          <button id="nb-close" style="padding:6px 12px; border:1px solid #ccc; border-radius:6px; font-size:12px; cursor:pointer; background:#f1f5f9; font-weight:600;">✕ Close</button>
        </div>
      </div>
      <div id="nb-stats" style="display:flex; gap:6px; padding:10px 14px; border-bottom:1px solid #e5e5e5; flex-wrap:wrap; background:#f8fafc;"></div>
      <div id="nb-progress" style="text-align:center; font-size:11px; color:#c62828; font-weight:bold; padding:6px 0; background:#fef2f2; border-bottom:1px solid #fee2e2; display:none;"></div>
      <div id="nb-body" style="overflow-y:auto; flex:1; padding:10px 14px 14px;">
        <p style="padding:2rem; text-align:center; color:#888;">Fetching data…</p>
      </div>
    `;

    backdrop.appendChild(modal);
    document.body.appendChild(backdrop);

    document.getElementById('nb-close').addEventListener('click', () => backdrop.remove());
    backdrop.addEventListener('click', (e) => { if (e.target === backdrop) backdrop.remove(); });

    document.getElementById('nb-search').addEventListener('input', render);
    document.getElementById('nb-sort').addEventListener('change', render);
    document.getElementById('nb-dir').addEventListener('change', render);

    document.getElementById('nb-change-key').addEventListener('click', () => {
      showKeySetup(modal, () => fetchData());
    });

    // Show setup screen if no key stored, otherwise fetch immediately
    if (!API_KEY) {
      showKeySetup(modal, () => fetchData());
    } else {
      fetchData();
    }
  }

  // ── API Key Setup Screen ───────────────────────────────────────────────────
  function showKeySetup(modal, onSuccess) {
    const body    = document.getElementById('nb-body');
    const stats   = document.getElementById('nb-stats');
    const count   = document.getElementById('nb-count');
    const search  = document.getElementById('nb-search');
    const sort    = document.getElementById('nb-sort');
    const dir     = document.getElementById('nb-dir');

    if (stats)  stats.style.display  = 'none';
    if (count)  count.textContent    = 'Setup';
    if (search) search.style.display = 'none';
    if (sort)   sort.style.display   = 'none';
    if (dir)    dir.style.display    = 'none';

    const masked = API_KEY
      ? API_KEY.slice(0, 4) + '•'.repeat(Math.max(0, API_KEY.length - 4))
      : '';

    body.innerHTML = `
      <div style="display:flex; flex-direction:column; align-items:center; justify-content:center; height:100%; gap:0; padding:1rem;">
        <div style="width:100%; max-width:420px; background:#f8fafc; border:1px solid #e2e8f0; border-radius:10px; padding:24px 20px;">
          <div style="font-size:15px; font-weight:600; color:#111; margin-bottom:4px;">Enter your Torn API key</div>
          <div style="font-size:12px; color:#64748b; margin-bottom:16px; line-height:1.5;">
            Your key is saved locally in your browser and only ever sent to <code style="font-size:11px; background:#e2e8f0; padding:1px 5px; border-radius:4px;">api.torn.com</code>.
          </div>

          <div style="position:relative; display:flex; align-items:center; margin-bottom:8px;">
            <input
              id="nb-key-input"
              type="password"
              placeholder="${masked ? 'Current: ' + masked + ' — paste new to replace' : 'Paste your API key here…'}"
              autocomplete="off"
              style="
                width:100%; padding:8px 36px 8px 10px; border:1px solid #cbd5e1;
                border-radius:6px; font-size:13px; font-family:monospace;
                box-sizing:border-box; background:#fff; color:#111;
              "
            />
            <button id="nb-key-toggle" title="Show/hide key" style="
              position:absolute; right:8px; background:none; border:none;
              cursor:pointer; font-size:14px; color:#64748b; padding:0; line-height:1;
            ">👁</button>
          </div>

          <div id="nb-key-error" style="font-size:11px; color:#c62828; margin-bottom:8px; display:none;">Please enter a valid API key.</div>

          <div style="display:flex; gap:8px; margin-top:4px;">
            <button id="nb-key-save" style="
              flex:1; padding:9px; background:#185FA5; color:#fff;
              border:none; border-radius:6px; font-size:13px; font-weight:600; cursor:pointer;
            ">Save &amp; load data</button>
            ${API_KEY ? `<button id="nb-key-clear" style="
              padding:9px 14px; background:#fff; color:#c62828;
              border:1px solid #fca5a5; border-radius:6px; font-size:13px; cursor:pointer;
            ">Clear</button>` : ''}
          </div>

          <div style="font-size:10px; color:#94a3b8; margin-top:12px; text-align:center;">
            Get your key at torn.com → Settings → API Key
          </div>
        </div>
      </div>
    `;

    // Toggle show/hide
    document.getElementById('nb-key-toggle').addEventListener('click', () => {
      const inp = document.getElementById('nb-key-input');
      inp.type = inp.type === 'password' ? 'text' : 'password';
    });

    // Save
    document.getElementById('nb-key-save').addEventListener('click', () => {
      const inp = document.getElementById('nb-key-input');
      const val = inp.value.trim();
      const errEl = document.getElementById('nb-key-error');

      if (!val && !API_KEY) {
        errEl.style.display = 'block';
        return;
      }

      if (val) {
        API_KEY = val;
        localStorage.setItem(STORAGE_KEY, API_KEY);
      }

      // Restore header controls
      if (stats)  stats.style.display  = '';
      if (count)  count.textContent    = 'Loading…';
      if (search) search.style.display = '';
      if (sort)   sort.style.display   = '';
      if (dir)    dir.style.display    = '';

      body.innerHTML = '<p style="padding:2rem; text-align:center; color:#888;">Fetching data…</p>';
      members = [];
      onSuccess();
    });

    // Clear
    const clearBtn = document.getElementById('nb-key-clear');
    if (clearBtn) {
      clearBtn.addEventListener('click', () => {
        localStorage.removeItem(STORAGE_KEY);
        API_KEY = '';
        const inp = document.getElementById('nb-key-input');
        if (inp) {
          inp.value = '';
          inp.placeholder = 'Paste your API key here…';
        }
        const clearBtnEl = document.getElementById('nb-key-clear');
        if (clearBtnEl) clearBtnEl.remove();
      });
    }
  }

  // ── Rank label ─────────────────────────────────────────────────────────────
  function rankLabel(s) {
    if (s >= 75) return { label: 'Elite',        bg: '#dbeafe', color: '#1e40af' };
    if (s >= 50) return { label: 'Advanced',     bg: '#dcfce7', color: '#166534' };
    if (s >= 25) return { label: 'Intermediate', bg: '#fef9c3', color: '#854d0e' };
    return              { label: 'Beginner',      bg: '#f3f4f6', color: '#374151' };
  }

  function statCard(label, value) {
    return `<div style="background:#fff; border:1px solid #e2e8f0; border-radius:6px; padding:6px 10px; min-width:75px; flex:1;">
      <div style="font-size:10px; color:#64748b; text-transform:uppercase;">${label}</div>
      <div style="font-size:15px; font-weight:600; color:#334155;">${value}</div>
    </div>`;
  }

  function render() {
    const search    = (document.getElementById('nb-search')?.value || '').toLowerCase();
    const sortField = document.getElementById('nb-sort')?.value  || 'racing_skill';
    const sortDir   = document.getElementById('nb-dir')?.value   || 'desc';

    let filtered = members.filter(m => m.name.toLowerCase().includes(search));
    filtered.sort((a, b) => {
      let av = a[sortField] ?? 0, bv = b[sortField] ?? 0;
      if (typeof av === 'string') { av = av.toLowerCase(); bv = bv.toLowerCase(); }
      if (av < bv) return sortDir === 'asc' ? -1 : 1;
      if (av > bv) return sortDir === 'asc' ?  1 : -1;
      return 0;
    });

    const rows = filtered.map((m, i) => {
      const skill = m.racing_skill ?? 0;
      const pct   = maxSkill > 0 ? Math.round((skill / maxSkill) * 100) : 0;
      const rk    = rankLabel(skill);
      return `<tr style="border-bottom:1px solid #f1f5f9;">
        <td style="padding:8px 4px; color:#94a3b8;">${i + 1}</td>
        <td style="padding:8px 4px;">
          <a href="https://www.torn.com/profiles.php?XID=${m.id}" target="_blank"
             style="color:#1d6fa4; text-decoration:none; font-weight:600;">${m.name}</a>
        </td>
        <td style="padding:8px 4px; color:#475569;">${m.position ?? '—'}</td>
        <td style="padding:8px 4px;">
          <span style="background:${rk.bg}; color:${rk.color}; font-size:10px; padding:1px 6px; border-radius:20px;">
            ${rk.label}
          </span>
        </td>
        <td style="padding:8px 4px;">
          <div style="display:flex; align-items:center; gap:4px;">
            <div style="flex:1; height:5px; border-radius:3px; background:#e2e8f0; min-width:40px;">
              <div style="width:${pct}%; height:100%; border-radius:3px; background:#378ADD;"></div>
            </div>
            <span style="font-size:11px; color:#475569; min-width:28px; text-align:right;">${skill.toFixed(2)}</span>
          </div>
        </td>
        <td style="padding:8px 4px; color:#475569;">${m.racing_wins ?? '—'}</td>
        <td style="padding:8px 4px; color:#475569;">${m.races_entered ?? '—'}</td>
        <td style="padding:8px 4px; color:#475569;">${m.racing_points ?? '—'}</td>
      </tr>`;
    }).join('');

    const body = document.getElementById('nb-body');
    if (!body) return;
    body.innerHTML = `
      <div style="overflow-x:auto; width:100%;">
        <table style="width:100%; border-collapse:collapse; font-size:11px; min-width:550px;">
          <thead>
            <tr style="border-bottom:2px solid #cbd5e1; background:#f8fafc; position:sticky; top:0; z-index:10;">
              <th style="padding:6px 4px; text-align:left; color:#64748b; font-weight:600;">#</th>
              <th style="padding:6px 4px; text-align:left; color:#64748b; font-weight:600;">Member</th>
              <th style="padding:6px 4px; text-align:left; color:#64748b; font-weight:600;">Pos</th>
              <th style="padding:6px 4px; text-align:left; color:#64748b; font-weight:600;">Rank</th>
              <th style="padding:6px 4px; text-align:left; color:#64748b; font-weight:600;">Skill</th>
              <th style="padding:6px 4px; text-align:left; color:#64748b; font-weight:600;">Wins</th>
              <th style="padding:6px 4px; text-align:left; color:#64748b; font-weight:600;">Runs</th>
              <th style="padding:6px 4px; text-align:left; color:#64748b; font-weight:600;">Pts</th>
            </tr>
          </thead>
          <tbody>${rows}</tbody>
        </table>
      </div>`;
  }

  async function delay(ms) { return new Promise(r => setTimeout(r, ms)); }

  async function fetchWithRetry(url, retries = 3) {
    for (let i = 0; i < retries; i++) {
      try {
        const res = await fetch(url);
        const d   = await res.json();
        if (d.error && (d.error.code === 5 || d.error.code === 8)) {
          await delay(2000);
          continue;
        }
        return d;
      } catch(e) { await delay(1000); }
    }
    return null;
  }

  async function fetchData() {
    const factionData = await fetchWithRetry(
      `https://api.torn.com/faction/${FACTION_ID}?selections=basic&key=${API_KEY}`
    );

    if (!factionData || factionData.error) {
      const body = document.getElementById('nb-body');
      const modal = document.getElementById('nb-racing-overlay');
      const errCode = factionData?.error?.code;
      const errMsg  = factionData?.error?.error ?? 'Unknown error';

      // Invalid key (code 2) — drop back to setup screen
      if (body && modal && errCode === 2) {
        localStorage.removeItem(STORAGE_KEY);
        API_KEY = '';
        const stats  = document.getElementById('nb-stats');
        const count  = document.getElementById('nb-count');
        const search = document.getElementById('nb-search');
        const sort   = document.getElementById('nb-sort');
        const dir    = document.getElementById('nb-dir');
        if (stats)  stats.style.display  = 'none';
        if (count)  count.textContent    = 'Setup';
        if (search) search.style.display = 'none';
        if (sort)   sort.style.display   = 'none';
        if (dir)    dir.style.display    = 'none';
        showKeySetup(modal, () => fetchData());
        const errEl = document.getElementById('nb-key-error');
        if (errEl) {
          errEl.textContent = 'API key was invalid or expired. Please enter a new one.';
          errEl.style.display = 'block';
        }
      } else if (body) {
        body.innerHTML = `<p style="color:red; padding:1rem;">API error: ${errMsg}</p>`;
      }
      return;
    }

    const raw = Object.entries(factionData.members || {});
    const countEl = document.getElementById('nb-count');
    if (countEl) countEl.textContent = `${raw.length} members`;

    members = raw.map(([id, m]) => ({
      id,
      name: m.name,
      level: m.level,
      days_in_faction: m.days_in_faction,
      status: m.status?.state ?? '—',
      position: m.position,
      racing_skill: 0,
      racing_wins: 0,
      races_entered: 0,
      racing_points: 0,
    }));

    const total = members.length;
    let done = 0;

    const prog = document.getElementById('nb-progress');
    if (prog) prog.style.display = 'block';

    for (let i = 0; i < members.length; i++) {
      const m = members[i];
      const d = await fetchWithRetry(
        `https://api.torn.com/user/${m.id}?selections=personalstats&key=${API_KEY}`
      );

      if (d && d.personalstats) {
        m.racing_skill  = Number(d.personalstats.racingskill)       || 0;
        m.racing_wins   = Number(d.personalstats.raceswon)          || 0;
        m.racing_points = Number(d.personalstats.racingpointsearned)|| 0;
        m.races_entered = Number(d.personalstats.racesentered)      || 0;
      }

      done++;
      if (prog) prog.textContent = `Fetching Profile Data (${done} / ${total})...`;

      await delay(650);
    }

    if (prog) prog.style.display = 'none';

    const skills    = members.map(m => m.racing_skill ?? 0);
    maxSkill        = Math.max(...skills, 1);
    const withSkill = skills.filter(s => s > 0);
    const avg       = withSkill.length
      ? (withSkill.reduce((a, b) => a + b, 0) / withSkill.length).toFixed(2)
      : 0;
    const top = Math.max(...skills).toFixed(2);

    const statsEl = document.getElementById('nb-stats');
    if (statsEl) {
      statsEl.innerHTML =
        statCard('Total',  members.length) +
        statCard('Top',    top)            +
        statCard('Avg',    avg)            +
        statCard('Active', withSkill.length);
    }

    render();
  }

  if (window.location.href.includes('sid=racing')) {
    init();
  }
})();
