import { mkdir } from "node:fs/promises";
import path from "node:path";
import { createHash } from "node:crypto";

const DEFAULT_BROWSER_PATH = process.env.PLAYWRIGHT_BROWSERS_PATH
  || path.join(process.env.GROUP_PRICE_FETCHER_HOME || process.env.HOME || "/var/lib/group-price-fetcher", "ms-playwright");

const DEFAULT_PROFILE_ROOT = process.env.PLAYWRIGHT_PROFILE_ROOT
  || path.join(process.env.GROUP_PRICE_FETCHER_HOME || process.env.HOME || "/var/lib/group-price-fetcher", "playwright-profiles");

let launchPromise = null;
let sharedBrowser = null;
const contextLocks = new Map();
const contexts = new Map();

function envFlag(name, fallback = false) {
  const raw = process.env[name];
  if (raw == null || raw === "") return fallback;
  return !["0", "false", "no", "off"].includes(String(raw).toLowerCase());
}

export function playwrightBrowserBridgeConfigured() {
  // Enabled by default when the bridge module is present; allow hard-disable.
  if (envFlag("PLAYWRIGHT_BROWSER_BRIDGE", true) === false) return false;
  if (String(process.env.PLAYWRIGHT_BROWSER_BRIDGE || "").toLowerCase() === "0") return false;
  return true;
}

function originFromUrl(url) {
  return new URL(String(url)).origin;
}

function hostFromUrl(url) {
  return new URL(String(url)).hostname.toLowerCase();
}

function profileKeyForOrigin(origin) {
  return createHash("sha1").update(String(origin)).digest("hex").slice(0, 16);
}

async function withLock(key, fn) {
  const prev = contextLocks.get(key) || Promise.resolve();
  let release;
  const gate = new Promise((resolve) => { release = resolve; });
  contextLocks.set(key, prev.then(() => gate, () => gate));
  await prev.catch(() => {});
  try {
    return await fn();
  } finally {
    release();
    if (contextLocks.get(key) === gate) contextLocks.delete(key);
  }
}

async function ensureBrowser() {
  if (sharedBrowser) return sharedBrowser;
  if (launchPromise) return launchPromise;
  launchPromise = (async () => {
    process.env.PLAYWRIGHT_BROWSERS_PATH = process.env.PLAYWRIGHT_BROWSERS_PATH || DEFAULT_BROWSER_PATH;
    const { chromium } = await import("playwright-core");
    const browser = await chromium.launch({
      headless: true,
      args: [
        "--no-sandbox",
        "--disable-dev-shm-usage",
        "--disable-gpu",
        "--disable-extensions",
        "--disable-background-networking",
        "--disable-default-apps",
        "--disable-sync",
        "--no-first-run",
      ],
    });
    browser.on("disconnected", () => {
      sharedBrowser = null;
      contexts.clear();
    });
    sharedBrowser = browser;
    return browser;
  })();
  try {
    return await launchPromise;
  } finally {
    launchPromise = null;
  }
}

async function ensureContext(origin) {
  const key = profileKeyForOrigin(origin);
  if (contexts.has(key)) return contexts.get(key);
  return withLock(`ctx:${key}`, async () => {
    if (contexts.has(key)) return contexts.get(key);
    const browser = await ensureBrowser();
    const profileDir = path.join(DEFAULT_PROFILE_ROOT, key);
    await mkdir(profileDir, { recursive: true });
    // Persistent context keeps cookies/localStorage across requests for the same origin.
    // Use chromium.launchPersistentContext alternative via storageState file if needed;
    // for low-memory VPS we keep one shared browser + per-origin context with storageState.
    const storageStatePath = path.join(profileDir, "storage.json");
    let storageState;
    try {
      storageState = storageStatePath;
      // playwright accepts path string only if file exists; try/catch open by launch option later
      const { access } = await import("node:fs/promises");
      await access(storageStatePath);
    } catch {
      storageState = undefined;
    }
    const context = await browser.newContext({
      userAgent: "Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/149.0.0.0 Safari/537.36",
      locale: "zh-CN",
      viewport: { width: 1360, height: 860 },
      storageState,
    });
    context.__profileDir = profileDir;
    context.__storageStatePath = storageStatePath;
    context.__origin = origin;
    contexts.set(key, context);
    return context;
  });
}

async function persistContext(context) {
  if (!context?.__storageStatePath) return;
  try {
    await context.storageState({ path: context.__storageStatePath });
  } catch {
    // ignore persistence failures
  }
}

function headersToObject(headers = {}) {
  const out = {};
  if (!headers) return out;
  if (typeof headers.forEach === "function") {
    headers.forEach((v, k) => { out[k] = v; });
    return out;
  }
  for (const [k, v] of Object.entries(headers)) {
    if (v == null) continue;
    out[k] = String(v);
  }
  return out;
}

function isBindingMismatchPayload(status, json, text) {
  const msg = String(json?.message || json?.reason || text || "");
  const code = json?.code;
  return (
    status === 401 &&
    (code === "SESSION_BINDING_MISMATCH" ||
      /SESSION_BINDING_MISMATCH|fingerprint changed|session network fingerprint/i.test(msg))
  );
}

