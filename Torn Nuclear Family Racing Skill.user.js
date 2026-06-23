// ==UserScript==
// @name         Nuclear Family Racing Skills - MultiFaction Edition (Hyper-Drive)
// @namespace    torn.com.nuclearfamily.strict
// @version      5.2
// @description  Deeply isolated multi-faction alliance dashboard. Upgraded with Dynamic Handicaps, Head-to-Head Compare, and Advanced League Analytics. Strict flat legacy syntax.
// @author       cowboyup
// @match        https://www.torn.com/page.php?sid=racing*
// @match        https://www.torn.com/loader.php?sid=racing*
// @license      MIT
// @grant        none
// ==/UserScript==

;(function (window, document) {
  'use strict';

  var CONFIG_STORAGE_KEY = 'nbf_v3_api_key';
  var CONFIG_THEME_KEY   = 'nbf_v3_theme';
  var CONFIG_CACHE_KEY   = 'nbf_v3_data_cache';
  var CONFIG_TIME_KEY    = 'nbf_v3_cache_time';
  var CACHE_DURATION     = 3600000;

  var TARGET_FACTIONS = [
    { id: 8085,  name: 'Nuclear Blast' },
    { id: 8954,  name: 'Nuclear Armageddon' },
    { id: 16282, name: 'Nuclear Winter' },
    { id: 12094, name: 'Nuclear Fusion' },
    { id: 21028, name: 'Nuclear Clinic' },
    { id: 13851, name: 'Nuclear Therapy' },
    { id: 17133, name: 'Torn Medical' },
    { id: 366,   name: 'Evolution' },
    { id: 15222, name: 'Ionization' },
    { id: 9754,  name: 'Emergency Room' }
  ];

  var STATE_API_KEY       = localStorage.getItem(CONFIG_STORAGE_KEY) || '';
  var STATE_DARK_MODE     = localStorage.getItem(CONFIG_THEME_KEY) === 'dark';
  var RUNTIME_MEMBERS     = [];
  var RUNTIME_MAX_SKILL   = 100;
  var FLAG_IS_FETCHING    = false;
  
  var STATE_COMPARE_A     = '';
  var STATE_COMPARE_B     = '';

  var ENGINE_VERSION = '5.2';

  var cssStyleNode = document.createElement('style');
  cssStyleNode.id = 'nbf-isolated-pure-styles';
  (document.head || document.documentElement).appendChild(cssStyleNode);

  function dynamicCSSRefresh() {
    var bgHeader   = STATE_DARK_MODE ? '#1e293b' : '#ffffff';
    var textHeader = STATE_DARK_MODE ? '#94a3b8' : '#64748b';
    var bldColor   = STATE_DARK_MODE ? '#334155' : '#cbd5e1';

    cssStyleNode.textContent =
      '#nbf-frame-scrollbox { overflow-y: auto !important; overflow-x: auto !important; flex: 1 !important; height: 100% !important; position: relative !important; }' +
      '#nbf-table-view { width: 100% !important; border-collapse: separate !important; border-spacing: 0 !important; font-size: 11px !important; min-width: 720px !important; }' +
      '#nbf-table-view thead th { position: sticky !important; top: 0 !important; z-index: 9999 !important; background-color: ' + bgHeader + ' !important; color: ' + textHeader + ' !important; font-weight: 600 !important; padding: 12px 4px 10px 14px !important; text-align: left !important; border-bottom: 2px solid ' + bldColor + ' !important; }' +
      '#nbf-table-view th:first-child { padding-left: 14px !important; }' +
      '#nbf-table-view th:last-child { padding-right: 14px !important; }' +
      '.nbf-row-selected { background: rgba(99, 102, 241, 0.15) !important; }';
  }

  function mountFloatingInterface() {
    if (document.getElementById('nbf-action-trigger-button')) return;
    if (!document.body) return;

    var floatingActionBtn = document.createElement('button');
    floatingActionBtn.id = 'nbf-action-trigger-button';
    floatingActionBtn.textContent = '⚡ Nuclear Hyper-Drive';

    floatingActionBtn.style.cssText = 'position: fixed !important; bottom: 170px !important; right: 16px !important; z-index: 999999 !important; background: #6366f1 !important; color: #ffffff !important; border: none !important; border-radius: 8px !important; padding: 10px 18px !important; font-size: 14px !important; font-weight: 600 !important; cursor: pointer !important; box-shadow: 0 2px 8px rgba(0,0,0,0.3) !important; display: block !important;';

    document.body.appendChild(floatingActionBtn);

    floatingActionBtn.addEventListener('click', function(e) {
      e.preventDefault();
      e.stopPropagation();

      var existingBackdrop = document.getElementById('nbf-backdrop-mask');
      if (existingBackdrop) {
        existingBackdrop.parentNode.removeChild(existingBackdrop);
      } else {
        renderModalInterface();
      }
    });
  }

  function renderModalInterface() {
    dynamicCSSRefresh();

    var backdropMask = document.createElement('div');
    backdropMask.id = 'nbf-backdrop-mask';
    backdropMask.style.cssText = 'position: fixed !important; top: 0 !important; left: 0 !important; width: 100vw !important; height: 100vh !important; background: rgba(0, 0, 0, 0.75) !important; z-index: 2147483640 !important; display: flex !important; align-items: center !important; justify-content: center !important; box-sizing: border-box !important; padding: 12px !important;';

    var modalContainer = document.createElement('div');
    modalContainer.id = 'nbf-modal-container';
    applyModalThemeMatrix(modalContainer);

    var viewHtml = '<div id="nbf-layout-header" style="padding:14px; border-bottom:1px solid var(--nbf-bld); display:flex; align-items:center; gap:8px; flex-wrap:wrap; background:var(--nbf-alt);">';
    viewHtml += '<span style="font-size:15px; font-weight:600; color:var(--nbf-txt);">Nuclear Alliance Hyper-Dashboard</span>';
    viewHtml += '<span style="font-size:10px; color:var(--nbf-mut); background:var(--nbf-bdg); border:1px solid var(--nbf-bld); padding:1px 5px; border-radius:4px;">v' + ENGINE_VERSION + '</span>';
    viewHtml += '<button id="nbf-ctrl-theme" style="font-size:13px; background:none; border:none; cursor:pointer; padding:2px 4px; border-radius:4px;">' + (STATE_DARK_MODE ? '☀️' : '🌙') + '</button>';
    viewHtml += '<span id="nbf-txt-counter" style="font-size:11px; color:var(--nbf-txt); background:var(--nbf-bdg); padding:2px 8px; border-radius:20px;">Loading...</span>';
    viewHtml += '<span id="nbf-txt-cache" style="font-size:11px; font-weight:600;"></span>';
    viewHtml += '<div style="margin-left:auto; display:flex; gap:6px; flex-wrap:wrap; width:100%; margin-top:8px;">';
    
    viewHtml += '<select id="nbf-field-faction" style="padding:6px 6px; border:1px solid var(--nbf-btn-border); border-radius:6px; font-size:12px; flex:1.5; min-width:130px; background:var(--nbf-field-bg); color:var(--nbf-txt);"><option value="all">All Factions</option>';
    TARGET_FACTIONS.forEach(function(fac) {
        viewHtml += '<option value="' + fac.id + '">' + fac.name + '</option>';
    });
    viewHtml += '</select>';

    viewHtml += '<input id="nbf-field-search" type="text" placeholder="Search name..." style="padding:6px 8px; border:1px solid var(--nbf-btn-border); border-radius:6px; font-size:12px; flex:2; min-width:100px; background:var(--nbf-field-bg); color:var(--nbf-txt);" />';
    viewHtml += '<select id="nbf-field-sort" style="padding:6px 6px; border:1px solid var(--nbf-btn-border); border-radius:6px; font-size:12px; flex:1; background:var(--nbf-field-bg); color:var(--nbf-txt);"><option value="racing_skill">Skill</option><option value="racing_ratio">Ratio %</option><option value="racing_wins">Wins</option><option value="racing_points">Points</option><option value="handicap">Handicap</option><option value="name">Name</option></select>';
    viewHtml += '<select id="nbf-field-direction" style="padding:6px 6px; border:1px solid var(--nbf-btn-border); border-radius:6px; font-size:12px; background:var(--nbf-field-bg); color:var(--nbf-txt);"><option value="desc">Desc</option><option value="asc">Asc</option></select>';
    viewHtml += '<button id="nbf-btn-sync" style="padding:6px 10px; border:1px solid var(--nbf-btn-border); border-radius:6px; font-size:12px; cursor:pointer; background:#16a34a; color:#fff; font-weight:600;">🔄 Sync</button>';
    viewHtml += '<button id="nbf-btn-auth" style="padding:6px 10px; border:1px solid var(--nbf-btn-border); border-radius:6px; font-size:12px; cursor:pointer; background:var(--nbf-btn-base); color:var(--nbf-txt);">🔑</button>';
    viewHtml += '<button id="nbf-btn-csv" style="padding:6px 12px; border:1px solid var(--nbf-btn-border); border-radius:6px; font-size:12px; cursor:pointer; background:var(--nbf-btn-acc); color:var(--nbf-btn-acc-txt); font-weight:600;">📥 Export</button>';
    viewHtml += '<button id="nbf-btn-close" style="padding:6px 12px; border:1px solid var(--nbf-btn-border); border-radius:6px; font-size:12px; cursor:pointer; background:var(--nbf-btn-base); color:var(--nbf-txt); font-weight:600;">✕ Close</button>';
    viewHtml += '</div></div>';
    
    viewHtml += '<div id="nbf-layout-duel" style="display:none; padding:10px 14px; background:linear-gradient(90deg, #312e81, #1e1b4b); color:#fff; border-bottom:1px solid #4338ca; align-items:center; justify-content:space-between; flex-wrap:wrap; gap:10px;"></div>';
    
    viewHtml += '<div id="nbf-layout-summary" style="display:flex; gap:6px; padding:10px 14px; border-bottom:1px solid var(--nbf-bld); flex-wrap:wrap; background:var(--nbf-alt2);"></div>';
    viewHtml += '<div id="nbf-layout-progress" style="text-align:center; font-size:11px; color:#1e40af; font-weight:bold; padding:6px 0; background:#eff6ff; border-bottom:1px solid #bfdbfe; display:none;"></div>';
    viewHtml += '<div id="nbf-frame-scrollbox" style="background:var(--nbf-main);"><div id="nbf-layout-body" style="padding:0;"><p style="padding:2rem; text-align:center; color:var(--nbf-mut);">Loading league grid telemetry...</p></div></div>';

    modalContainer.innerHTML = viewHtml;
    backdropMask.appendChild(modalContainer);
    document.body.appendChild(backdropMask);

    document.getElementById('nbf-btn-close').addEventListener('click', function() { backdropMask.parentNode.removeChild(backdropMask); });
    backdropMask.addEventListener('click', function(e) { if (e.target === backdropMask) backdropMask.parentNode.removeChild(backdropMask); });

    document.getElementById('nbf-field-faction').addEventListener('change', function() {
      runTableRenderer();
      refreshSummaryCards();
    });
    document.getElementById('nbf-field-search').addEventListener('input', runTableRenderer);
    document.getElementById('nbf-field-sort').addEventListener('change', runTableRenderer);
    document.getElementById('nbf-field-direction').addEventListener('change', runTableRenderer);
    document.getElementById('nbf-btn-auth').addEventListener('click', function() { displayKeySetupPanel(modalContainer, function() { baseCacheRouter(true); }); });
    document.getElementById('nbf-btn-csv').addEventListener('click', processDataExportToCSV);
    document.getElementById('nbf-btn-sync').addEventListener('click', function() { if(!FLAG_IS_FETCHING) baseCacheRouter(true); });

    document.getElementById('nbf-ctrl-theme').addEventListener('click', function() {
      STATE_DARK_MODE = !STATE_DARK_MODE;
      localStorage.setItem(CONFIG_THEME_KEY, STATE_DARK_MODE ? 'dark' : 'light');
      document.getElementById('nbf-ctrl-theme').textContent = STATE_DARK_MODE ? '☀️' : '🌙';
      dynamicCSSRefresh();
      applyModalThemeMatrix(modalContainer);
      runTableRenderer();
      refreshSummaryCards();
    });

    if (!STATE_API_KEY) { displayKeySetupPanel(modalContainer, function() { baseCacheRouter(true); }); } else { baseCacheRouter(false); }
  }

  function applyModalThemeMatrix(domElement) {
    if (STATE_DARK_MODE) {
      domElement.style.cssText = 'width: 95vw !important; max-width: 920px !important; height: 85vh !important; max-height: 720px !important; background: #111827 !important; color: #f3f4f6 !important; border-radius: 12px !important; box-shadow: 0 12px 36px rgba(0,0,0,0.6) !important; display: flex !important; flex-direction: column !important; font-family: Arial, sans-serif !important; font-size: 13px !important; box-sizing: border-box !important; overflow: hidden !important; --nbf-main: #111827; --nbf-alt: #1f2937; --nbf-alt2: #1e293b; --nbf-txt: #f3f4f6; --nbf-mut: #9ca3af; --nbf-bld: #374151; --nbf-btn-border: #4b5563; --nbf-bdg: #374151; --nbf-field-bg: #1f2937; --nbf-btn-base: #374151; --nbf-btn-acc: #1e40af; --nbf-btn-acc-txt: #ffffff;';
    } else {
      domElement.style.cssText = 'width: 95vw !important; max-width: 920px !important; height: 85vh !important; max-height: 720px !important; background: #fff !important; color: #111 !important; border-radius: 12px !important; box-shadow: 0 12px 36px rgba(0,0,0,0.4) !important; display: flex !important; flex-direction: column !important; font-family: Arial, sans-serif !important; font-size: 13px !important; box-sizing: border-box !important; overflow: hidden !important; --nbf-main: #ffffff; --nbf-alt: #fcfcfc; --nbf-alt2: #f8fafc; --nbf-txt: #111111; --nbf-mut: #64748b; --nbf-bld: #e5e5e5; --nbf-btn-border: #cccccc; --nbf-bdg: #e2e8f0; --nbf-field-bg: #ffffff; --nbf-btn-base: #f1f5f9; --nbf-btn-acc: #e2e8f0; --nbf-btn-acc-txt: #0f172a;';
    }
  }

  function displayKeySetupPanel(modalWrapper, triggerOnSuccess) {
    var layoutBody = document.getElementById('nbf-layout-body');
    var summaries  = document.getElementById('nbf-layout-summary');
    var counterText= document.getElementById('nbf-txt-counter');
    var facDrop    = document.getElementById('nbf-field-faction');
    var searchBar  = document.getElementById('nbf-field-search');
    var dropdown1  = document.getElementById('nbf-field-sort');
    var dropdown2  = document.getElementById('nbf-field-direction');

    if (summaries) summaries.style.display = 'none';
    if (counterText) counterText.textContent = 'Setup';
    if (facDrop) facDrop.style.display = 'none';
    if (searchBar) searchBar.style.display = 'none';
    if (dropdown1) dropdown1.style.display = 'none';
    if (dropdown2) dropdown2.style.display = 'none';

    var keyLength = STATE_API_KEY ? STATE_API_KEY.trim().length : 0;
    var cleanMask = '';
    if (keyLength > 0) {
      cleanMask = STATE_API_KEY.trim().slice(0, 4);
      for (var m = 0; m < Math.max(0, keyLength - 4); m++) { cleanMask += '•'; }
    }

    var initializationHtml = '<div style="display:flex; flex-direction:column; align-items:center; justify-content:center; padding:1rem; background:var(--nbf-main);">';
    initializationHtml += '<div style="width:100%; max-width:420px; background:var(--nbf-alt2); border:1px solid var(--nbf-bld); border-radius:10px; padding:24px 20px;">';
    initializationHtml += '<div style="font-size:15px; font-weight:600; color:var(--nbf-txt); margin-bottom:4px;">Enter your Family Alliance Key</div>';
    initializationHtml += '<div style="font-size:12px; color:var(--nbf-mut); margin-bottom:16px; line-height:1.5;">Saved locally inside your browser sandbox structure. Only explicitly shared with <code style="font-size:11px; background:var(--nbf-bdg); color:var(--nbf-txt); padding:1px 5px; border-radius:4px;">api.torn.com</code>.</div>';
    initializationHtml += '<position:relative; display:flex; align-items:center; margin-bottom:8px;">';
    initializationHtml += '<input id="nbf-auth-entry" type="password" placeholder="' + (cleanMask ? 'Current: ' + cleanMask : 'Paste your API key here...') + '" autocomplete="off" style="width:100%; padding:8px 36px 8px 10px; border:1px solid var(--nbf-btn-border); border-radius:6px; font-size:13px; box-sizing:border-box; background:var(--nbf-field-bg); color:var(--nbf-txt);" />';
    initializationHtml += '<button id="nbf-auth-reveal" style="position:absolute; right:8px; background:none; border:none; cursor:pointer; font-size:14px; color:var(--nbf-mut); padding:0;">👁</button></div>';
    initializationHtml += '<div id="nbf-auth-warning" style="font-size:11px; color:#c62828; margin-bottom:8px; display:none;">Please enter a valid API key.</div>';
    initializationHtml += '<div style="display:flex; gap:8px; margin-top:4px;"><button id="nbf-auth-commit" style="flex:1; padding:9px; background:#185FA5; color:#fff; border:none; border-radius:6px; font-size:13px; font-weight:600; cursor:pointer;">Save and load data</button>';
    initializationHtml += (STATE_API_KEY ? '<button id="nbf-auth-wipe" style="padding:9px 14px; background:var(--nbf-field-bg); color:#c62828; border:1px solid #fca5a5; border-radius:6px; font-size:13px; cursor:pointer;">Clear</button>' : '');
    initializationHtml += '</div></div></div>';

    layoutBody.innerHTML = initializationHtml;

    document.getElementById('nbf-auth-reveal').addEventListener('click', function() {
      var field = document.getElementById('nbf-auth-entry');
      field.type = field.type === 'password' ? 'text' : 'password';
    });

    var purgeButton = document.getElementById('nbf-auth-wipe');
    if (purgeButton) {
      purgeButton.addEventListener('click', function() {
        STATE_API_KEY = '';
        localStorage.removeItem(CONFIG_STORAGE_KEY);
        document.getElementById('nbf-auth-entry').value = '';
        document.getElementById('nbf-auth-entry').placeholder = 'Paste your API key here...';
        purgeButton.parentNode.removeChild(purgeButton);
      });
    }

    document.getElementById('nbf-auth-commit').addEventListener('click', function() {
      var field = document.getElementById('nbf-auth-entry');
      var standardValue = field.value.trim();
      if (!standardValue && !STATE_API_KEY) { document.getElementById('nbf-auth-warning').style.display = 'block'; return; }
      if (standardValue) { STATE_API_KEY = standardValue; localStorage.setItem(CONFIG_STORAGE_KEY, STATE_API_KEY); }
      if (summaries) summaries.style.display = '';
      if (counterText) counterText.textContent = 'Loading...';
      if (facDrop) facDrop.style.display = '';
      if (searchBar) searchBar.style.display = '';
      if (dropdown1) dropdown1.style.display = '';
      if (dropdown2) dropdown2.style.display = '';
      layoutBody.innerHTML = '<p style="padding:2rem; text-align:center; color:var(--nbf-mut);">Preparing connection...</p>';
      RUNTIME_MEMBERS = [];
      triggerOnSuccess();
    });
  }

  function resolveRankBadge(skillPoints) {
    if (skillPoints >= 100) return { title: 'Grand Champion', bg: '#fef3c7', text: '#b45309' };
    if (skillPoints >= 75)  return { title: 'Master Elite',   bg: '#f3e8ff', text: '#6b21a8' };
    if (skillPoints >= 50)  return { title: 'Expert Driver', bg: '#e0f2fe', text: '#0369a1' };
    if (skillPoints >= 35)  return { title: 'Veteran',       bg: '#dcfce7', text: '#15803d' };
    if (skillPoints >= 20)  return { title: 'Advanced',      bg: '#f1f5f9', text: '#334155' };
    if (skillPoints >= 10)  return { title: 'Amateur',       bg: '#ffedd5', text: '#c2410c' };
    return                         { title: 'Rookie',        bg: (STATE_DARK_MODE ? '#374151' : '#f3f4f6'), text: (STATE_DARK_MODE ? '#9ca3af' : '#4b5563') };
  }

  function renderStatModule(label, metric) {
    return '<div style="background:var(--nbf-main); border:1px solid var(--nbf-bld); border-radius:6px; padding:6px 10px; min-width:75px; flex:1;"><div style="font-size:10px; color:var(--nbf-mut); text-transform:uppercase;">' + label + '</div><div style="font-size:14px; font-weight:600; color:var(--nbf-txt); white-space:nowrap; overflow:hidden; text-overflow:ellipsis;">' + metric + '</div></div>';
  }

  function parseRuntimePipeline() {
    var facEl = document.getElementById('nbf-field-faction');
    var selectedFactionId = facEl ? facEl.value : 'all';

    var searchEl = document.getElementById('nbf-field-search');
    var filteringKey = (searchEl ? searchEl.value : '').toLowerCase();

    var sortEl = document.getElementById('nbf-field-sort');
    var sortedProperty = sortEl ? sortEl.value : 'racing_skill';

    var dirEl = document.getElementById('nbf-field-direction');
    var directionMode = dirEl ? dirEl.value : 'desc';

    var dataPool = RUNTIME_MEMBERS.filter(function(item) {
      if (selectedFactionId !== 'all' && String(item.factionId) !== selectedFactionId) return false;
      return item.name.toLowerCase().indexOf(filteringKey) !== -1;
    });

    dataPool.forEach(function(item) {
      var skill = item.racing_skill !== undefined ? item.racing_skill : 0;
      item.handicap = Math.max(0, RUNTIME_MAX_SKILL - skill);
    });

    dataPool.sort(function(alpha, beta) {
      var nodeA = alpha[sortedProperty] !== undefined ? alpha[sortedProperty] : 0;
      var nodeB = beta[sortedProperty] !== undefined ? beta[sortedProperty] : 0;
      if (typeof nodeA === 'string') { nodeA = nodeA.toLowerCase(); nodeB = nodeB.toLowerCase(); }
      if (nodeA < nodeB) return directionMode === 'asc' ? -1 : 1;
      if (nodeA > nodeB) return directionMode === 'asc' ?  1 : -1;
      return 0;
    });

    return dataPool;
  }

  function processDataExportToCSV() {
    if (!RUNTIME_MEMBERS || RUNTIME_MEMBERS.length === 0) return;

    var targetStack = parseRuntimePipeline();
    var computedCSV = 'Index,User ID,Name,Faction,Rank,Racing Skill,Wins,Runs,Ratio %,Points,Handicap Offset\n';

    targetStack.forEach(function(member, cursor) {
      var skillsVal = member.racing_skill !== undefined ? member.racing_skill : 0;
      var rankBadge = resolveRankBadge(skillsVal);
      var outputRatio = (member.racing_ratio !== undefined ? member.racing_ratio : 0).toFixed(1) + '%';
      var handicapVal = member.handicap !== undefined ? member.handicap.toFixed(2) : '0.00';
      var rowData = [
        cursor + 1, member.id, '"' + member.name.split('"').join('""') + '"', '"' + (member.factionName || '—').split('"').join('""') + '"',
        rankBadge.title, skillsVal.toFixed(2), member.racing_wins !== undefined ? member.racing_wins : 0,
        member.races_entered !== undefined ? member.races_entered : 0, outputRatio, member.racing_points !== undefined ? member.racing_points : 0, handicapVal
      ];
      computedCSV += rowData.join(',') + '\n';
    });

    var storageBlob = new Blob([computedCSV], { type: 'text/csv;charset=utf-8;' });
    var downloadHook = document.createElement('a');
    downloadHook.setAttribute('href', URL.createObjectURL(storageBlob));
    downloadHook.setAttribute('download', 'Nuclear_League_Racing_Telemetry.csv');
    downloadHook.style.visibility = 'hidden';
    document.body.appendChild(downloadHook);
    downloadHook.click();
    document.body.removeChild(downloadHook);
  }

  function runTableRenderer() {
    var dataset = parseRuntimePipeline();

    var separationLineStyle = STATE_DARK_MODE ? 'border-bottom:1px solid #1f2937;' : 'border-bottom:1px solid #f1f5f9;';
    var dynamicAnchorColor  = STATE_DARK_MODE ? '#60a5fa' : '#1d6fa4';
    var descriptionMutedText = STATE_DARK_MODE ? '#9ca3af' : '#475569';
    var highlightBoldText   = STATE_DARK_MODE ? '#f3f4f6' : '#0f172a';

    var sortEl = document.getElementById('nbf-field-sort');
    var sortedProperty = sortEl ? sortEl.value : 'racing_skill';
    var dirEl = document.getElementById('nbf-field-direction');
    var directionMode = dirEl ? dirEl.value : 'desc';

    var markupRows = dataset.map(function(player, slot) {
      var absoluteSkill = player.racing_skill !== undefined ? player.racing_skill : 0;
      var progressWidth = RUNTIME_MAX_SKILL > 0 ? Math.round((absoluteSkill / RUNTIME_MAX_SKILL) * 100) : 0;
      var badgeObject   = resolveRankBadge(absoluteSkill);
      var calculatedRatio = (player.racing_ratio !== undefined ? player.racing_ratio : 0).toFixed(1) + '%';
      var handicapDisplay = player.handicap !== undefined ? '+' + player.handicap.toFixed(1) : '0.0';

      var rowClass = '';
      if (String(player.id) === STATE_COMPARE_A || String(player.id) === STATE_COMPARE_B) {
        rowClass = ' class="nbf-row-selected"';
      }

      var rowString = '<tr' + rowClass + ' style="' + separationLineStyle + ' cursor:pointer;" data-pid="' + player.id + '">';
      rowString += '<td style="padding:8px 14px; color:var(--nbf-mut);">' + (slot + 1) + '</td>';
      rowString += '<td style="padding:8px 4px;"><a href="https://www.torn.com/profiles.php?XID=' + player.id + '" target="_blank" style="color:' + dynamicAnchorColor + '; text-decoration:none; font-weight:600;" onclick="event.stopPropagation();">' + player.name + '</a></td>';
      rowString += '<td style="padding:8px 4px; color:' + descriptionMutedText + '; white-space: nowrap; overflow: hidden; text-overflow: ellipsis; max-width: 120px;" title="' + player.factionName + '">' + (player.factionName || '—') + '</td>';
      rowString += '<td style="padding:8px 4px;"><span style="background:' + badgeObject.bg + '; color:' + badgeObject.text + '; font-size:10px; padding:1px 6px; border-radius:20px;">' + badgeObject.title + '</span></td>';
      rowString += '<td style="padding:8px 4px;"><div style="display:flex; align-items:center; gap:4px;"><div style="flex:1; height:5px; border-radius:3px; background:var(--nbf-bdg); min-width:40px;"><div style="width:' + progressWidth + '%; height:100%; border-radius:3px; background:#6366f1;"></div></div><span style="font-size:11px; color:' + descriptionMutedText + '; min-width:28px; text-align:right;">' + absoluteSkill.toFixed(2) + '</span></div></td>';
      rowString += '<td style="padding:8px 4px; color:' + descriptionMutedText + ';">' + (slot === 0 && directionMode === 'desc' ? '🥇 ' : '') + (player.racing_wins !== undefined ? player.racing_wins : '—') + '</td>';
      rowString += '<td style="padding:8px 4px; color:' + descriptionMutedText + ';">' + (player.races_entered !== undefined ? player.races_entered : '—') + '</td>';
      rowString += '<td style="padding:8px 4px; font-weight:600; color:' + highlightBoldText + ';">' + calculatedRatio + '</td>';
      rowString += '<td style="padding:8px 4px; color:' + descriptionMutedText + ';">' + (player.racing_points !== undefined ? player.racing_points : '—') + '</td>';
      rowString += '<td style="padding:8px 14px 8px 4px; font-weight:600; color:#e11d48;">' + handicapDisplay + '</td>';
      rowString += '</tr>';
      return rowString;
    }).join('');

    var targetBodyDOM = document.getElementById('nbf-layout-body');
    if (!targetBodyDOM) return;
    targetBodyDOM.innerHTML = '<table id="nbf-table-view"><thead><tr><th>#</th><th>Driver</th><th>Faction</th><th>Tier</th><th>Skill Matrix</th><th>Wins</th><th>Runs</th><th>Efficiency</th><th>Pts</th><th>Handicap</th></tr></thead><tbody>' + markupRows + '</tbody></table>';

    var rows = targetBodyDOM.querySelectorAll('tbody tr');
    for (var r = 0; r < rows.length; r++) {
      rows[r].addEventListener('click', function() {
        var pid = this.getAttribute('data-pid');
        toggleDuelSelection(pid);
      });
    }
  }

  function toggleDuelSelection(playerId) {
    if (STATE_COMPARE_A === playerId) {
      STATE_COMPARE_A = '';
    } else if (STATE_COMPARE_B === playerId) {
      STATE_COMPARE_B = '';
    } else if (!STATE_COMPARE_A) {
      STATE_COMPARE_A = playerId;
    } else if (!STATE_COMPARE_B) {
      STATE_COMPARE_B = playerId;
    } else {
      STATE_COMPARE_A = playerId;
    }
    renderDuelInterface();
    runTableRenderer();
  }

  function renderDuelInterface() {
    var box = document.getElementById('nbf-layout-duel');
    if (!box) return;

    if (!STATE_COMPARE_A || !STATE_COMPARE_B) {
      box.style.display = 'none';
      return;
    }

    var pA = RUNTIME_MEMBERS.filter(function(m) { return String(m.id) === STATE_COMPARE_A; })[0];
    var pB = RUNTIME_MEMBERS.filter(function(m) { return String(m.id) === STATE_COMPARE_B; })[0];

    if (!pA || !pB) {
      box.style.display = 'none';
      return;
    }

    box.style.display = 'flex';
    var html = '<div style="font-weight:700; font-size:12px; color:#a5b4fc; text-transform:uppercase; letter-spacing:0.5px;">⚔️ Live Head-to-Head Compare:</div>';
    html += '<div style="display:flex; gap:20px; flex:1; justify-content:center; align-items:center; font-size:12px;">';
    html += '<div><strong>' + pA.name + '</strong> Skill: ' + pA.racing_skill.toFixed(2) + ' | Wins: ' + pA.racing_wins + ' (' + pA.racing_ratio.toFixed(1) + '%)</div>';
    html += '<div style="font-weight:bold; color:#f43f5e;">VS</div>';
    html += '<div><strong>' + pB.name + '</strong> Skill: ' + pB.racing_skill.toFixed(2) + ' | Wins: ' + pB.racing_wins + ' (' + pB.racing_ratio.toFixed(1) + '%)</div>';
    html += '</div>';
    html += '<button id="nbf-btn-clear-duel" style="background:#4338ca; border:none; color:#fff; padding:4px 8px; border-radius:4px; font-size:11px; cursor:pointer; font-weight:600;">Clear Duel</button>';
    box.innerHTML = html;

    document.getElementById('nbf-btn-clear-duel').addEventListener('click', function() {
      STATE_COMPARE_A = '';
      STATE_COMPARE_B = '';
      box.style.display = 'none';
      runTableRenderer();
    });
  }

  function refreshSummaryCards() {
    var dataset = parseRuntimePipeline();
    var panelSummaryElement = document.getElementById('nbf-layout-summary');
    if (!panelSummaryElement) return;

    if (dataset.length === 0) {
      panelSummaryElement.innerHTML = renderStatModule('Active Racers', 0) + renderStatModule('Top Performance', '0.00') + renderStatModule('Avg Skill Line', '0.00') + renderStatModule('Top Dog', 'None');
      return;
    }

    var analyticsArray = dataset.map(function(memberItem) { return memberItem.racing_skill !== undefined ? memberItem.racing_skill : 0; });
    var validRacers    = analyticsArray.filter(function(skillPoints) { return skillPoints > 0; });

    var summedSkill = 0;
    for (var s = 0; s < validRacers.length; s++) { summedSkill += validRacers[s]; }

    var averagedSkill  = validRacers.length ? (summedSkill / validRacers.length).toFixed(2) : 0;
    var premiumSkill   = Math.max.apply(Math, analyticsArray);
    
    var leadDriverName = 'None';
    for (var i = 0; i < dataset.length; i++) {
      if (dataset[i].racing_skill === premiumSkill) {
        leadDriverName = dataset[i].name;
        break;
      }
    }

    panelSummaryElement.innerHTML = 
      renderStatModule('Filtered Racers', dataset.length) + 
      renderStatModule('Top Performance', premiumSkill.toFixed(2)) + 
      renderStatModule('Avg Skill Line', averagedSkill) + 
      renderStatModule('Top Dog 👑', leadDriverName);
  }

  function executeAsyncDelay(timeoutValue, callback) { setTimeout(callback, timeoutValue); }

  function securedAPIPacketFetch(endpointUrl, successCallback, failureCallback, maxRetryCycles, currentCycle, targetDelayStep) {
    if (maxRetryCycles === undefined) maxRetryCycles = 3;
    if (currentCycle === undefined) currentCycle = 0;
    if (targetDelayStep === undefined) targetDelayStep = 2000;

    var trackedDestinationUrl = endpointUrl + (endpointUrl.indexOf('?') !== -1 ? '&' : '?') + 'comment=NBF_Hyper_v' + ENGINE_VERSION;

    var xhr = new XMLHttpRequest();
    xhr.open('GET', trackedDestinationUrl, true);
    xhr.onreadystatechange = function () {
      if (xhr.readyState === 4) {
        if (xhr.status === 200) {
          try {
            var structureJson = JSON.parse(xhr.responseText);
            if (structureJson.error && (structureJson.error.code === 5 || structureJson.error.code === 8)) {
              if (currentCycle < maxRetryCycles) {
                var progressBox = document.getElementById('nbf-layout-progress');
                if (progressBox) progressBox.textContent = 'Rate limited! Sync backoff cooling down...';
                executeAsyncDelay(targetDelayStep, function() {
                  securedAPIPacketFetch(endpointUrl, successCallback, failureCallback, maxRetryCycles, currentCycle + 1, targetDelayStep * 2);
                });
              } else {
                failureCallback();
              }
            } else {
              successCallback(structureJson);
            }
          } catch(e) {
            failureCallback();
          }
        } else {
          if (currentCycle < maxRetryCycles) {
            executeAsyncDelay(1000, function() {
              securedAPIPacketFetch(endpointUrl, successCallback, failureCallback, maxRetryCycles, currentCycle + 1, targetDelayStep);
            });
          } else {
            failureCallback();
          }
        }
      }
    };
    xhr.send();
  }

  function baseCacheRouter(forceInvalidationSignal) {
    var historicalTimeMarker = localStorage.getItem(CONFIG_TIME_KEY);
    var historicalCacheBlob  = localStorage.getItem(CONFIG_CACHE_KEY);
    var runtimeStatusField    = document.getElementById('nbf-txt-cache');

    if (!forceInvalidationSignal && historicalTimeMarker && historicalCacheBlob && (Date.now() - Number(historicalTimeMarker) < CACHE_DURATION)) {
      RUNTIME_MEMBERS = JSON.parse(historicalCacheBlob);
      var totalCounterNode = document.getElementById('nbf-txt-counter');
      if (totalCounterNode) totalCounterNode.textContent = RUNTIME_MEMBERS.length + ' members';
      if (runtimeStatusField) {
        runtimeStatusField.style.color = '#16a34a';
        runtimeStatusField.textContent = '⚡ Cached Engine Operational';
      }
      var collectedSkills = RUNTIME_MEMBERS.map(function(member) { return member.racing_skill !== undefined ? member.racing_skill : 0; });
      RUNTIME_MAX_SKILL = Math.max.apply(Math, collectedSkills);
      if (RUNTIME_MAX_SKILL < 1) RUNTIME_MAX_SKILL = 1;
      refreshSummaryCards();
      runTableRenderer();
    } else {
      if (FLAG_IS_FETCHING) return;
      if (runtimeStatusField) {
        runtimeStatusField.style.color = '#eab308';
        runtimeStatusField.textContent = '☁️ Syncing Alliance Core';
      }
      processNetworkTelemetryPipeline();
    }
  }

  function processNetworkTelemetryPipeline() {
    FLAG_IS_FETCHING = true;
    var stackBuilder = [];
    var notificationProgressBar = document.getElementById('nbf-layout-progress');

    if (notificationProgressBar) {
      notificationProgressBar.style.display = 'block';
      notificationProgressBar.textContent = 'Mapping cluster signatures...';
    }

    var factionIndex = 0;
    function fetchNextFaction() {
      if (factionIndex >= TARGET_FACTIONS.length) {
        processMembersData(stackBuilder);
        return;
      }

      var activeGroup = TARGET_FACTIONS[factionIndex];
      if (notificationProgressBar) notificationProgressBar.textContent = 'Downloading roster: ' + activeGroup.name + '...';

      var url = 'https://api.torn.com/faction/' + activeGroup.id + '?selections=basic&key=' + STATE_API_KEY.trim();
      securedAPIPacketFetch(url, function(response) {
        if (response && !response.error && response.members) {
          Object.keys(response.members).forEach(function(profileId) {
            var profileObj = response.members[profileId];
            stackBuilder.push({
              id: profileId,
              name: profileObj.name,
              factionId: activeGroup.id,
              factionName: activeGroup.name,
              racing_skill: 0, racing_wins: 0, races_entered: 0, racing_ratio: 0, racing_points: 0
            });
          });
        }
        factionIndex++;
        executeAsyncDelay(250, fetchNextFaction);
      }, function() {
        factionIndex++;
        executeAsyncDelay(250, fetchNextFaction);
      });
    }

    fetchNextFaction();
  }

  function processMembersData(stackBuilder) {
    var notificationProgressBar = document.getElementById('nbf-layout-progress');
    if (stackBuilder.length === 0) {
      var mainBodyTarget = document.getElementById('nbf-layout-body');
      if (mainBodyTarget) mainBodyTarget.innerHTML = '<p style="color:red; padding:1rem;">API handshake failure or unauthorized keys. Please confirm verification settings.</p>';
      FLAG_IS_FETCHING = false;
      return;
    }

    RUNTIME_MEMBERS = stackBuilder;
    var globalCountText = document.getElementById('nbf-txt-counter');
    if (globalCountText) globalCountText.textContent = RUNTIME_MEMBERS.length + ' alliance members';

    var structuralTotal = RUNTIME_MEMBERS.length;
    var memberIndex = 0;

    function fetchNextMember() {
      if (memberIndex >= RUNTIME_MEMBERS.length) {
        completePipelineProcessing();
        return;
      }

      var trackingMemberNode = RUNTIME_MEMBERS[memberIndex];
      if (notificationProgressBar) {
        notificationProgressBar.textContent = 'Syncing Metrics [' + trackingMemberNode.factionName + '] (' + (memberIndex + 1) + ' / ' + structuralTotal + ')...';
      }

      var url = 'https://api.torn.com/user/' + trackingMemberNode.id + '?selections=personalstats&key=' + STATE_API_KEY.trim();
      securedAPIPacketFetch(url, function(individualProfilePayload) {
        if (individualProfilePayload && individualProfilePayload.personalstats) {
          trackingMemberNode.racing_skill  = Number(individualProfilePayload.personalstats.racingskill) || 0;
          trackingMemberNode.racing_wins   = Number(individualProfilePayload.personalstats.raceswon) || 0;
          trackingMemberNode.racing_points = Number(individualProfilePayload.personalstats.racingpointsearned) || 0;
          trackingMemberNode.races_entered = Number(individualProfilePayload.personalstats.racesentered) || 0;
          trackingMemberNode.racing_ratio  = trackingMemberNode.races_entered > 0 ? (trackingMemberNode.racing_wins / trackingMemberNode.races_entered) * 100 : 0;
        }
        memberIndex++;
        executeAsyncDelay(650, fetchNextMember);
      }, function() {
        memberIndex++;
        executeAsyncDelay(650, fetchNextMember);
      });
    }

    fetchNextMember();
  }

  function completePipelineProcessing() {
    var notificationProgressBar = document.getElementById('nbf-layout-progress');
    if (notificationProgressBar) notificationProgressBar.style.display = 'none';

    var calculatedSkillsArray = RUNTIME_MEMBERS.map(function(m) { return m.racing_skill !== undefined ? m.racing_skill : 0; });
    RUNTIME_MAX_SKILL = Math.max.apply(Math, calculatedSkillsArray);
    if (RUNTIME_MAX_SKILL < 1) RUNTIME_MAX_SKILL = 1;

    localStorage.setItem(CONFIG_CACHE_KEY, JSON.stringify(RUNTIME_MEMBERS));
    localStorage.setItem(CONFIG_TIME_KEY, Date.now().toString());

    var secondaryCacheLabel = document.getElementById('nbf-txt-cache');
    if (secondaryCacheLabel) {
      secondaryCacheLabel.style.color = '#16a34a';
      secondaryCacheLabel.textContent = '⚡ Cached Engine Operational';
    }

    FLAG_IS_FETCHING = false;
    refreshSummaryCards();
    runTableRenderer();
  }

  if (window.location.href.indexOf('sid=racing') !== -1) {
     if (document.readyState === 'loading') {
         document.addEventListener('DOMContentLoaded', mountFloatingInterface);
     } else {
         mountFloatingInterface();
     }
     setInterval(mountFloatingInterface, 1500);
  }
})(window, document);
