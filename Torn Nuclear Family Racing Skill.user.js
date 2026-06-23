// ==UserScript==
// @name         Torn Faction Racing Dashboard
// @namespace    http://tampermonkey.net/
// @version      5.4
// @description  Streamlined Racing Dashboard & Analytics (Medal Removed)
// @author       You
// @match        https://www.torn.com/loader.php?sid=racing*
// @grant        GM_xmlhttpRequest
// @connect      api.torn.com
// ==/UserScript==

(function() {
    'use strict';

    // --- APPLICATION STATE ---
    var STATE_DARK_MODE = true;
    var STATE_COMPARE_A = '';
    var STATE_COMPARE_B = '';
    var RUNTIME_MAX_SKILL = 10;
    var GLOBAL_PLAYER_DATA = [];
    var FILTERED_FACTION_ID = 'all';

    // --- MOCK OR PIPELINE INITIALIZER ---
    function parseRuntimePipeline() {
        if (!GLOBAL_PLAYER_DATA || GLOBAL_PLAYER_DATA.length === 0) {
            return [
                { id: 10001, name: "Driver_Alpha", factionId: "1", factionName: "Apex Racing", racing_skill: 8.45, racing_wins: 142, races_entered: 1200, racing_ratio: 11.8, racing_points: 450, handicap: 2.5 },
                { id: 10002, name: "SpeedyG", factionId: "1", factionName: "Apex Racing", racing_skill: 6.20, racing_wins: 95, races_entered: 980, racing_ratio: 9.7, racing_points: 210, handicap: 1.2 },
                { id: 10003, name: "Burnout", factionId: "2", factionName: "Veloce Crew", racing_skill: 9.12, racing_wins: 210, races_entered: 1500, racing_ratio: 14.0, racing_points: 680, handicap: 4.0 },
                { id: 10004, name: "DriftKing", factionId: "2", factionName: "Veloce Crew", racing_skill: 4.50, racing_wins: 30, races_entered: 500, racing_ratio: 6.0, racing_points: 90, handicap: 0.0 }
            ].filter(function(p) {
                return FILTERED_FACTION_ID === 'all' || String(p.factionId) === String(FILTERED_FACTION_ID);
            });
        }
        return GLOBAL_PLAYER_DATA.filter(function(p) {
            return FILTERED_FACTION_ID === 'all' || String(p.factionId) === String(FILTERED_FACTION_ID);
        });
    }

    function resolveRankBadge(skill) {
        if (skill >= 7.5) return { bg: '#ef4444', text: '#fff', title: 'Class A' };
        if (skill >= 5.0) return { bg: '#f59e0b', text: '#fff', title: 'Class B' };
        if (skill >= 2.5) return { bg: '#10b981', text: '#fff', title: 'Class C' };
        return { bg: '#6b7280', text: '#fff', title: 'Class D' };
    }

    function toggleDuelSelection(pid) {
        if (!STATE_COMPARE_A) {
            STATE_COMPARE_A = String(pid);
        } else if (!STATE_COMPARE_B && STATE_COMPARE_A !== String(pid)) {
            STATE_COMPARE_B = String(pid);
        } else {
            if (STATE_COMPARE_A === String(pid)) STATE_COMPARE_A = '';
            else if (STATE_COMPARE_B === String(pid)) STATE_COMPARE_B = '';
        }
        runTableRenderer();
    }

    // --- LEADERBOARD GRID RENDER ENGINE ---
    function runTableRenderer() {
        var dataset = parseRuntimePipeline();

        var separationLineStyle = STATE_DARK_MODE ? 'border-bottom:1px solid #1f2937;' : 'border-bottom:1px solid #f1f5f9;';
        var dynamicAnchorColor  = STATE_DARK_MODE ? '#60a5fa' : '#1d6fa4';
        var descriptionMutedText = STATE_DARK_MODE ? '#9ca3af' : '#475569';
        var highlightBoldText   = STATE_DARK_MODE ? '#f3f4f6' : '#0f172a';

        if (dataset.length > 0) {
            RUNTIME_MAX_SKILL = Math.max.apply(Math, dataset.map(function(o) { return o.racing_skill || 0; }));
        }

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
            rowString += '<td style="padding:8px 14px; color:#9ca3af;">' + (slot + 1) + '</td>';
            rowString += '<td style="padding:8px 4px;"><a href="https://www.torn.com/profiles.php?XID=' + player.id + '" target="_blank" style="color:' + dynamicAnchorColor + '; text-decoration:none; font-weight:600;" onclick="event.stopPropagation();">' + (player.name || 'Unknown') + '</a></td>';
            rowString += '<td style="padding:8px 4px; color:' + descriptionMutedText + '; white-space: nowrap; overflow: hidden; text-overflow: ellipsis; max-width: 120px;" title="' + (player.factionName || '') + '">' + (player.factionName || '—') + '</td>';
            rowString += '<td style="padding:8px 4px;"><span style="background:' + badgeObject.bg + '; color:' + badgeObject.text + '; font-size:10px; padding:1px 6px; border-radius:20px;">' + badgeObject.title + '</span></td>';
            rowString += '<td style="padding:8px 4px;"><div style="display:flex; align-items:center; gap:4px;"><div style="flex:1; height:5px; border-radius:3px; background:#374151; min-width:40px;"><div style="width:' + progressWidth + '%; height:100%; border-radius:3px; background:#6366f1;"></div></div><span style="font-size:11px; color:' + descriptionMutedText + '; min-width:28px; text-align:right;">' + absoluteSkill.toFixed(2) + '</span></div></td>';
            rowString += '<td style="padding:8px 4px; color:' + descriptionMutedText + ';">' + (player.racing_wins !== undefined ? player.racing_wins : '—') + '</td>';
            rowString += '<td style="padding:8px 4px; color:' + descriptionMutedText + ';">' + (player.races_entered !== undefined ? player.races_entered : '—') + '</td>';
            rowString += '<td style="padding:8px 4px; font-weight:600; color:' + highlightBoldText + ';">' + calculatedRatio + '</td>';
            rowString += '<td style="padding:8px 4px; color:' + descriptionMutedText + ';">' + (player.racing_points !== undefined ? player.racing_points : '—') + '</td>';
            rowString += '<td style="padding:8px 14px 8px 4px; font-weight:600; color:#e11d48;">' + handicapDisplay + '</td>';
            rowString += '</tr>';
            return rowString;
        }).join('');

        var targetBodyDOM = document.getElementById('nbf-layout-body');
        if (!targetBodyDOM) return;
        
        targetBodyDOM.innerHTML = '<table id="nbf-table-view" style="width:100%; border-collapse:collapse; text-align:left;"><thead><tr style="color:#9ca3af; font-size:12px; border-bottom:2px solid #374151;"><th style="padding:8px 14px;">#</th><th style="padding:8px 4px;">Driver</th><th style="padding:8px 4px;">Faction</th><th style="padding:8px 4px;">Tier</th><th style="padding:8px 4px;">Skill Matrix</th><th style="padding:8px 4px;">Wins</th><th style="padding:8px 4px;">Runs</th><th style="padding:8px 4px;">Efficiency</th><th style="padding:8px 4px;">Pts</th><th style="padding:8px 14px 8px 4px;">Handicap</th></tr></thead><tbody>' + markupRows + '</tbody></table>';

        var rows = targetBodyDOM.querySelectorAll('tbody tr');
        for (var r = 0; r < rows.length; r++) {
            rows[r].addEventListener('click', function() { 
                toggleDuelSelection(this.getAttribute('data-pid')); 
            });
        }
    }

    // --- BASE INTERFACE LAYOUT INITIALIZER ---
    function initializeDashboardDom() {
        if (document.getElementById('nbf-dashboard-root')) return;

        var mainContainer = document.querySelector('.content-wrapper');
        if (!mainContainer) return;

        var dashboardRoot = document.createElement('div');
        dashboardRoot.id = 'nbf-dashboard-root';
        dashboardRoot.style = 'background:#111827; color:#f3f4f6; padding:16px; border-radius:8px; margin-bottom:16px; font-family:sans-serif;';
        
        var controlHeader = '<div style="display:flex; justify-content:space-between; align-items:center; margin-bottom:12px;">';
        controlHeader += '<h2 style="margin:0; font-size:18px;">Faction Racing Dashboard</h2>';
        controlHeader += '<select id="nbf-faction-filter" style="background:#1f2937; color:#fff; border:1px solid #374151; padding:4px 8px; border-radius:4px; cursor:pointer;"><option value="all">All Factions</option><option value="1">Apex Racing</option><option value="2">Veloce Crew</option></select>';
        controlHeader += '</div>';
        
        var bodyContainer = '<div id="nbf-layout-body"></div>';
        
        dashboardRoot.innerHTML = controlHeader + bodyContainer;
        mainContainer.insertBefore(dashboardRoot, mainContainer.firstChild);

        document.getElementById('nbf-faction-filter').addEventListener('change', function(e) {
            FILTERED_FACTION_ID = e.target.value;
            runTableRenderer();
        });

        runTableRenderer();
    }

    setTimeout(function() {
        initializeDashboardDom();
    }, 1500);

})();
