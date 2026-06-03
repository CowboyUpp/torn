// ==UserScript==
// @name         Nuclear Blast — Racing Skills
// @namespace    torn.com
// @version      2.8
// @description  Displays racing skills for all members of faction Nuclear Blast in a centered card popup with perfectly fixed static headers, CSV export functionality, and Win/Race efficiency ratios.
// @author       cowboyup
// @match        https://www.torn.com/page.php?sid=racing*
// @match        https://www.torn.com/loader.php?sid=racing*
// @license      MIT
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

  const SCRIPT_VERSION = '2.8';

  // ── EXCEL-STYLE FIXED HEADER CSS ─────────────────────────────────────────
  const style = document.createElement('style');
  style.textContent = '#nb-body-scroll-container { overflow-y: auto !important; overflow-x: auto !important; flex: 1 !important; height: 100% !important; position: relative !important; } #nb-racing-table { width: 100% !important; border-collapse: separate !important; border-spacing: 0 !important; font-size: 11px !important; min-width: 600px !important; } #nb-racing-table thead th { position: sticky !important; top: 0 !important; z-index: 999 !important; background-color: #ffffff !important; color: #64748b !important; font-weight: 600 !important; padding: 12px 4px 10px 14px !important; text-align: left !important; border-bottom: 2px solid #cbd5e1 !important; } #nb-racing-table th:first-child { padding-left: 14px !important; } #nb-racing-table th:last-child { padding-right: 14px !important; }';
  document.head.appendChild(style);

  function init() {
    if (document.getElementById('nb-racing-btn') || scriptInjected) return;

    const btn = document.createElement('button');
    btn.id = 'nb-racing-btn';
    btn.textContent = '🏁 Racing Skills';
    btn.style.cssText = 'position: fixed; bottom: 120px; right: 16px; z-index: 99999; background: #185FA5; color: #fff; border: none; border-radius: 8px; padding: 10px 18px; font-size: 14px; cursor: pointer; box-shadow: 0 2px 8px rgba(0,0,0,0.3); touch-action: manipulation;';
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

  function openPopup() {
    const backdrop = document.createElement('div');
    backdrop.id = 'nb-racing-modal-backdrop';
    backdrop.style.cssText = 'position: fixed !important; top: 0 !important; left: 0 !important; width: 100vw !important; height: 100vh !important; background: rgba(0, 0, 0, 0.6) !important; z-index: 999998 !important; display: flex !important; align-items: center !important; justify-content: center !important; box-sizing: border-box !important; padding: 12px !important;';

    const modal = document.createElement('div');
    modal.id = 'nb-racing-overlay';
    modal.style.cssText = 'width: 92vw !important; max-width: 820px !important; height: 75vh !important; max-height: 580px !important; background: #fff !important; color: #111 !important; border-radius: 12px !important; box-shadow: 0 12px 36px rgba(0,0,0,0.4) !important; display: flex !important; flex-direction: column !important; font-family: Arial, sans-serif !important; font-size: 13px !important; box-sizing: border-box !important; overflow: hidden !important;';

    let headerHtml = '<div style="padding:14px; border-bottom:1px solid #e5e5e5; display:flex; align-items:center; gap:8px; flex-wrap:wrap; background:#fcfcfc;">';
    headerHtml += '<span style="font-size:15px; font-weight:600; color:#111;">Nuclear Blast</span>';
    headerHtml += '<span style="font-size:10px; color:#64748b; background:#f1f5f9; border:1px solid #e2e8f0; padding:1px 5px; border-radius:4px; font-weight:normal;">v' + SCRIPT_VERSION + '</span>';
    headerHtml += '<span id="nb-count" style="font-size:11px; background:#e2e8f0; padding:2px 8px; border-radius:20px;">Loading…</span>';
    headerHtml += '<div style="margin-left:auto; display:flex; gap:6px; flex-wrap:wrap; width:100%; margin-top:8px;">';
    headerHtml += '<input id="nb-search" type="text" placeholder="Search..." style="padding:6px 8px; border:1px solid #ccc; border-radius:6px; font-size:12px; flex:2; min-width:100px;" />';
    headerHtml += '<select id="nb-sort" style="padding:6px 6px; border:1px solid #ccc; border-radius:6px; font-size:12px; flex:1;"><option value="racing_skill">Skill</option><option value="racing_ratio">Ratio %</option><option value="racing_wins">Wins</option><option value="racing_points">Points</option><option value="name">Name</option></select>';
    headerHtml += '<select id="nb-dir" style="padding:6px 6px; border:1px solid #ccc; border-radius:6px; font-size:12px;"><option value="desc">Desc</option><option value="asc">Asc</option></select>';
    headerHtml += '<button id="nb-change-key" title="Change API key" style="padding:6px 10px; border:1px solid #ccc; border-radius:6px; font-size:12px; cursor:pointer; background:#f1f5f9;">🔑</button>';
    headerHtml += '<button id="nb-export" title="Export to Excel CSV" style="padding:6px 12px; border:1px solid #cbd5e1; border-radius:6px; font-size:12px; cursor:pointer; background:#e2e8f0; color:#0f172a; font-weight:600;">📥 Export CSV</button>';
    headerHtml += '<button id="nb-close" style="padding:6px 12px; border:1px solid #ccc; border-radius:6px; font-size:12px; cursor:pointer; background:#f1f5f9; font-weight:600;">✕ Close</button>';
    headerHtml += '</div></div>';
    headerHtml += '<div id="nb-stats" style="display:flex; gap:6px; padding:10px 14px; border-bottom:1px solid #e5e5e5; flex-wrap:wrap; background:#f8fafc;"></div>';
    headerHtml += '<div id="nb-progress" style="text-align:center; font-size:11px; color:#c62828; font-weight:bold; padding:6px 0; background:#fef2f2; border-bottom:1px solid #fee2e2; display:none;"></div>';
    headerHtml += '<div id="nb-body-scroll-container"><div id="nb-body" style="padding:0;"><p style="padding:2rem; text-align:center; color:#888;">Fetching data…</p></div></div>';

    modal.innerHTML = headerHtml;
    backdrop.appendChild(modal);
    document.body.appendChild(backdrop);

    document.getElementById('nb-close').addEventListener('click', () => backdrop.remove());
    backdrop.addEventListener('click', (e) => { if (e.target === backdrop) backdrop.remove(); });

    document.getElementById('nb-search').addEventListener('input', render);
    document.getElementById('nb-sort').addEventListener('change', render);
    document.getElementById('nb-dir').addEventListener('change', render);
    document.getElementById('nb-change-key').addEventListener('click', () => { showKeySetup(modal, () => fetchData()); });
    document.getElementById('nb-export').addEventListener('click', exportToCSV);

    if (!API_KEY) { showKeySetup(modal, () => fetchData()); } else { fetchData(); }
  }

  function showKeySetup(modal, onSuccess) {
    const body = document.getElementById('nb-body');
    const stats = document.getElementById('nb-stats');
    const count = document.getElementById('nb-count');
    const search = document.getElementById('nb-search');
    const sort = document.getElementById('nb-sort');
    const dir = document.getElementById('nb-dir');

    if (stats) stats.style.display = 'none';
    if (count) count.textContent = 'Setup';
    if (search) search.style.display = 'none';
    if (sort) sort.style.display = 'none';
    if (dir) dir.style.display = 'none';

    const masked = API_KEY ? API_KEY.slice(0, 4) + '•'.repeat(Math.max(0, API_KEY.length - 4)) : '';

    let setupHtml = '<div style="display:flex; flex-direction:column; align-items:center; justify-content:center; padding:1rem;">';
    setupHtml += '<div style="width:100%; max-width:420px; background:#f8fafc; border:1px solid #e2e8f0; border-radius:10px; padding:24px 20px;">';
    setupHtml += '<div style="font-size:15px; font-weight:600; color:#111; margin-bottom:4px;">Enter your Torn API key</div>';
    setupHtml += '<div style="font-size:12px; color:#64748b; margin-bottom:16px; line-height:1.5;">Your key is saved locally in your browser and only ever sent to <code style="font-size:11px; background:#e2e8f0; padding:1px 5px; border-radius:4px;">api.torn.com</code>.</div>';
    setupHtml += '<div style="position:relative; display:flex; align-items:center; margin-bottom:8px;">';
    setupHtml += '<input id="nb-key-input" type="password" placeholder="' + (masked ? 'Current: ' + masked : 'Paste your API key here…') + '" autocomplete="off" style="width:100%; padding:8px 36px 8px 10px; border:1px solid #cbd5e1; border-radius:6px; font-size:13px; box-sizing:border-box; background:#fff; color:#111;" />';
    setupHtml += '<button id="nb-key-toggle" style="position:absolute; right:8px; background:none; border:none; cursor:pointer; font-size:14px; color:#64748b; padding:0;">👁</button></div>';
    setupHtml += '<div id="nb-key-error" style="font-size:11px; color:#c62828; margin-bottom:8px; display:none;">Please enter a valid API key.</div>';
    setupHtml += '<div style="display:flex; gap:8px; margin-top:4px;"><button id="nb-key-save" style="flex:1; padding:9px; background:#185FA5; color:#fff; border:none; border-radius:6px; font-size:13px; font-weight:600; cursor:pointer;">Save &amp; load data</button>';
    setupHtml += (API_KEY ? '<button id="nb-key-clear" style="padding:9px 14px; background:#fff; color:#c62828; border:1px solid #fca5a5; border-radius:6px; font-size:13px; cursor:pointer;">Clear</button>' : '');
    setupHtml += '</div></div></div>';

    body.innerHTML = setupHtml;

    document.getElementById('nb-key-toggle').addEventListener('click', () => {
      const inp = document.getElementById('nb-key-input');
      inp.type = inp.type === 'password' ? 'text' : 'password';
    });

    document.getElementById('nb-key-save').addEventListener('click', () => {
      const inp = document.getElementById('nb-key-input');
      const val = inp.value.trim();
      if (!val && !API_KEY) { document.getElementById('nb-key-error').style.display = 'block'; return; }
      if (val) { API_KEY = val; localStorage.setItem(STORAGE_KEY, API_KEY); }
      if (stats) stats.style.display = '';
      if (count) count.textContent = 'Loading…';
      if (search) search.style.display = '';
      if (sort) sort.style.display = '';
      if (dir) dir.style.display = '';
      body.innerHTML = '<p style="padding:2rem; text-align:center; color:#888;">Fetching data…</p>';
      members = [];
      onSuccess();
    });
  }

  function rankLabel(s) {
    if (s >= 75) return { label: 'Elite',        bg: '#dbeafe', color: '#1e40af' };
    if (s >= 50) return { label: 'Advanced',     bg: '#dcfce7', color: '#166534' };
    if (s >= 25) return { label: 'Intermediate', bg: '#fef9c3', color: '#854d0e' };
    return              { label: 'Beginner',      bg: '#f3f4f6', color: '#374151' };
  }

  function statCard(label, value) {
    return '<div style="background:#fff; border:1px solid #e2e8f0; border-radius:6px; padding:6px 10px; min-width:75px; flex:1;"><div style="font-size:10px; color:#64748b; text-transform:uppercase;">' + label + '</div><div style="font-size:15px; font-weight:600; color:#334155;">' + value + '</div></div>';
  }

  function exportToCSV() {
    if (!members || members.length === 0) return;

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

    let csvContent = 'Index,User ID,Name,Position,Rank,Racing Skill,Wins,Runs,Ratio %,Points\n';

    filtered.forEach((m, index) => {
      const skill = m.racing_skill ?? 0;
      const rk = rankLabel(skill);
      const ratioStr = (m.racing_ratio ?? 0).toFixed(1) + '%';
      
      const cleanName = m.name.split('"').join('""');
      const cleanPos = (m.position ?? '—').split('"').join('""');

      const row = [
        index + 1,
        m.id,
        '"' + cleanName + '"',
        '"' + cleanPos + '"',
        rk.label,
        skill.toFixed(2),
        m.racing_wins ?? 0,
        m.races_entered ?? 0,
        ratioStr,
        m.racing_points ?? 0
      ];
      csvContent += row.join(',') + '\n';
    });

    const blob = new Blob([csvContent], { type: 'text/csv;charset=utf-8;' });
    const link = document.createElement('a');
    const url = URL.createObjectURL(blob);
    link.setAttribute('href', url);
    link.setAttribute('download', 'Nuclear_Blast_Racing_Skills.csv');
    link.style.visibility = 'hidden';
    document.body.appendChild(link);
    link.click();
    document.body.removeChild(link);
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
      const ratioStr = (m.racing_ratio ?? 0).toFixed(1) + '%';

      let rHtml = '<tr style="border-bottom:1px solid #f1f5f9;">';
      rHtml += '<td style="padding:8px 14px; color:#94a3b8;">' + (i + 1) + '</td>';
      rHtml += '<td style="padding:8px 4px;"><a href="https://www.torn.com/profiles.php?XID=' + m.id + '" target="_blank" style="color:#1d6fa4; text-decoration:none; font-weight:600;">' + m.name + '</a></td>';
      rHtml += '<td style="padding:8px 4px; color:#475569;">' + (m.position ?? '—') + '</td>';
      rHtml += '<td style="padding:8px 4px;"><span style="background:' + rk.bg + '; color:' + rk.color + '; font-size:10px; padding:1px 6px; border-radius:20px;">' + rk.label + '</span></td>';
      rHtml += '<td style="padding:8px 4px;"><div style="display:flex; align-items:center; gap:4px;"><div style="flex:1; height:5px; border-radius:3px; background:#e2e8f0; min-width:40px;"><div style="width:' + pct + '%; height:100%; border-radius:3px; background:#378ADD;"></div></div><span style="font-size:11px; color:#475569; min-width:28px; text-align:right;">' + skill.toFixed(2) + '</span></div></td>';
      rHtml += '<td style="padding:8px 4px; color:#475569;">' + (m.racing_wins ?? '—') + '</td>';
      rHtml += '<td style="padding:8px 4px; color:#475569;">' + (m.races_entered ?? '—') + '</td>';
      rHtml += '<td style="padding:8px 4px; font-weight:600; color:#0f172a;">' + ratioStr + '</td>';
      rHtml += '<td style="padding:8px 14px 8px 4px; color:#475569;">' + (m.racing_points ?? '—') + '</td>';
      rHtml += '</tr>';
      return rHtml;
    }).join('');

    const body = document.getElementById('nb-body');
    if (!body) return;
    
    body.innerHTML = '<table id="nb-racing-table"><thead><tr><th>#</th><th>Member</th><th>Pos</th><th>Rank</th><th>Skill</th><th>Wins</th><th>Runs</th><th>Ratio</th><th>Pts</th></tr></thead><tbody>' + rows + '</tbody></table>';
  }

  async function delay(ms) { return new Promise(r => setTimeout(r, ms)); }

  async function fetchWithRetry(url, retries = 3) {
    for (let i = 0; i < retries; i++) {
      try {
        const res = await fetch(url);
        const d   = await res.json();
        if (d.error && (d.error.code === 5 || d.error.code === 8)) { await delay(2000); continue; }
        return d;
      } catch(e) { await delay(1000); }
    }
    return null;
  }

  async function fetchData() {
    const factionData = await fetchWithRetry('https://api.torn.com/faction/' + FACTION_ID + '?selections=basic&key=' + API_KEY);
    if (!factionData || factionData.error) {
      const body = document.getElementById('nb-body');
      if (body) body.innerHTML = '<p style="color:red; padding:1rem;">API error</p>';
      return;
    }

    const raw = Object.entries(factionData.members || {});
    const countEl = document.getElementById('nb-count');
    if (countEl) countEl.textContent = raw.length + ' members';

    members = raw.map(([id, m]) => ({
      id, name: m.name, position: m.position,
      racing_skill: 0, racing_wins: 0, races_entered: 0, racing_ratio: 0, racing_points: 0
    }));

    const total = members.length;
    let done = 0;
    const prog = document.getElementById('nb-progress');
    if (prog) prog.style.display = 'block';

    for (let i = 0; i < members.length; i++) {
      const m = members[i];
      const d = await fetchWithRetry('https://api.torn.com/user/' + m.id + '?selections=personalstats&key=' + API_KEY);
      if (d && d.personalstats) {
        m.racing_skill  = Number(d.personalstats.racingskill)          || 0;
        m.racing_wins   = Number(d.personalstats.raceswon)           || 0;
        m.racing_points = Number(d.personalstats.racingpointsearned)|| 0;
        m.races_entered = Number(d.personalstats.racesentered)      || 0;
        
        // Calculate Win-to-Race Efficiency Ratio safely
        m.racing_ratio  = m.races_entered > 0 ? (m.racing_wins / m.races_entered) * 100 : 0;
      }
      done++;
      if (prog) prog.textContent = 'Fetching Profile Data (' + done + ' / ' + total + ')...';
      await delay(650);
    }

    if (prog) prog.style.display = 'none';

    const skills = members.map(m => m.racing_skill ?? 0);
    maxSkill = Math.max(...skills, 1);
    const withSkill = skills.filter(s => s > 0);
    const avg = withSkill.length ? (withSkill.reduce((a, b) => a + b, 0) / withSkill.length).toFixed(2) : 0;
    const top = Math.max(...skills).toFixed(2);

    const statsEl = document.getElementById('nb-stats');
    if (statsEl) {
      statsEl.innerHTML = statCard('Total', members.length) + statCard('Top', top) + statCard('Avg', avg) + statCard('Active', withSkill.length);
    }
    render();
  }

  if (window.location.href.includes('sid=racing')) { init(); }
})();
