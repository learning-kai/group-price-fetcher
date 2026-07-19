import { spawn } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import http from 'node:http';
import { setTimeout as sleep } from 'node:timers/promises';
import { resolveEdgeToken } from './edgeAuth.js';

function arg(name, fallback = null) {
  const idx = process.argv.indexOf(name);
  if (idx >= 0 && process.argv[idx + 1] !== undefined) return process.argv[idx + 1];
  return fallback;
}

const baseUrl = arg('--url') || process.argv[2] || 'https://uni-token.com';
const openEdge = process.argv.includes('--open');
const printTokens = process.argv.includes('--print-tokens');
const pollSeconds = Math.max(0, Number(arg('--poll-seconds', '180')) || 0);
const pollIntervalMs = Math.max(500, Number(arg('--poll-interval-ms', '2000')) || 2000);
const origin = String(baseUrl).replace(/\/+$/, '');
const keysUrl = `${origin}/keys`;
const host = (() => { try { return new URL(origin).hostname; } catch { return 'uni-token.com'; } })();
const local = process.env.LOCALAPPDATA || '';
const edgeExe = [
  'C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe',
  'C:\\Program Files\\Microsoft\\Edge\\Application\\msedge.exe'
].find((p) => fs.existsSync(p));

// Dedicated profile for auth capture. Never touch the user's daily Edge profile.
const authUserData = path.join(local, 'Temp', 'gpf-edge-auth-profile');
const debugPort = 9333;

function summarize(result, extra = {}) {
  const token = result?.token || result?.accessToken || null;
  const refreshToken = result?.refreshToken || null;
  return {
    ok: Boolean(token),
    source: result?.source || extra.source || null,
    profile: result?.profile || extra.profile || null,
    origin: result?.origin || origin,
    tokenPreview: token ? `${String(token).slice(0, 12)}...(${String(token).length})` : null,
    refreshPreview: refreshToken ? `${String(refreshToken).slice(0, 12)}...(${String(refreshToken).length})` : null,
    diagnostics: result?.diagnostics || extra.diagnostics || null,
    edgeOpened: Boolean(result?.edgeOpened || extra.edgeOpened),
    error: result?.error || extra.error || null,
    accessToken: printTokens && token ? token : undefined,
    refreshToken: printTokens && refreshToken ? refreshToken : undefined,
    validated: extra.validated ?? null
  };
}

function getJson(url) {
  return new Promise((resolve, reject) => {
    const req = http.get(url, (res) => {
      let data = '';
      res.on('data', (c) => { data += c; });
      res.on('end', () => {
        try { resolve(JSON.parse(data)); }
        catch (e) { reject(e); }
      });
    });
    req.on('error', reject);
    req.setTimeout(2000, () => {
      req.destroy(new Error('timeout'));
    });
  });
}

async function cdpSession(wsUrl, fn) {
  const WS = globalThis.WebSocket;
  return new Promise((resolve, reject) => {
    const ws = new WS(wsUrl);
    let id = 0;
    const pending = new Map();
    const send = (method, params = {}) => new Promise((res, rej) => {
      const my = ++id;
      pending.set(my, { res, rej });
      ws.send(JSON.stringify({ id: my, method, params }));
    });
    const timer = setTimeout(() => {
      try { ws.close(); } catch {}
      reject(new Error('cdp session timeout'));
    }, 30000);
    ws.addEventListener('open', async () => {
      try {
        const out = await fn(send);
        clearTimeout(timer);
        ws.close();
        resolve(out);
      } catch (e) {
        clearTimeout(timer);
        try { ws.close(); } catch {}
        reject(e);
      }
    });
    ws.addEventListener('message', (ev) => {
      const msg = JSON.parse(typeof ev.data === 'string' ? ev.data : Buffer.from(ev.data).toString());
      if (msg.id && pending.has(msg.id)) {
        const { res, rej } = pending.get(msg.id);
        pending.delete(msg.id);
        if (msg.error) rej(new Error(JSON.stringify(msg.error)));
        else res(msg.result);
      }
    });
    ws.addEventListener('error', (e) => {
      clearTimeout(timer);
      reject(e.error || e);
    });
  });
}

