import { readdir, readFile, stat } from "node:fs/promises";
import { existsSync } from "node:fs";
import { spawn } from "node:child_process";
import path from "node:path";
import { normalizeBaseUrl } from "./httpClient.js";

const TOKEN_RE = /[A-Za-z0-9._-]{24,}/g;
const JWT_RE = /eyJ[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+/g;
const ORIGIN_MARKER_RE = /(?:https?:\/\/|chrome-extension:\/\/)[^\s\u0000"'<>]+/g;
const tokenCache = new Map();

export class EdgeAuthError extends Error {
  constructor(message, details = {}) {
    super(message);
    this.name = "EdgeAuthError";
    this.details = details;
  }
}

export async function resolveEdgeToken(baseUrl, options = {}) {
  const origin = originFromBaseUrl(baseUrl);
  const allowRefresh = options.allowRefresh !== false;
  const openEdgeOnFailure = options.openEdgeOnFailure === true;
  const cached = tokenCache.get(origin);
  if (cached && cached.expiresAt > Date.now() + 60_000) {
    return {
      token: cached.token,
      origin,
      profile: cached.profile,
      source: cached.source
    };
  }

  let scan = await scanEdgeProfiles(origin, options);
  if (scan.accessToken) return scan.accessToken;

  if (openEdgeOnFailure) {
    const opened = await openEdgeForOrigin(origin, options);
    if (opened) {
      scan = await waitForEdgeToken(origin, options);
      if (scan.accessToken) return scan.accessToken;
    }
  }

  if (allowRefresh) {
    for (const candidate of scan.refreshTokens) {
      const refreshed = await refreshAccessToken(origin, candidate.value, options.fetchImpl);
      if (refreshed?.accessToken) {
        const resolved = {
          token: refreshed.accessToken,
          refreshToken: refreshed.refreshToken,
          origin,
          profile: candidate.profile,
          source: "edge:refresh_token",
          expiresIn: refreshed.expiresIn
        };
        rememberToken(origin, resolved);
        return resolved;
      }
    }
  }

  throw new EdgeAuthError("没有找到可用的 Edge 登录态，可能该站未登录或登录已过期", {
    origin,
    diagnostics: scan.diagnostics,
    refreshAttempted: allowRefresh,
    edgeOpened: openEdgeOnFailure
  });
}

async function waitForEdgeToken(origin, options = {}) {
  const waitMs = Math.max(0, Number(options.edgeWaitMs ?? options.edgeSettleMs ?? 8_000));
  const pollMs = Math.max(100, Number(options.edgePollMs ?? 2_000));
  const settleMs = Math.max(0, Number(options.edgeSettleMs ?? Math.min(8_000, waitMs)));
  const deadline = Date.now() + waitMs;

  if (settleMs > 0) await sleep(settleMs);

  let scan = await scanEdgeProfiles(origin, options);
  while (!scan.accessToken && Date.now() < deadline) {
    await sleep(Math.min(pollMs, Math.max(0, deadline - Date.now())));
    scan = await scanEdgeProfiles(origin, options);
  }

  return scan;
}

export function clearEdgeTokenCache() {
  tokenCache.clear();
}

export async function listEdgeProfiles(edgeRoot = defaultEdgeRoot()) {
  if (!edgeRoot || !existsSync(edgeRoot)) return [];

  const entries = await readdir(edgeRoot, { withFileTypes: true });
  const profiles = [];

  for (const entry of entries) {
    if (!entry.isDirectory()) continue;
    if (entry.name !== "Default" && !/^Profile \d+$/.test(entry.name)) continue;

    const profilePath = path.join(edgeRoot, entry.name);
    const levelDbPath = path.join(profilePath, "Local Storage", "leveldb");
    if (!existsSync(levelDbPath)) continue;
    profiles.push({ name: entry.name, path: profilePath, levelDbPath });
  }

  return profiles;
}

export async function scanEdgeProfiles(origin, options = {}) {
  const profiles = await listEdgeProfiles(options.edgeRoot);
  const diagnostics = [];
  const refreshTokens = [];

  for (const profile of profiles) {
    const candidates = await extractProfileCandidates(profile, origin);
    diagnostics.push({
      profile: profile.name,
      authCandidates: candidates.authTokens.length,
      refreshCandidates: candidates.refreshTokens.length,
      authUserRecords: candidates.authUserRecords
    });

    for (const token of candidates.authTokens) {
      const validation = await validateAccessToken(origin, token.value, options.fetchImpl);
      if (validation.ok) {
        const resolved = {
          token: token.value,
          origin,
          profile: profile.name,
          source: "edge:auth_token"
        };
        rememberToken(origin, resolved);
        return { accessToken: resolved, refreshTokens, diagnostics };
      }
    }

    for (const refreshToken of candidates.refreshTokens) {
      refreshTokens.push({ ...refreshToken, profile: profile.name });
    }
  }

  return { accessToken: null, refreshTokens: newestFirst(refreshTokens), diagnostics };
}

export function extractCandidatesFromText(text, origin, keyName) {
  const results = [];
  const isAuthToken = keyName === "auth_token";
  const tokenRe = isAuthToken ? JWT_RE : TOKEN_RE;
  const keyNames = candidateKeyNames(keyName);
  let index = -1;

  while ((index = text.indexOf(origin, index + 1)) !== -1) {
    const windowText = text.slice(index, Math.min(text.length, index + 7000));
    for (const candidateKeyName of keyNames) {
      let keyIndex = -1;

      while ((keyIndex = windowText.indexOf(candidateKeyName, keyIndex + 1)) !== -1) {
        if (!isStandaloneKey(windowText, keyIndex, candidateKeyName)) continue;
        if (crossesAnotherOrigin(windowText.slice(0, keyIndex), origin)) continue;

        const afterKey = windowText.slice(
          keyIndex + candidateKeyName.length,
          keyIndex + candidateKeyName.length + 3000
        );
        const matches = [...afterKey.matchAll(tokenRe)].map((match) => match[0]);

        for (const value of matches) {
          if (value === keyName || value === "auth_token" || value === "refresh_token") continue;
          results.push(value);
        }
      }
    }
  }

  return dedupe(results);
}

function candidateKeyNames(keyName) {
  return keyName.length > 1 ? [keyName, keyName.slice(1)] : [keyName];
}

function isStandaloneKey(text, index, keyName) {
  const before = text[index - 1] ?? "";
  const after = text[index + keyName.length] ?? "";
  return !/[A-Za-z0-9_]/.test(before) && !/[A-Za-z0-9_]/.test(after);
}

function crossesAnotherOrigin(text, targetOrigin) {
  ORIGIN_MARKER_RE.lastIndex = 0;
  for (const match of text.matchAll(ORIGIN_MARKER_RE)) {
    if (!match[0].includes(targetOrigin)) return true;
  }
  return false;
}

async function extractProfileCandidates(profile, origin) {
  const files = await listLevelDbFiles(profile.levelDbPath);
  const authTokens = [];
  const refreshTokens = [];
  let authUserRecords = 0;

  for (const file of files) {
    const text = (await readFile(file.path)).toString("latin1");
    const meta = {
      file: path.basename(file.path),
      mtimeMs: file.mtimeMs
    };

    for (const value of extractCandidatesFromText(text, origin, "auth_token")) {
      authTokens.push({ value, ...meta });
    }

    for (const value of extractCandidatesFromText(text, origin, "refresh_token")) {
      refreshTokens.push({ value, ...meta });
    }

    authUserRecords += countKeyRecordsFromText(text, origin, "auth_user");
  }

  return {
    authTokens: newestFirst(dedupeCandidateObjects(authTokens)),
    refreshTokens: newestFirst(dedupeCandidateObjects(refreshTokens)),
    authUserRecords
  };
}

function countKeyRecordsFromText(text, origin, keyName) {
  let count = 0;
  let index = -1;

  while ((index = text.indexOf(origin, index + 1)) !== -1) {
    const windowText = text.slice(index, Math.min(text.length, index + 2000));
    let keyIndex = -1;

    while ((keyIndex = windowText.indexOf(keyName, keyIndex + 1)) !== -1) {
      if (!isStandaloneKey(windowText, keyIndex, keyName)) continue;
      if (crossesAnotherOrigin(windowText.slice(0, keyIndex), origin)) continue;
      count += 1;
      break;
    }
  }

  return count;
}

async function listLevelDbFiles(levelDbPath) {
  if (!existsSync(levelDbPath)) return [];
  const entries = await readdir(levelDbPath, { withFileTypes: true });
  const files = [];

  for (const entry of entries) {
    if (!entry.isFile() || !/\.(ldb|log)$/.test(entry.name)) continue;
    const filePath = path.join(levelDbPath, entry.name);
    const info = await stat(filePath);
    files.push({ path: filePath, mtimeMs: info.mtimeMs });
  }

  return files.sort((a, b) => b.mtimeMs - a.mtimeMs);
}

async function validateAccessToken(origin, token, fetchImpl = globalThis.fetch) {
  try {
    const response = await fetchImpl(new URL("/api/v1/auth/me", origin), {
      headers: {
        Authorization: `Bearer ${token}`,
        Accept: "application/json",
        "Accept-Language": "zh"
      }
    });
    const payload = await safeJson(response);
    return { ok: response.ok && payload?.code === 0, status: response.status, code: payload?.code };
  } catch (error) {
    return { ok: false, error: error.message };
  }
}

async function refreshAccessToken(origin, refreshToken, fetchImpl = globalThis.fetch) {
  try {
    const response = await fetchImpl(new URL("/api/v1/auth/refresh", origin), {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Accept: "application/json"
      },
      body: JSON.stringify({ refresh_token: refreshToken })
    });
    const payload = await safeJson(response);
    if (!response.ok || payload?.code !== 0 || !payload?.data?.access_token) return null;

    return {
      accessToken: payload.data.access_token,
      refreshToken: payload.data.refresh_token,
      expiresIn: payload.data.expires_in
    };
  } catch {
    return null;
  }
}

async function openEdgeForOrigin(origin, options = {}) {
  const executable = options.edgeExecutable || findEdgeExecutable();
  if (!executable) return false;

  const targetUrl = new URL("/keys", origin).toString();
  try {
    const child = spawn(executable, [targetUrl], {
      detached: true,
      stdio: "ignore",
      windowsHide: true
    });
    child.unref();
    return true;
  } catch {
    return false;
  }
}

async function safeJson(response) {
  const text = await response.text();
  try {
    return JSON.parse(text);
  } catch {
    return null;
  }
}

function originFromBaseUrl(baseUrl) {
  const normalized = normalizeBaseUrl(baseUrl);
  const parsed = new URL(normalized);
  return parsed.origin;
}

function defaultEdgeRoot() {
  const localAppData = process.env.LOCALAPPDATA;
  return localAppData
    ? path.join(localAppData, "Microsoft", "Edge", "User Data")
    : "";
}

export function findEdgeExecutable() {
  if (process.platform !== "win32") return "";
  const candidates = [
    path.join(process.env.ProgramFiles || "", "Microsoft", "Edge", "Application", "msedge.exe"),
    path.join(process.env["ProgramFiles(x86)"] || "", "Microsoft", "Edge", "Application", "msedge.exe"),
    path.join(process.env.LOCALAPPDATA || "", "Microsoft", "Edge", "Application", "msedge.exe")
  ];
  return candidates.find((candidate) => candidate && existsSync(candidate)) || "";
}

function rememberToken(origin, resolved) {
  const ttlMs = Number.isFinite(Number(resolved.expiresIn))
    ? Math.max(60_000, Number(resolved.expiresIn) * 1000)
    : 5 * 60_000;
  tokenCache.set(origin, {
    token: resolved.token,
    profile: resolved.profile,
    source: resolved.source,
    expiresAt: Date.now() + ttlMs
  });
}

function dedupe(values) {
  const seen = new Set();
  return values.filter((value) => !seen.has(value) && seen.add(value));
}

function dedupeCandidateObjects(values) {
  const seen = new Set();
  return values.filter((item) => !seen.has(item.value) && seen.add(item.value));
}

function newestFirst(values) {
  return values.sort((a, b) => b.mtimeMs - a.mtimeMs);
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
