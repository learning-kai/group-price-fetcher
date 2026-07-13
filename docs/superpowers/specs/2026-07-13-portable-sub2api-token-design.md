# Portable sub2api Token Authentication Design

## Goal

Allow a sub2api login established through the dedicated Edge Profile on Windows to become a portable credential that can be copied into, or transferred securely to, an independent Linux instance.

## Authentication Model

Add `sub2api-token` as a first-class authentication mode. Its encrypted credential record contains:

- `accessToken`: required.
- `refreshToken`: optional but recommended.

The mode is distinct from `edge-profile`: Edge remains a Windows-only interactive login source, while `sub2api-token` is a platform-independent stored credential. Raw tokens never enter SQLite, logs, ordinary exports, or normal site API responses.

## Windows Extraction Flow

When editing an existing sub2api site on Windows, the dialog exposes an explicit `提取 Edge 登录态` command. The server reads the dedicated browser Profile, validates or refreshes the session, and returns the access and refresh tokens only to this user-initiated loopback request.

The browser switches the form to `sub2api-token` and fills the two sensitive inputs. The user can copy the values or save the form. Closing or saving the dialog clears both inputs. Extraction does not silently change the saved site until the user submits the form.

## Linux Editing Flow

The same site dialog exposes `sub2api-token` on Linux with password-type inputs for Access Token and Refresh Token. Linux does not show Edge login or Edge import commands. Saving stores the tokens in the Linux AES-256-GCM credential vault and records only masked authentication metadata in SQLite.

## Runtime Token Flow

For `sub2api-token` collection:

1. Load the encrypted credential record.
2. Reuse a valid Access Token.
3. If forced refresh is requested or the Access Token is rejected, use the Refresh Token.
4. Persist rotated tokens back to the encrypted credential vault.
5. If neither token can produce valid access, mark the site `login_required` without exposing either value.

## Transfer Compatibility

`.gpftransfer` exports `sub2api-token` credentials as `{ accessToken, refreshToken }` inside the existing encrypted envelope. Import accepts an empty Refresh Token but requires an Access Token. Same-URL overwrite and history-preservation rules remain unchanged.

The payload schema stays at version 1 because no envelope or site-field shape changes; this adds one authentication-mode enum value and one credential variant. Older applications will reject the unknown mode instead of partially importing it.

## API And UI Changes

- `GET /api/status` exposes `browserAuthSupported`.
- `POST /api/sites/:id/capture-browser-session` performs the explicit one-time extraction.
- Site credential configuration accepts `sub2api-token`.
- Site edit fields and row actions honor `browserAuthSupported` so Linux never offers Edge-only commands.
- Sensitive extraction responses use `Cache-Control: no-store` and are never logged.

## Error Handling

- Extraction on Linux returns `BROWSER_AUTH_UNAVAILABLE` with HTTP 501.
- Extraction for a non-sub2api site or incomplete session returns a stable 400/401 error.
- Missing Access Token is a validation error.
- Invalid or expired portable tokens set `login_required` and keep secrets redacted.
- A failed refresh does not overwrite the last stored credential record.

## Verification

Automated tests cover:

- Access Token reuse and Refresh Token rotation.
- Encrypted-vault persistence without SQLite or response leakage.
- Windows browser-session extraction and Linux capability rejection.
- Manual credential configuration through the management API.
- `.gpftransfer` round trips for `sub2api-token`.
- UI capability gating, sensitive input clearing, and API contracts.
- Existing password, NewAPI, Edge, backup, history, and collection behavior.

After local verification, deploy the same source to the Linux systemd service, verify authenticated HTTPS access and a token-mode API smoke test, then publish the commit to GitHub `main`.