/**
 * Fetch inside a real Chromium page context on this VPS.
 * Seeds bearer tokens into localStorage so subsequent same-origin calls share session state.
 */
export async function playwrightBrowserFetch(url, {
  method = "GET",
  headers = {},
  body = null,
  timeoutMs = 45000,
} = {}) {
  if (!playwrightBrowserBridgeConfigured()) {
    throw new Error("Playwright browser bridge 未启用");
  }
  const targetUrl = String(url);
  const origin = originFromUrl(targetUrl);
  const plainHeaders = headersToObject(headers);
  const auth = plainHeaders.Authorization || plainHeaders.authorization || "";
  const bearer = String(auth).match(/^Bearer\s+(.+)$/i)?.[1] || "";

  return withLock(`fetch:${origin}`, async () => {
    const context = await ensureContext(origin);
    const page = await context.newPage();
    try {
      page.setDefaultTimeout(timeoutMs);
      // Establish origin context first (needed for storage + relative same-site semantics).
      await page.goto(origin + "/", {
        waitUntil: "domcontentloaded",
        timeout: Math.min(timeoutMs, 30000),
      }).catch(() => {});

      if (bearer) {
        await page.evaluate((tok) => {
          try { localStorage.setItem("auth_token", tok); } catch {}
          try { localStorage.setItem("access_token", tok); } catch {}
          try { localStorage.setItem("token", tok); } catch {}
          try { sessionStorage.setItem("auth_token", tok); } catch {}
        }, bearer);
      }

      const result = await page.evaluate(async ({ targetUrl: u, method: m, headers: h, body: b, timeoutMs: t }) => {
        const controller = new AbortController();
        const timer = setTimeout(() => controller.abort(), t);
        try {
          const init = { method: m, headers: h, signal: controller.signal };
          if (b != null) init.body = typeof b === "string" ? b : JSON.stringify(b);
          const response = await fetch(u, init);
          const text = await response.text();
          let json = null;
          try { json = JSON.parse(text); } catch {}
          const headerObj = {};
          response.headers.forEach((v, k) => { headerObj[k] = v; });
          return {
            ok: response.ok,
            status: response.status,
            headers: headerObj,
            text,
            json,
          };
        } catch (error) {
          return { ok: false, status: 0, error: String(error && error.message || error), text: "", json: null, headers: {} };
        } finally {
          clearTimeout(timer);
        }
      }, {
        targetUrl,
        method,
        headers: plainHeaders,
        body,
        timeoutMs,
      });

      if (result?.error && !result.status) {
        throw new Error(result.error);
      }
      await persistContext(context);
      return result;
    } finally {
      await page.close().catch(() => {});
    }
  });
}

export async function playwrightValidateBearer(baseUrl, accessToken) {
  const origin = String(baseUrl || "").replace(/\/+$/, "");
  const result = await playwrightBrowserFetch(`${origin}/api/v1/auth/me`, {
    method: "GET",
    headers: {
      Authorization: `Bearer ${accessToken}`,
      Accept: "application/json",
      "Accept-Language": "zh",
      "User-Agent": "Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/149.0.0.0 Safari/537.36",
    },
    timeoutMs: 45000,
  });
  const ok = Boolean(result.ok && result.json && result.json.code === 0);
  return {
    ok,
    status: result.status,
    code: result.json?.code || null,
    message: result.json?.message || null,
    data: result.json?.data || null,
    bindingMismatch: isBindingMismatchPayload(result.status, result.json, result.text),
  };
}

export function createPlaywrightFetchImpl() {
  return async function playwrightFetchImpl(input, init = {}) {
    const url = input instanceof URL ? input.toString() : String(input?.url || input);
    const method = init.method || "GET";
    const plainHeaders = headersToObject(init.headers || {});
    let body = init.body ?? null;
    if (body && typeof body !== "string") {
      try { body = typeof body === "object" ? JSON.stringify(body) : body.toString(); } catch { body = String(body); }
    }
    const result = await playwrightBrowserFetch(url, {
      method,
      headers: plainHeaders,
      body,
      timeoutMs: 45000,
    });
    return new Response(result.text || "", {
      status: result.status || 0,
      headers: result.headers || {},
    });
  };
}

export function playwrightSessionHosts() {
  return new Set(
    [
      ...String(process.env.PLAYWRIGHT_SESSION_HOSTS || process.env.WINDOWS_EGRESS_HOSTS || "")
        .split(",")
        .map((h) => h.trim().toLowerCase())
        .filter(Boolean),
      "uni-token.com",
      "www.uni-token.com",
      "api-provider.uling19.com",
      "uling19.com",
      "www.uling19.com",
    ]
  );
}

export function shouldUsePlaywrightForUrl(url) {
  try {
    return playwrightBrowserBridgeConfigured() && playwrightSessionHosts().has(hostFromUrl(url));
  } catch {
    return false;
  }
}

export async function closePlaywrightBrowserBridge() {
  for (const context of contexts.values()) {
    try { await persistContext(context); } catch {}
    try { await context.close(); } catch {}
  }
  contexts.clear();
  if (sharedBrowser) {
    try { await sharedBrowser.close(); } catch {}
    sharedBrowser = null;
  }
}
