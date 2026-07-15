# Group Price Fetcher

![License](https://img.shields.io/badge/license-MIT-2ea44f)
![Version](https://img.shields.io/badge/version-0.1.0-0969da)
![Node.js](https://img.shields.io/badge/Node.js-%3E%3D22.5-339933?logo=nodedotjs&logoColor=white)
![Platform](https://img.shields.io/badge/platform-Windows%20%7C%20Linux-345f9d)

[English](README.md) | [简体中文](README.zh-CN.md)

A self-hosted Windows and Linux dashboard that collects, compares, and exposes group pricing from sub2api, NewAPI, and compatible API gateways.

## Why

Gateway pricing is often scattered across authenticated dashboards with incompatible response formats. Group Price Fetcher keeps collection, sorting, history, authentication state, and external integrations in one local tool without putting credentials in the project directory.

## Core Features

- Collects group multipliers from sub2api-style and NewAPI endpoints.
- Removes the visible Uling19 Provider, leaving sub2api and NewAPI. SQLite schema v4 automatically migrates legacy `uling-gateway` sites to `sub2api` without changing their URLs, site records, or rate history.
- Supports sub2api email/password and portable Token authentication, NewAPI public and token-enhanced collection, and a persistent Edge profile fallback.
- Encrypts saved credentials with Windows DPAPI or a server-side Linux AES-256-GCM vault; SQLite stores metadata only.
- Sorts and filters rates by site, category, tag, platform, group status, and authentication status.
- Supports per-site rate conversion factors and locally hidden groups without rewriting collected history.
- Records explicit add, remove, ratio, description, RPM, quota, billing, and peak-rule changes.
- Runs scheduled collection with bounded concurrency and per-site failure isolation.
- Exposes stable read-only endpoints under `/api/external/v1` for other local or LAN software.
- Exports ordinary JSON/CSV data and password-encrypted, portable `.gpfbackup` disaster-recovery archives.
- Exchanges site configuration and account credentials between independent instances with encrypted `.gpftransfer` files.

## Screenshots & Demo

![Group Price Fetcher dashboard](docs/assets/dashboard.png)

The dashboard is served at `http://127.0.0.1:5177` by default and can be placed behind an authenticated HTTPS reverse proxy.

## Quick Start

### Requirements

- Windows 10/11 or a current Linux distribution
- Node.js 22.5 or newer
- Microsoft Edge for browser-profile authentication on Windows

```powershell
npm install
npm start
```

Open [http://127.0.0.1:5177](http://127.0.0.1:5177), add a site, select its Provider and authentication mode, then run the first manual refresh.

To install an automatic task for the current Windows user:

```powershell
npm run startup:install
```

Remove it with `npm run startup:uninstall`.

For Linux, persist a random 32-byte hexadecimal vault key in a root-only environment file and set a data directory outside the repository:

```bash
export GROUP_PRICE_FETCHER_HOME=/var/lib/group-price-fetcher
export GROUP_PRICE_FETCHER_VAULT_KEY="$(openssl rand -hex 32)"
npm install
npm start
```

Keep the same vault key across restarts; losing or rotating it makes the existing credential vault unreadable. Linux supports public, NewAPI token, sub2api password, and portable sub2api Token authentication. Edge Profile authentication and extraction remain Windows-only. For public hosting, keep Node bound to `127.0.0.1` and require HTTPS plus authentication at the reverse proxy.

### Portable sub2api Token workflow

On Windows, log in to an existing sub2api site with its dedicated Edge Profile, edit that site, and select **Extract Edge session**. The returned Access Token and optional Refresh Token are filled into sensitive fields once; save the site to switch it to `sub2api-token`. On Linux, edit the site and paste the same fields directly, or import an encrypted `.gpftransfer` created on Windows.

The collector reuses a valid Access Token. If it expires and a Refresh Token is present, the collector rotates the tokens and writes the replacement back to the encrypted credential vault. If refresh is unavailable or rejected, the site becomes `login_required` and must be extracted again on Windows or updated manually. Raw tokens are not returned by ordinary status, site, export, or collection APIs.

## External API

Loopback requests do not require an API key:

```powershell
Invoke-RestMethod http://127.0.0.1:5177/api/external/v1/sites
Invoke-RestMethod http://127.0.0.1:5177/api/external/v1/rates
Invoke-RestMethod http://127.0.0.1:5177/api/external/v1/changes
```

Available versioned resources:

```text
GET /api/external/v1/sites
GET /api/external/v1/rates
GET /api/external/v1/changes
GET /api/external/v1/sites/:id/rates
GET /api/external/v1/sites/:id/changes
GET /api/external/v1/sites/:id/groups/:groupId/history
```

For LAN access, generate an API key in Settings, start with `HOST=0.0.0.0`, and send `Authorization: Bearer <API_KEY>`. Management and credential endpoints remain loopback-only.

## Export, Backup & Restore

Settings provides three different export paths:

- Ordinary JSON/CSV exports contain only public site data, current rates, and change data. They contain no login credentials or API key hash and are not suitable for complete disaster recovery. JSON contains the public site, current-rate, and change collections; CSV contains current-rate rows.
- A `.gpfbackup` file is a complete portable backup. It contains a checkpointed SQLite database and saved credentials, encrypted with scrypt (`N=32768`, `r=8`, `p=1`) and AES-256-GCM. The Edge Profile and browser cookies are not included.
- A `.gpftransfer` file contains only portable site configuration and account credentials, including portable sub2api Access/Refresh Tokens. Import matches normalized URLs, overwrites the destination configuration without deleting rate history, clears credentials omitted by the package, and disables Edge-backed sites until they are authenticated locally.

The backup password must contain at least 10 characters. It is never stored and cannot be recovered if lost.

Restore offline from an interactive PowerShell terminal:

```powershell
npm run backup:restore -- "C:\path\to\backup.gpfbackup"
```

Stop the service listening on port 5177 before restoring; the CLI refuses to restore while that service is still running. Before replacement, restore creates pre-restore backups of the database and credential vault. If replacement fails, it rolls the database and vault back together.

## Engineering Quality

The project uses the built-in Node.js test runner and real temporary SQLite databases. The suite covers 60-site concurrency, partial failures, authentication refresh, Provider normalization, change-only history, API authorization, credential redaction, cross-platform transfer vectors, Linux vault encryption, and restart recovery.

```powershell
npm test
npm run test:acceptance
```

The suite intentionally excludes screenshot, responsive, layout, and visual-regression tests.

## Troubleshooting

- **Port 5177 is already in use:** stop the previous Node process or start with a different `PORT` value.
- **Edge login does not open:** verify Microsoft Edge is installed in its standard Windows location.
- **Linux reports a missing vault key:** provide the same 64-character hexadecimal `GROUP_PRICE_FETCHER_VAULT_KEY` on every restart.
- **A site shows `login_required`:** edit its credentials or run the explicit Login/Validate action; scheduled jobs never open interactive login windows.
- **LAN API returns 401:** generate a new API key in Settings and send it as a Bearer token.
- **Credentials fail after moving computers:** DPAPI is bound to the original Windows user; use `.gpftransfer` to move portable credentials or enter them again.

## Project Docs

- [Authentication, NewAPI, changes, and external API plan](docs/superpowers/plans/2026-07-13-auth-newapi-changes-external-api.md)
- [Encrypted export design](docs/superpowers/specs/2026-07-13-provider-cleanup-encrypted-export-design.md)
- [Encrypted export implementation plan](docs/superpowers/plans/2026-07-13-provider-cleanup-encrypted-export.md)
- [Cross-platform site transfer format](docs/site-transfer-format.md)

## Privacy & Security

Runtime data lives outside the repository:

```text
%LOCALAPPDATA%\GroupPriceFetcher\data\prices.db
%LOCALAPPDATA%\GroupPriceFetcher\data\credentials.vault
%LOCALAPPDATA%\GroupPriceFetcher\profiles
```

Linux uses `GROUP_PRICE_FETCHER_HOME` (for example `/var/lib/group-price-fetcher`) and requires `GROUP_PRICE_FETCHER_VAULT_KEY`.

- Passwords and NewAPI tokens are encrypted with Windows DPAPI CurrentUser scope or Linux AES-256-GCM using the deployment vault key.
- Access tokens, refresh tokens, cookies, and passwords are excluded from SQLite, logs, ordinary JSON/CSV exports, and ordinary API responses. Saved credentials are included only inside password-encrypted `.gpfbackup` and `.gpftransfer` files; the explicit Windows extraction response is a one-time, `no-store` exception initiated by the local user.
- API keys are stored as SHA-256 hashes.
- Ordinary JSON/CSV exports never include the API key hash and are not complete backups. `.gpfbackup` archives are portable; `.gpftransfer` moves only site configuration and credentials. Neither format includes Edge Profile state or cookies.
- A lost `.gpfbackup` password cannot be recovered.
- Respect each upstream site's terms, rate limits, and access rules.

## Release & Updates

The current source version is `0.1.0`. Release notes and migration details will be published through GitHub Releases when tagged releases begin.

## Roadmap

- Add optional change notifications.

## Contributing

Issues and focused pull requests are welcome. Keep credentials and runtime databases out of fixtures, add behavior-first tests, and run `npm test` before submitting.

## License

Released under the [MIT License](LICENSE).
