# Nuclear Family — Master Blueprint
Version: 1.0

## Mission
Build the best racing league companion for Torn while remaining lightweight,
easy to maintain, transparent, and compliant with Torn's scripting rules.

## Core Principles
- KISS over cleverness.
- Reliability before features.
- One release, one purpose.
- Refactor without changing behavior.
- Stable releases are sacred.
- Every feature belongs to one module ("BOOK").

## User Roles
### Racer
- View standings
- Compare drivers
- Track progress

### Steward
- Validate race results
- Submit completed race logs
- Monitor ingestion status

### League Administrator
- Configure competitions
- Manage stewards
- Manage scoring
- Review standings

## System Modules

### BOOK 01 – Foundation
Configuration, constants, runtime state, utilities.

### BOOK 02 – Storage
Cache, localStorage, import/export, migrations.

### BOOK 03 – API
Torn API, Cloudflare, authentication, retry logic.

### BOOK 04 – Theme
Dark/light mode, colors, CSS.

### BOOK 05 – Dashboard
Modal, navigation, tabs, toolbar.

### BOOK 06 – Leaderboard
Filtering, sorting, searching, comparison, summaries.

### BOOK 07 – League
Tracks, handicaps, team generation, rules.

### BOOK 08 – Stewards
Registry, tokens, permissions.

### BOOK 09 – Scraper
Race detection, DOM parsing, payload generation.

### BOOK 10 – Standings
Championship tables and live backend integration.

### BOOK 11 – Help
FAQ, onboarding, documentation.

### BOOK 12 – Developer
Debug tools, diagnostics, migration helpers.

## Data Flow

Torn API
↓
Storage Cache
↓
Leaderboard
↓
League Engine
↓
Race Scraper
↓
Cloudflare Backend
↓
Standings

## Dependency Rules

Allowed:
Foundation → Storage → API → UI Modules

Avoid:
Leaderboard ↔ Stewards
Leaderboard ↔ Cloudflare
Standings ↔ Scraper
Cross-module direct calls whenever possible.

## Release Roadmap

v6.0  Library Edition ✅
v6.1  Documentation Foundation ✅
v6.2  Steward Ingestion Hardening
v6.3  Cloudflare Blueprint
v6.4  Live Standings
v6.5  Analytics Foundation
v7.0  Mature Modular Architecture

## Long-Term Vision

Nuclear Family is no longer "just a userscript".
It is a complete racing platform built around Torn competition,
designed to be maintainable for years through disciplined architecture,
clear documentation, stable releases, and incremental growth.
