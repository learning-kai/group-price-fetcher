#!/usr/bin/env node
/**
 * After manual captcha login on VPS Chromium profile, extract auth token
 * and import into Group Price Fetcher for a site.
 *
 * Usage:
 *   node scripts/import-captcha-profile.mjs --site 9 --profile /var/lib/.../chrome-profile
 *   node scripts/import-captcha-profile.mjs --site 章泓 --url https://api-provider.uling19.com
 */
import { spawn } from "node:child_process";
import { access, mkdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import process from "node:process";

function arg(name, fallback = "") {
  const idx = process.argv.indexOf(`--${name}`);
  if (idx >= 0 && process.argv[idx + 1]) return process.argv[idx + 1];
  return fallback;
}

function hasFlag(name) {
  return process.argv.includes(`--${name}`);
}

const siteArg = arg("site", "9");
const profileDir = arg("profile", "/var/lib/group-price-fetcher/captcha-session/captcha/chrome-profile");
const baseUrl = arg("url", "https://api-provider.uling19.com");
const apiBase = arg("api", "http://127.0.0.1:5177");
const browsersPath = process.env.PLAYWRIGHT_BROWSERS_PATH
  || "/var/lib/group-price-fetcher/ms-playwright";

async function api(method, urlPath, body) {
  const res = await fetch(`${apiBase}${urlPath}`, {
    method,
    headers: body ? { "Content-Type": "application/json", Accept: "application/json" } : { Accept: "application/json" },
    body: body ? JSON.stringify(body) : undefined,
  });
  const text = await res.text();
  let json = null;
  try { json = JSON.parse(text); } catch {}
  if (!res.ok) {
    const msg = json?.error || json?.message || text || res.statusText;
    throw new Error(`${method} ${urlPath} -> ${res.status}: ${msg}`);
  }
  return json;
}

async function resolveSiteId() {
  if (/^\d+$/.test(siteArg)) return Number(siteArg);
  const sites = await api("GET", "/api/sites");
  const list = Array.isArray(sites) ? sites : (sites.items || []);
  const hit = list.find((s) => String(s.name) === siteArg);
  if (!hit) throw new Error(`site not found: ${siteArg}`);
  return hit.id;
}

async function extractTokenFromProfile() {
  process.env.PLAYWRIGHT_BROWSERS_PATH = browsersPath;
  const { chromium } = await import("playwright-core");
  // Reuse the same user-data-dir that captcha session used.
  const context = await chromium.launchPersistentContext(profileDir, {
    headless: true,
    args: ["--no-sandbox", "--disable-dev-shm-usage", "--disable-gpu"],
    locale: "zh-CN",
    viewport: { width: 1360, height: 860 },
  });
  try {
    const page = context.pages()[0] || await context.newPage();
    await page.goto(baseUrl.replace(/\/+$/, "") + "/", {
      waitUntil: "domcontentloaded",
      timeout: 45000,
    }).catch(() => {});
    // Prefer localStorage auth_token
    let token = await page.evaluate(() => {
      const bag = { ...localStorage, ...sessionStorage };
      const prefer = ["auth_token", "access_token", "token"];
      for (const k of prefer) {
        const v = bag[k];
        if (typeof v === "string" && v.startsWith("eyJ")) return v;
      }
      for (const k of Object.keys(bag)) {
        const v = bag[k];
        if (typeof v === "string" && v.startsWith("eyJ")) return v;
        try {
          const o = JSON.parse(v);
          const t = o.access_token || o.token || o.accessToken || o?.data?.access_token;
          if (t && String(t).startsWith("eyJ")) return String(t);
        } catch {}
      }
      return "";
    });
    if (!token) {
      // Try me endpoints won't work without token; dump keys for diagnostics
      const keys = await page.evaluate(() => Object.keys({ ...localStorage, ...sessionStorage }));
      throw new Error(`no auth token in profile storage; keys=${keys.join(",") || "(empty)"}`);
    }
    const me = await page.evaluate(async (tok) => {
      const r = await fetch("/api/v1/auth/me", {
        headers: { Authorization: `Bearer ${tok}`, Accept: "application/json" },
      });
      const j = await r.json().catch(() => ({}));
      return { status: r.status, code: j.code, message: j.message, balance: j?.data?.balance, email: j?.data?.email };
    }, token);
    return { token, me };
  } finally {
    await context.close().catch(() => {});
  }
}

async function main() {
  await access(profileDir);
  const siteId = await resolveSiteId();
  const { token, me } = await extractTokenFromProfile();
  if (!(me && me.code === 0)) {
    throw new Error(`token extracted but /auth/me failed: ${JSON.stringify(me)}`);
  }
  await api("PUT", `/api/sites/${siteId}/credentials`, {
    authMode: "sub2api-token",
    accessToken: token,
    refreshToken: "",
  });
  const login = await api("POST", `/api/sites/${siteId}/login`);
  let refresh = null;
  try {
    refresh = await api("POST", `/api/sites/${siteId}/refresh`);
  } catch (e) {
    refresh = { error: String(e.message || e) };
  }
  const site = await api("GET", `/api/sites/${siteId}`);
  const out = {
    ok: site.authStatus === "valid",
    siteId,
    email: me.email || null,
    balance: me.balance ?? site.balanceUsd ?? null,
    authStatus: site.authStatus,
    authError: site.authError || "",
    lastCollectedAt: site.lastCollectedAt,
    gptGroup: site.gptCurrentRateGroupName,
    gptRate: site.gptCurrentRateMultiplier,
    loginSource: login?.source || null,
    refreshError: refresh?.error || null,
  };
  console.log(JSON.stringify(out, null, 2));
  if (!out.ok) process.exit(2);
}

main().catch((err) => {
  console.error(JSON.stringify({ ok: false, error: String(err.message || err) }, null, 2));
  process.exit(1);
});
