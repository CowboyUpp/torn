# Nuclear Family Smoke Test Checklist

Use this checklist before moving any release into `current/`.

Project: Nuclear Family  
Checklist Version: 1.0

---

## 1. Install / Startup

- [ ] Script installs in Tampermonkey or Violentmonkey.
- [ ] Script is enabled.
- [ ] Torn racing page loads normally.
- [ ] No red console errors on page load.
- [ ] Floating Nuclear Family button appears.

---

## 2. Dashboard

- [ ] Dashboard opens.
- [ ] Dashboard closes with Close button.
- [ ] Dashboard closes by clicking outside the modal.
- [ ] Layout is not visibly broken.
- [ ] No red console errors when opening dashboard.

---

## 3. Theme

- [ ] Light mode works.
- [ ] Dark mode works.
- [ ] Theme toggle updates the UI.
- [ ] Theme choice persists after reload.

---

## 4. Leaderboard

- [ ] Leaderboard tab opens.
- [ ] Cached data loads if available.
- [ ] Sync button starts data refresh.
- [ ] Progress indicator appears during sync.
- [ ] Driver rows render correctly.
- [ ] Faction names display correctly.
- [ ] Racing skill displays correctly.
- [ ] Wins, runs, efficiency, points, and handicap display correctly.

---

## 5. Leaderboard Controls

- [ ] Faction filter works.
- [ ] Search field works.
- [ ] Sort dropdown works.
- [ ] Asc/Desc dropdown works.
- [ ] Driver count updates after filtering.

---

## 6. Driver Comparison

- [ ] Clicking one driver selects them.
- [ ] Clicking a second driver opens comparison bar.
- [ ] Comparison bar shows both drivers.
- [ ] Skill difference is calculated.
- [ ] Clear Context works.

---

## 7. Summary Cards

- [ ] Total Pool displays.
- [ ] Combined Wins displays.
- [ ] Alliance Runs displays.
- [ ] Average Skill displays.
- [ ] Win Ratio displays.

---

## 8. League Setup

- [ ] League Setup tab opens.
- [ ] Competition type controls display.
- [ ] Scope controls display.
- [ ] Team count control displays.
- [ ] Track selector opens.
- [ ] Track selector saves selected tracks.
- [ ] Lap count saves.
- [ ] Handicap option saves.
- [ ] Team generation works if available.

---

## 9. Stewards

- [ ] Stewards tab opens.
- [ ] Steward token input displays.
- [ ] Token reveal button works.
- [ ] Token save works.
- [ ] Token clear works.
- [ ] Steward registry displays.
- [ ] Add steward works.
- [ ] Remove steward works.
- [ ] Ingestion status displays.

---

## 10. Standings

- [ ] Standings tab opens.
- [ ] Placeholder standings display when Cloudflare endpoint is not configured.
- [ ] Refresh button works.
- [ ] No red console errors on refresh.

---

## 11. Help

- [ ] Help tab opens.
- [ ] FAQ entries display.
- [ ] FAQ content is readable.
- [ ] Tooltips still work.

---

## 12. Export

- [ ] CSV export button works.
- [ ] Downloaded CSV opens.
- [ ] CSV contains expected driver data.

---

## 13. Cache

- [ ] Data remains after page reload.
- [ ] Cache timestamp displays.
- [ ] Manual sync still works after cached load.

---

## 14. Race Scraper

Only test this if you have a steward token and a completed race log.

- [ ] Scraper does not fire on normal racing pages.
- [ ] Scraper only checks race log pages.
- [ ] Scraper detects raceID.
- [ ] Scraper finds leaderboard DOM.
- [ ] Placeholder Cloudflare endpoint blocks transmission safely.
- [ ] Toast message appears.
- [ ] No duplicate unexpected submissions.

---

## 15. Console Check

Open browser console and check for:

- [ ] No `SyntaxError`
- [ ] No `ReferenceError`
- [ ] No `TypeError`
- [ ] No repeated error spam
- [ ] No unexpected network errors except placeholder Cloudflare endpoint warnings

---

## Release Decision

A release may move to `current/` only if:

- [ ] Critical path works.
- [ ] No red console errors during normal use.
- [ ] Previous stable version is preserved in `releases/`.
- [ ] Changelog is updated.