async function validateToken(accessToken) {
  try {
    const r = await fetch(`${origin}/api/v1/auth/me`, {
      headers: {
        Authorization: `Bearer ${accessToken}`,
        Accept: 'application/json',
        'Accept-Language': 'zh',
        'User-Agent': 'Mozilla/5.0'
      }
    });
    let p = null;
    try { p = await r.json(); } catch {}
    return {
      ok: Boolean(r.ok && p && p.code === 0),
      status: r.status,
      code: p?.code || null,
      message: p?.message || null
    };
  } catch (e) {
    return { ok: false, error: String(e.message || e) };
  }
}

function ensureAuthProfileDir() {
  fs.mkdirSync(authUserData, { recursive: true });
}

async function isDebugPortLive() {
  try {
    const targets = await getJson(`http://127.0.0.1:${debugPort}/json/list`);
    return Array.isArray(targets) ? targets : null;
  } catch {
    return null;
  }
}

async function openDedicatedEdge() {
  if (!edgeExe) return { ok: false, error: '未找到 msedge.exe' };
  ensureAuthProfileDir();

  // If a previous auth Edge is already on 9333, reuse it and just open/navigate.
  let targets = await isDebugPortLive();
  if (!targets) {
    // Launch SEPARATE instance. Do NOT kill user's main Edge. Do NOT use daily profile.
    const args = [
      `--remote-debugging-port=${debugPort}`,
      `--user-data-dir=${authUserData}`,
      '--no-first-run',
      '--no-default-browser-check',
      '--new-window',
      keysUrl
    ];
    // Prefer direct spawn so debugging port belongs to this process tree.
    const child = spawn(edgeExe, args, {
      detached: true,
      stdio: 'ignore',
      windowsHide: false
    });
    child.unref();

    for (let i = 0; i < 50; i++) {
      await sleep(400);
      targets = await isDebugPortLive();
      if (targets) break;
    }
  }

  if (!targets) {
    // Last resort: shell open URL in default browser (may be main Edge, still same machine egress)
    try {
      spawn('cmd.exe', ['/c', 'start', '', keysUrl], {
        detached: true,
        stdio: 'ignore',
        windowsHide: true
      }).unref();
    } catch {}
    return {
      ok: false,
      edgeOpened: true,
      error: '已尝试打开浏览器，但未能挂上调试端口；将改为磁盘扫描等待登录'
    };
  }

  // Ensure a page on target host exists; if not, create one via /json/new
  let page = targets.find((t) => (t.url || '').includes(host) && t.webSocketDebuggerUrl)
    || targets.find((t) => t.webSocketDebuggerUrl && (t.type === 'page' || (t.url || '').startsWith('http')));

  if (!page || !(page.url || '').includes(host)) {
    try {
      // Chrome DevTools HTTP endpoint to open a new tab
      await new Promise((resolve, reject) => {
        const req = http.get(`http://127.0.0.1:${debugPort}/json/new?${encodeURIComponent(keysUrl)}`, (res) => {
          res.resume();
          res.on('end', resolve);
        });
        req.on('error', reject);
        req.setTimeout(3000, () => { req.destroy(new Error('timeout')); });
      });
      await sleep(1000);
      targets = await isDebugPortLive();
      page = (targets || []).find((t) => (t.url || '').includes(host) && t.webSocketDebuggerUrl) || page;
    } catch {}
  }

  if (page?.webSocketDebuggerUrl && !(page.url || '').includes(host)) {
    try {
      await cdpSession(page.webSocketDebuggerUrl, async (send) => {
        await send('Page.enable');
        await send('Page.navigate', { url: keysUrl });
      });
      await sleep(1500);
      targets = await isDebugPortLive();
    } catch {}
  }

  return { ok: true, edgeOpened: true, targets: targets || [] };
}

