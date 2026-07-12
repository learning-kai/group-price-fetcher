# Group Price Fetcher

![License](https://img.shields.io/badge/license-MIT-2ea44f)
![Version](https://img.shields.io/badge/version-0.1.0-0969da)
![Node.js](https://img.shields.io/badge/Node.js-%3E%3D22.5-339933?logo=nodedotjs&logoColor=white)
![Platform](https://img.shields.io/badge/platform-Windows-0078D4?logo=windows&logoColor=white)

[English](README.md) | [简体中文](README.zh-CN.md)

A local Windows dashboard that collects, compares, and exposes group pricing from sub2api, NewAPI, and compatible API gateways.

## Why

Gateway pricing is often scattered across authenticated dashboards with incompatible response formats. Group Price Fetcher keeps collection, sorting, history, authentication state, and external integrations in one local tool without putting credentials in the project directory.

## Core Features

- Collects group multipliers from sub2api-style and NewAPI endpoints.
- Supports sub2api email/password login, NewAPI public and token-enhanced collection, and a persistent Edge profile fallback.
- Encrypts saved account credentials with Windows DPAPI; SQLite stores metadata only.
- Sorts and filters rates by site, category, tag, platform, group status, and authentication status.
- Records explicit add, remove, ratio, description, RPM, quota, billing, and peak-rule changes.
- Runs scheduled collection with bounded concurrency and per-site failure isolation.
- Exposes stable read-only endpoints under `/api/external/v1` for other local or LAN software.

## Screenshots & Demo

![Group Price Fetcher dashboard](docs/assets/dashboard.png)

The dashboard is served locally at `http://127.0.0.1:5177`.

## Quick Start

### Requirements

- Windows 10 or 11
- Node.js 22.5 or newer
- Microsoft Edge for browser-profile authentication

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

## Engineering Quality

The project uses the built-in Node.js test runner and real temporary SQLite databases. The acceptance suite covers 60-site concurrency, partial failures, authentication refresh, Provider normalization, change-only history, API authorization, credential redaction, and restart recovery.

```powershell
npm test
npm run test:acceptance
```

The suite intentionally excludes screenshot, responsive, layout, and visual-regression tests.

## Troubleshooting

- **Port 5177 is already in use:** stop the previous Node process or start with a different `PORT` value.
- **Edge login does not open:** verify Microsoft Edge is installed in its standard Windows location.
- **A site shows `login_required`:** edit its credentials or run the explicit Login/Validate action; scheduled jobs never open interactive login windows.
- **LAN API returns 401:** generate a new API key in Settings and send it as a Bearer token.
- **Credentials fail after moving computers:** DPAPI is bound to the original Windows user; enter the credentials again on the new machine.

## Project Docs

- [Authentication, NewAPI, changes, and external API plan](docs/superpowers/plans/2026-07-13-auth-newapi-changes-external-api.md)
- [Encrypted export design](docs/superpowers/specs/2026-07-13-provider-cleanup-encrypted-export-design.md)
- [Encrypted export implementation plan](docs/superpowers/plans/2026-07-13-provider-cleanup-encrypted-export.md)

## Privacy & Security

Runtime data lives outside the repository:

```text
%LOCALAPPDATA%\GroupPriceFetcher\data\prices.db
%LOCALAPPDATA%\GroupPriceFetcher\data\credentials.vault
%LOCALAPPDATA%\GroupPriceFetcher\profiles
```

- Passwords and NewAPI tokens are encrypted with Windows DPAPI CurrentUser scope.
- Access tokens, refresh tokens, cookies, and passwords are excluded from SQLite, logs, exports, and API responses.
- API keys are stored as SHA-256 hashes.
- DPAPI and Edge profile state are not portable to another Windows account; re-authenticate after migration.
- Respect each upstream site's terms, rate limits, and access rules.

## Release & Updates

The current source version is `0.1.0`. Release notes and migration details will be published through GitHub Releases when tagged releases begin.

## Roadmap

- Remove the legacy visible Uling19 Provider and migrate existing configurations to sub2api.
- Add ordinary JSON/CSV exports.
- Add password-encrypted portable backup and offline restore.
- Add optional change notifications after the core backup workflow is stable.

## Contributing

Issues and focused pull requests are welcome. Keep credentials and runtime databases out of fixtures, add behavior-first tests, and run `npm test` before submitting.

## License

Released under the [MIT License](LICENSE).
