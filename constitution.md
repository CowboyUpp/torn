# Nuclear Family Constitution

Version: 1.0  
Project: Nuclear Family — Torn Racing Dashboard  
Purpose: Keep the project stable, readable, and maintainable as it grows.

---

## 1. Stable Core Rule

Working features are protected.

Once a feature is tested and stable, it should not be changed unless:

- a bug requires it,
- a new feature depends on it,
- or a planned refactor explicitly includes it.

No casual edits to stable code.

---

## 2. One Release, One Purpose

Every version must have one clear goal.

Good:

- v6.0 — Library Edition
- v6.1 — Documentation
- v6.2 — Steward Ingestion Hardening

Bad:

- Refactor + new UI + backend rewrite + random bug fixes in one release

Mixed releases make bugs harder to trace.

---

## 3. Refactor Means No Behavior Changes

A refactor release may reorganize or clean code, but it must not intentionally change:

- UI layout
- visual style
- feature behavior
- stored data format
- API behavior

Any behavior change belongs in a separate feature or bugfix release.

---

## 4. Feature Work Must Stay in Its Own Room

Every new feature must belong to a clear section, or “BOOK.”

If it does not fit an existing BOOK, create a new one.

Do not stuff unrelated logic into Leaderboard, Stewards, or Dashboard just because it is convenient.

---

## 5. Keep KISS

Prefer simple, readable JavaScript over clever code.

The project should remain understandable to a non-professional developer.

Readable beats fancy.

---

## 6. No Hidden Surprises

Do not silently change:

- author name
- license
- script name
- storage keys
- API endpoint behavior
- Torn page matches
- permission grants

Any such change must be called out clearly in the changelog.

---

## 7. Smoke Test Before Release

Every release must pass the smoke-test checklist before being copied into `current/`.

If it has not been tested, it is not stable.

---

## 8. GitHub Structure Is Sacred

Recommended structure:

```text
current/
    Nuclear-Family.user.js

releases/
    nuclear-family-v5.9.user.js
    nuclear-family-v6.0-library-edition.user.js

docs/
    constitution.md
    smoke-test.md
    roadmap.md
    release-process.md

archive/
    old-test-builds/
```

`current/` contains only the latest stable installable version.

---

## 9. Document the Why

Comments should explain why something exists, not just what it does.

Bad:

```js
// increment counter
```

Good:

```js
// Delay requests to avoid Torn API rate limits.
```

---

## 10. Protect the User

The userscript should avoid unnecessary permissions.

Prefer:

```js
// @grant none
```

unless a feature truly needs userscript privileges.

Never transmit API keys or steward tokens anywhere except the intended endpoint.

---

## 11. Rollback Must Always Be Possible

Every stable version must be preserved in `releases/`.

If a new release breaks, the previous release should be easy to reinstall.

---

## 12. The Project Principle

Nuclear Family is no longer “just a script.”

It is a Torn racing league tool.

Treat it like a small software product:

- stable releases,
- changelog,
- testing,
- documentation,
- rollback versions,
- clean structure.
