# Nuclear Family Roadmap

Project: Nuclear Family — Torn Racing Dashboard  
Roadmap Version: 1.0

---

## Completed

### v6.0 — Library Edition

Status: Complete

Purpose:

- Reorganize the userscript into documented BOOK sections.
- Preserve existing behavior.
- Preserve existing UI.
- Create a stable foundation for future development.

Notes:

- Smoke test passed.
- v5.9 preserved as rollback version.

---

## Recommended Next Versions

### v6.1 — Documentation Foundation

Purpose:

- Add project constitution.
- Add smoke-test checklist.
- Add release process.
- Add roadmap.

Risk: Very low  
Type: Documentation

---

### v6.2 — Steward Ingestion Hardening

Purpose:

- Prevent duplicate race submissions.
- Improve scraper validation.
- Improve error messages.
- Add local submitted-race tracking.
- Keep Cloudflare endpoint placeholder-safe.

Risk: Medium  
Type: Bugfix / Reliability

---

### v6.3 — Cloudflare Backend Blueprint

Purpose:

- Design Worker endpoint contract.
- Define race payload format.
- Define standings response format.
- Define steward-token validation concept.
- Define duplicate race handling.

Risk: Medium  
Type: Architecture

---

### v6.4 — Live Standings Integration

Purpose:

- Replace placeholder standings with backend data.
- Keep fallback placeholder mode.
- Add clear backend status messages.

Risk: Medium-high  
Type: Feature

---

### v6.5 — League Tools Polish

Purpose:

- Improve team generator stability.
- Add better validation for tracks, laps, and team count.
- Improve saved league configuration handling.

Risk: Medium  
Type: Feature / Reliability

---

### v6.6 — Analytics Foundation

Purpose:

- Add driver progress history concept.
- Add race history concept.
- Add track performance concept.

Risk: Medium-high  
Type: Feature

---

## Parking Lot Ideas

These are good ideas, but should not be started until the foundation is stable.

- Season history
- Driver profile modal
- Faction profile view
- Car recommendation helper
- Track analytics
- Race replay history
- Admin-only steward panel
- Import/export settings
- GitHub auto-update support
- Public documentation page

---

## Current Priority

Do not add major new UI features until the steward/backend path is stable.

Recommended next technical milestone:

```text
v6.2 — Steward Ingestion Hardening
```
