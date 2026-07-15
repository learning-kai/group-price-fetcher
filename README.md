# Group Price Fetcher

[![License: MIT](https://img.shields.io/badge/license-MIT-2ea44f)](LICENSE)
[![Version](https://img.shields.io/badge/version-0.1.0-0969da)](https://github.com/learning-kai/group-price-fetcher)
[![Node.js](https://img.shields.io/badge/Node.js-%3E%3D22.5-339933?logo=nodedotjs&logoColor=white)](https://nodejs.org/)
[![Platform](https://img.shields.io/badge/platform-Windows%20%7C%20Linux-345f9d)](#quick-start)
[![GitHub release](https://img.shields.io/github/v/release/learning-kai/group-price-fetcher?include_prereleases&label=release)](https://github.com/learning-kai/group-price-fetcher/releases)

[English](README.md) | [简体中文](README.zh-CN.md)

Turn scattered gateway dashboards into one local rate console: collect authenticated group multipliers, compare GPT/Grok pricing separately, keep credentials encrypted, and expose a stable read-only API for other tools.

```bash
npm install
npm start
# open http://127.0.0.1:5177
```

![Hero overview](docs/assets/00-hero.png)

## Why

API gateway pricing is usually hidden behind logins, mixed JSON shapes, and account-specific keys. Comparing “what my account actually pays” across sub2api and NewAPI sites should not require reopening every admin panel or pasting secrets into notes.

Group Price Fetcher is the local control plane for that work: one dashboard, scheduled collection, explicit change history, encrypted credential storage, notifications, backups, and a versioned external API.

## Feature Tour

### 1. Latest rates — search, filter, rank

![Latest rates](docs/assets/01-rates.png)

- Table columns for **base rate**, **effective rate**, and **current account rate**
- Filters: site/group search, category, tag, platform, **model family (GPT/Grok/other)**, group status, auth status, hidden/visible
- Sorting by rate, site, group, platform, or update time
- Metric strip for group count, covered sites, filtered minimum, GPT minimum, Grok minimum, login-required count
- Local hide/show for noisy groups without rewriting history
- Per-site conversion factors for display and comparison

### 2. Change feed — only real diffs

![Recent changes](docs/assets/02-changes.png)

- Explicit events: ratio change, group added/removed, description change, and related metadata shifts
- Severity and old → new values kept for audit
- Site-scoped filtering for focused investigation
- Designed to avoid “everything refreshed” noise

### 3. Site operations — auth, balance, schedule

![Site management](docs/assets/03-sites.png)

- Providers: **sub2api** and **NewAPI** style gateways
- Auth modes: password, portable token, public collection, token-enhanced, Windows Edge profile fallback
- Balance status, low-balance thresholds, and last-collection timestamps
- Per-site schedule overrides on top of the global interval
- Bulk add for multiple targets

### 4. Notification center

![Notification center](docs/assets/04-notifications.png)

- Destinations: Telegram, Webhook, Email, WeCom, DingTalk, Feishu
- Subscribe by **site** and **event type**
- Events: rate change, low balance, auth failure, collection failure
- Policy controls: minimum ratio-change percent, balance cooldown, failure cooldown, retry count
- Test send + delivery log
- Async dispatch after collection so alerts never block scraping
- Secrets stay encrypted; the UI does not echo plaintext keys

### 5. GPT / Grok independent billing domains

![GPT and Grok settings](docs/assets/05-settings-family.png)

- GPT and Grok are **separate pricing domains**, not one blended number
- GPT current-account rate uses the exact active key name `1111`
- Grok current-account rate uses the exact active key name `grok`
- Each domain has its own enable switch, target group, service multiplier, min/max bounds, and change threshold
- Channel names like `波吉grok` map back to site `波吉` for priority sync consumers

### 6. External API, export, and disaster recovery

Read-only API for local/LAN tools:

```bash
curl -sS http://127.0.0.1:5177/api/external/v1/sites
curl -sS http://127.0.0.1:5177/api/external/v1/rates
curl -sS http://127.0.0.1:5177/api/external/v1/changes
```

| Path | Contains | Use when |
|---|---|---|
| JSON / CSV export | Public site data, rates, changes | Share rates without secrets |
| `.gpfbackup` | SQLite checkpoint + encrypted credentials | Full disaster recovery |
| `.gpftransfer` | Portable site config + credentials | Move sites between instances |

Backups use scrypt + AES-256-GCM. Edge profiles/cookies are not included. Restore refuses to run while port `5177` is still occupied, and rolls database + vault back together on failure.

## Screenshots

| View | Preview |
|---|---|
| Overview | ![Hero](docs/assets/00-hero.png) |
| Rates | ![Rates](docs/assets/01-rates.png) |
| Changes | ![Changes](docs/assets/02-changes.png) |
| Sites | ![Sites](docs/assets/03-sites.png) |
| Notifications | ![Notifications](docs/assets/04-notifications.png) |
| GPT/Grok policy | ![Settings](docs/assets/05-settings-family.png) |

Images are generated from a live local instance layout and sample metrics so the README matches the real product, not a mock marketing kit.

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

```powershell
npm run startup:install
# later:
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

Keep the same vault key across restarts. Losing it makes the existing credential vault unreadable.

Linux supports public, NewAPI token, sub2api password, and portable sub2api token auth. Edge profile extraction remains Windows-only. For public hosting, keep Node on `127.0.0.1` and require HTTPS + authentication at the reverse proxy.

### Portable sub2api token workflow

1. On Windows, log into the site with its dedicated Edge profile
2. Edit the site → **Extract Edge session**
3. Save Access Token / optional Refresh Token into the encrypted vault as `sub2api-token`
4. On Linux, paste the same fields or import an encrypted `.gpftransfer`

The collector reuses a valid Access Token, refreshes when possible, and marks the site `login_required` when refresh fails. Ordinary status/export APIs never return raw tokens.

## External API

Loopback requests do not need an API key:

```bash
curl -sS http://127.0.0.1:5177/api/external/v1/sites
curl -sS http://127.0.0.1:5177/api/external/v1/rates
curl -sS http://127.0.0.1:5177/api/external/v1/changes
```

```text
GET /api/external/v1/sites
GET /api/external/v1/rates
GET /api/external/v1/changes
GET /api/external/v1/sites/:id/rates
GET /api/external/v1/sites/:id/changes
GET /api/external/v1/sites/:id/groups/:groupId/history
```

For LAN access, generate an API key in Settings, start with `HOST=0.0.0.0`, and send `Authorization: Bearer <api-key>`. Management and credential endpoints stay loopback-only.

## Engineering Quality

```bash
npm test
npm run test:acceptance
```

The suite uses Node’s built-in test runner and temporary SQLite databases. Coverage includes multi-site concurrency, partial failures, auth refresh, provider normalization, change-only history, API authorization, credential redaction, cross-platform transfer, Linux vault encryption, restart recovery, and notification center paths. Recent full runs report **162** passing tests.

## Project Docs

| Path | Purpose |
|---|---|
| `docs/assets/` | Feature screenshots used in this README |
| `docs/site-transfer-format.md` | Portable transfer package format |
| `docs/superpowers/` | Design notes and implementation plans |
| `src/providers/` | sub2api / NewAPI collectors |
| `src/notificationService.js` | Notification destinations and dispatch |
| `public/` | Dashboard UI |

## Privacy & Security Boundaries

- Credentials are encrypted at rest; never commit vault keys, `.env`, or live databases
- SQLite stores operational metadata and rate history, not plaintext passwords
- External API is read-only for sites/rates/changes
- Management and credential endpoints remain loopback-only by design
- Public deployment requires reverse-proxy HTTPS + authentication
- Password-protected backups cannot be recovered if the password is lost

## Release & Updates

- Current package version: **0.1.0**
- Source: [learning-kai/group-price-fetcher](https://github.com/learning-kai/group-price-fetcher)

```bash
git pull
npm install
npm test
npm start
```

Keep the same `GROUP_PRICE_FETCHER_HOME` and vault key across upgrades.

## Roadmap

- Richer notification templates and delivery analytics
- Clearer multi-family pricing views beyond GPT/Grok
- Hardened reverse-proxy deployment examples
- Optional signed release packaging

## Contributing

1. Fork and create a feature branch
2. Keep credentials and local `data/` out of commits
3. Run `npm test` before opening a PR
4. Prefer small, reviewable changes with real commands and fixtures

## License

[MIT](LICENSE) © 2026 learning-kai
