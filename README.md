# Group Price Fetcher

[![License: MIT](https://img.shields.io/badge/license-MIT-2ea44f)](LICENSE)
[![Version](https://img.shields.io/badge/version-0.1.0-0969da)](https://github.com/learning-kai/group-price-fetcher)
[![Node.js](https://img.shields.io/badge/Node.js-%3E%3D22.5-339933?logo=nodedotjs&logoColor=white)](https://nodejs.org/)
[![Platform](https://img.shields.io/badge/platform-Windows%20%7C%20Linux-345f9d)](#quick-start)
[![GitHub release](https://img.shields.io/github/v/release/learning-kai/group-price-fetcher?include_prereleases&label=release)](https://github.com/learning-kai/group-price-fetcher/releases)

[English](README.md) | [简体中文](README.zh-CN.md)

Turn scattered gateway dashboards into one local rate console: collect authenticated group multipliers, compare GPT/Grok pricing separately, keep encrypted credentials off disk-as-plaintext, and expose a stable read-only API for other tools.

```bash
npm install
npm start
# open http://127.0.0.1:5177
```

![Group Price Fetcher dashboard](docs/assets/dashboard.png)

## Why

API gateway pricing usually lives behind logins, mixed response shapes, and per-site quirks. Comparing “what my account actually pays” across sub2api and NewAPI sites should not require reopening every admin panel, pasting tokens into notebooks, or committing secrets into a repo.

Group Price Fetcher is the local control plane for that work: one dashboard, scheduled collection, explicit change history, encrypted credential storage, backups, and a versioned external API.

## Core Features

- Collect group multipliers from **sub2api** and **NewAPI** style gateways
- Track **authenticated current rates** for GPT and Grok as separate pricing domains
- Support password, portable token, public, token-enhanced, and Windows Edge-profile auth paths
- Encrypt credentials with **Windows DPAPI** or a **Linux AES-256-GCM vault**; SQLite keeps metadata only
- Sort and filter by site, category, tag, platform, group status, and auth status
- Apply per-site conversion factors and hide groups locally without rewriting history
- Record concrete change events: add/remove, ratio, description, RPM, quota, billing, peak rules
- Run scheduled collection with bounded concurrency and per-site failure isolation
- Send optional notifications for rate changes, low balance, auth failures, and collection failures
- Expose stable read-only endpoints under `/api/external/v1`
- Export JSON/CSV, password-encrypted `.gpfbackup` disaster archives, and portable `.gpftransfer` site packages

## Screenshots & Demo

| Dashboard | Default URL |
|---|---|
| Live local console | `http://127.0.0.1:5177` |

The UI is a single local service. For public exposure, keep Node on loopback and terminate HTTPS + auth at a reverse proxy.

## Quick Start

### Requirements

- Windows 10/11 or a current Linux distribution
- Node.js **22.5+**
- Microsoft Edge only if you use Windows Edge-profile extraction

### Windows

```powershell
npm install
npm start
```

Open [http://127.0.0.1:5177](http://127.0.0.1:5177), add a site, choose Provider + auth mode, then run the first manual refresh.

Optional auto-start for the current Windows user:

```powershell
npm run startup:install
# remove later:
npm run startup:uninstall
```

### Linux

Put the data directory and vault key **outside** the repository:

```bash
export GROUP_PRICE_FETCHER_HOME=/var/lib/group-price-fetcher
export GROUP_PRICE_FETCHER_VAULT_KEY="$(openssl rand -hex 32)"
npm install
npm start
```

Keep the same vault key across restarts. Losing or rotating it makes the existing credential vault unreadable.

Linux supports public, NewAPI token, sub2api password, and portable sub2api token auth. Edge profile extraction remains Windows-only.

### Portable sub2api token workflow

1. On Windows, log into the site with its dedicated Edge profile
2. Edit the site → **Extract Edge session**
3. Save Access Token / optional Refresh Token into the encrypted vault as `sub2api-token`
4. On Linux, paste the same fields or import an encrypted `.gpftransfer` created on Windows

The collector reuses a valid Access Token, refreshes when possible, and marks the site `login_required` when refresh fails. Ordinary status/export APIs never return raw tokens.

## External API

Loopback requests do not need an API key:

```bash
curl -sS http://127.0.0.1:5177/api/external/v1/sites
curl -sS http://127.0.0.1:5177/api/external/v1/rates
curl -sS http://127.0.0.1:5177/api/external/v1/changes
```

Versioned resources:

```text
GET /api/external/v1/sites
GET /api/external/v1/rates
GET /api/external/v1/changes
GET /api/external/v1/sites/:id/rates
GET /api/external/v1/sites/:id/changes
GET /api/external/v1/sites/:id/groups/:groupId/history
```

For LAN access, generate an API key in Settings, start with `HOST=0.0.0.0`, and send:

```text
Authorization: Bearer <api-key>
```

Management and credential endpoints stay loopback-only.

## Export, Backup & Transfer

| Path | Contains | Use when |
|---|---|---|
| JSON / CSV export | Public site data, current rates, changes | Sharing rates without secrets |
| `.gpfbackup` | Checkpointed SQLite + encrypted credentials | Full disaster recovery |
| `.gpftransfer` | Portable site config + account credentials | Moving sites between instances |

`.gpfbackup` uses scrypt (`N=32768`, `r=8`, `p=1`) and AES-256-GCM. Edge profiles and browser cookies are not included. Backup passwords must be at least 10 characters and are never stored.

Restore offline:

```powershell
npm run backup:restore -- "C:\path\to\backup.gpfbackup"
```

Stop the process on port 5177 first. The CLI refuses to restore while the service is running, creates pre-restore backups, and rolls database + vault back together if replacement fails.

## Engineering Quality

```bash
npm test
npm run test:acceptance
```

The suite uses Node’s built-in test runner and temporary SQLite databases. Coverage includes multi-site concurrency, partial failures, auth refresh, provider normalization, change-only history, API authorization, credential redaction, cross-platform transfer, Linux vault encryption, restart recovery, and notification center UI/API paths. Recent full runs report **162** passing tests.

## Project Docs

| Path | Purpose |
|---|---|
| `docs/assets/` | Dashboard screenshot |
| `docs/site-transfer-format.md` | Portable transfer package format |
| `docs/superpowers/` | Design notes and implementation plans |
| `src/providers/` | sub2api / NewAPI collectors |
| `src/notificationService.js` | Notification destinations and dispatch |
| `public/` | Dashboard UI |

## Privacy & Security Boundaries

- Credentials are encrypted at rest; the repo must never contain vault keys, `.env`, or live databases
- SQLite stores operational metadata and rate history, not plaintext passwords
- External API is read-only for rates/sites/changes
- Management and credential endpoints remain loopback-only by design
- Public deployment requires reverse-proxy HTTPS + authentication; do not expose Node directly on `0.0.0.0` without a key and network boundary
- Backups that include credentials are password-protected; lost passwords cannot be recovered

## Release & Updates

- Current package version: **0.1.0**
- Source of truth: [learning-kai/group-price-fetcher](https://github.com/learning-kai/group-price-fetcher)
- Upgrade path: pull latest `main`, run `npm install`, restart the service, keep the same `GROUP_PRICE_FETCHER_HOME` and vault key

```bash
git pull
npm install
npm test
npm start
```

## Roadmap

- Richer notification channel templates and delivery logs
- Clearer multi-model family pricing views beyond GPT/Grok
- Hardened reverse-proxy deployment examples
- Optional signed update / release packaging

## Contributing

1. Fork and create a feature branch
2. Keep credentials and local `data/` out of commits
3. Run `npm test` before opening a PR
4. Prefer small, reviewable changes with real commands and fixtures

Bug reports are most useful when they include Provider type, auth mode, Node version, and a redacted reproduction path.

## License

[MIT](LICENSE) © 2026 learning-kai
