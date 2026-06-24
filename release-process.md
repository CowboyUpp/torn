# Nuclear Family Release Process

Project: Nuclear Family  
Process Version: 1.0

---

## Repository Layout

Recommended GitHub structure:

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

---

## Release Types

Use one of these labels for every task.

```text
[BUG]
[FEATURE]
[REFACTOR]
[UI]
[DOCS]
[ARCHITECTURE]
[RELEASE]
```

---

## Version Rules

Use simple project versions:

```text
v6.0
v6.1
v6.2
```

Each version should have one main purpose.

---

## Release Workflow

### 1. Plan

Define:

- goal,
- scope,
- files affected,
- risk,
- testing checklist.

---

### 2. Implement

Follow the agreed scope.

No surprise features.

---

### 3. Test

Run `docs/smoke-test.md`.

---

### 4. Preserve Rollback

Copy the previous stable version into `releases/` before replacing `current/`.

---

### 5. Update GitHub

Update:

```text
current/Nuclear-Family.user.js
releases/nuclear-family-vX.X-name.user.js
docs/changelog.md
```

---

### 6. Commit

Suggested commit message format:

```text
v6.1 Documentation Foundation
```

or

```text
v6.2 Steward Ingestion Hardening
```

---

## Changelog Format

Use this style:

```markdown
## v6.1 — Documentation Foundation

Type: DOCS
Risk: Low

Changes:
- Added project constitution.
- Added smoke-test checklist.
- Added roadmap.
- Added release process.

Testing:
- Documentation reviewed.
- No script behavior changed.
```

---

## Release Notes Format

```markdown
# v6.1 — Documentation Foundation

This release adds project documentation and formal development rules.

No userscript behavior changed.
```

---

## Rollback Rule

If a release breaks:

1. Reinstall previous file from `releases/`.
2. Mark the broken version as unstable.
3. Fix in a new version.
4. Do not overwrite history.