async function readTokenFromTargets(targets) {
  const pages = (targets || []).filter((t) => t.webSocketDebuggerUrl);
  const page = pages.find((t) => (t.url || '').includes(host)) || pages[0];
  if (!page) return null;
  const value = await cdpSession(page.webSocketDebuggerUrl, async (send) => {
    await send('Runtime.enable');
    const result = await send('Runtime.evaluate', {
      expression: `(() => ({
        href: location.href,
        keys: Object.keys(localStorage || {}),
        auth_token: localStorage.getItem('auth_token'),
        refresh_token: localStorage.getItem('refresh_token'),
        token_expires_at: localStorage.getItem('token_expires_at')
      }))()`,
      returnByValue: true
    });
    return result?.result?.value || null;
  });
  if (!value?.auth_token) return { value, token: null };
  return {
    value,
    token: value.auth_token,
    refreshToken: value.refresh_token || '',
    source: 'cdp:dedicated-edge',
    profile: 'gpf-edge-auth-profile'
  };
}

// 0) Fast path: existing valid token already on default profile disk and valid on Windows egress
try {
  const existing = await resolveEdgeToken(origin, { openEdgeOnFailure: false });
  if (existing?.token) {
    const v = await validateToken(existing.token);
    if (v.ok) {
      console.log(JSON.stringify(summarize({
        token: existing.token,
        refreshToken: existing.refreshToken,
        source: existing.source,
        profile: existing.profile,
        origin,
        edgeOpened: false
      }, { validated: v }), null, 2));
      process.exit(0);
    }
  }
} catch {}

let edgeOpened = false;
let targets = null;
if (openEdge) {
  const opened = await openDedicatedEdge();
  edgeOpened = Boolean(opened.edgeOpened || opened.ok);
  targets = opened.targets || null;
  if (!opened.ok && opened.error) {
    // continue polling disk/CDP anyway
  }
}

const deadline = Date.now() + pollSeconds * 1000;
let last = null;
do {
  if (!targets) {
    targets = await isDebugPortLive();
  }
  if (targets?.length) {
    try {
      const live = await readTokenFromTargets(targets);
      last = live;
      if (live?.token) {
        const v = await validateToken(live.token);
        if (v.ok) {
          console.log(JSON.stringify(summarize({
            token: live.token,
            refreshToken: live.refreshToken,
            source: live.source,
            profile: live.profile,
            origin,
            edgeOpened
          }, { validated: v }), null, 2));
          process.exit(0);
        }
        last = { ...live, validated: v };
      }
    } catch (e) {
      last = { error: String(e.message || e) };
    }
  }

  // Secondary: default profile disk scan (may work after login flush)
  try {
    const disk = await resolveEdgeToken(origin, { openEdgeOnFailure: false });
    if (disk?.token) {
      const v = await validateToken(disk.token);
      if (v.ok) {
        console.log(JSON.stringify(summarize({
          token: disk.token,
          refreshToken: disk.refreshToken,
          source: disk.source,
          profile: disk.profile,
          origin,
          edgeOpened
        }, { validated: v }), null, 2));
        process.exit(0);
      }
    }
  } catch {}

  if (pollSeconds <= 0) break;
  await sleep(pollIntervalMs);
  targets = await isDebugPortLive();
} while (Date.now() <= deadline);

console.log(JSON.stringify(summarize(null, {
  edgeOpened,
  error: last?.validated?.message
    || last?.error
    || '未在 Windows 专用 Edge 窗口拿到可用 token。请在新弹出的 Edge 登录窗完成登录（含验证码），不要关主 Edge。',
  diagnostics: last?.value || last || null,
  validated: last?.validated || null
}), null, 2));
process.exit(3);
