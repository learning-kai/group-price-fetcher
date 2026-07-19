#!/usr/bin/env node
import { spawn } from 'node:child_process';
import { mkdir, readFile, writeFile, copyFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
function env(n, d = '') { return String(process.env[n] ?? d); }
function cfg() {
  return {
    host: env('WINDOWS_EDGE_SSH_HOST', '100.75.182.32'),
    user: env('WINDOWS_EDGE_SSH_USER', 'Lenovo'),
    keyPath: env('WINDOWS_EDGE_SSH_KEY', '/etc/group-price-fetcher/windows-tailscale'),
    remoteDir: env('WINDOWS_EDGE_REMOTE_DIR', 'C:/Users/Lenovo/AppData/Local/Temp/gpf-edge'),
    nodePath: env('WINDOWS_EDGE_NODE', 'D:\\\\nodejs\\\\node.exe'),
    sshBin: env('WINDOWS_EDGE_SSH_BIN', '/usr/bin/ssh'),
    scpBin: env('WINDOWS_EDGE_SCP_BIN', '/usr/bin/scp'),
    connectTimeout: Number(env('WINDOWS_EDGE_SSH_TIMEOUT', '12')) || 12,
  };
}
function run(cmd, args, timeoutMs = 120000) {
  return new Promise((resolve) => {
    const child = spawn(cmd, args, { stdio: ['ignore', 'pipe', 'pipe'], env: process.env });
    let stdout = '', stderr = '';
    const t = setTimeout(() => { try { child.kill('SIGKILL'); } catch {} }, timeoutMs);
    child.stdout.on('data', (c) => { stdout += c.toString('utf8'); });
    child.stderr.on('data', (c) => { stderr += c.toString('utf8'); });
    child.on('close', (code) => { clearTimeout(t); resolve({ code: code ?? 1, stdout, stderr }); });
    child.on('error', (e) => { clearTimeout(t); resolve({ code: 1, stdout, stderr: String(e.message || e) }); });
  });
}
function parseMarked(text, a, b) {
  const s = text.indexOf(a);
  if (s < 0) return null;
  const after = text.slice(s + a.length);
  const e = after.indexOf(b);
  return (e >= 0 ? after.slice(0, e) : after).trim();
}

async function windowsGrab({ origin, email, password, waitSec = 55 }) {
  const c = cfg();
  const runnerLocal = path.join(__dirname, 'rebind-windows-runner.mjs');
  const remoteWin = c.remoteDir.replace(/\//g, '\\\\');
  await run(c.sshBin, ['-i', c.keyPath, '-o', 'BatchMode=yes', '-o', `ConnectTimeout=${c.connectTimeout}`, '-o', 'StrictHostKeyChecking=accept-new', `${c.user}@${c.host}`, `mkdir "${remoteWin}" 2>nul & echo ok`], 30000);
  const scp = await run(c.scpBin, ['-i', c.keyPath, '-o', 'BatchMode=yes', '-o', `ConnectTimeout=${c.connectTimeout}`, runnerLocal, `${c.user}@${c.host}:${c.remoteDir}/rebind-windows-runner.mjs`], 60000);
  if (scp.code !== 0) throw new Error('scp failed: ' + (scp.stderr || scp.stdout));
  const payload = Buffer.from(JSON.stringify({ origin, email, password, waitSec }), 'utf8').toString('base64');
  const remoteCmd = `cd /d ${remoteWin} && ${c.nodePath} -e "require('fs').writeFileSync('rebind-payload.json', Buffer.from(process.argv[1],'base64').toString('utf8'));" ${payload} && ${c.nodePath} -e "const p=require('fs').readFileSync('rebind-payload.json','utf8'); const {spawnSync}=require('child_process'); const r=spawnSync(process.execPath,['rebind-windows-runner.mjs', p],{encoding:'utf8'}); process.stdout.write(r.stdout||''); process.stderr.write(r.stderr||''); process.exit(r.status||0);"`;
  const result = await run(c.sshBin, ['-i', c.keyPath, '-o', 'BatchMode=yes', '-o', `ConnectTimeout=${c.connectTimeout}`, '-o', 'StrictHostKeyChecking=accept-new', `${c.user}@${c.host}`, remoteCmd], 220000);
  const body = parseMarked(result.stdout + '\n' + result.stderr, 'RESULT_START', 'RESULT_END');
  if (!body) throw new Error('windows grab no result: ' + (result.stderr || result.stdout).slice(0, 500));
  return JSON.parse(body);
}

async function vpsLogin({ origin, email, password, turnstile, revision }) {
  const body = { email, password };
  if (revision) body.login_agreement_revision = revision;
  if (turnstile) body.turnstile_token = turnstile;
  const r = await fetch(origin.replace(/\/$/, '') + '/api/v1/auth/login', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Accept: 'application/json', 'Accept-Language': 'zh', 'User-Agent': 'Mozilla/5.0' },
    body: JSON.stringify(body),
  });
  const j = await r.json().catch(() => ({}));
  return { status: r.status, code: j.code, message: j.message, reason: j.reason, accessToken: j?.data?.access_token || j?.data?.token || '', refreshToken: j?.data?.refresh_token || '' };
}
async function vpsMe(origin, token) {
  const r = await fetch(origin.replace(/\/$/, '') + '/api/v1/auth/me', {
    headers: { Authorization: 'Bearer ' + token, Accept: 'application/json', 'User-Agent': 'Mozilla/5.0' },
  });
  const j = await r.json().catch(() => ({}));
  return { status: r.status, code: j.code, message: j.message, reason: j.reason, balance: j?.data?.balance, email: j?.data?.email };
}
async function importGpf(siteId, token, email) {
  const api = 'http://127.0.0.1:5177';
  await fetch(api + `/api/sites/${siteId}/credentials`, {
    method: 'PUT', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ authMode: 'sub2api-token', accessToken: token, refreshToken: '', email }),
  });
  const loginJ = await (await fetch(api + `/api/sites/${siteId}/login`, { method: 'POST' })).json().catch(() => ({}));
  let refreshJ = null;
  try { refreshJ = await (await fetch(api + `/api/sites/${siteId}/refresh`, { method: 'POST' })).json(); }
  catch (e) { refreshJ = { error: String(e.message || e) }; }
  const site = await (await fetch(api + `/api/sites/${siteId}`)).json();
  return { login: loginJ, refresh: refreshJ, site: { authStatus: site.authStatus, authError: site.authError, balanceUsd: site.balanceUsd, lastCollectedAt: site.lastCollectedAt, gpt: site.gptCurrentRateMultiplier, gptGroup: site.gptCurrentRateGroupName } };
}

const origin = env('BASE_URL', 'https://api-provider.uling19.com');
const email = env('EMAIL');
const password = env('PASSWORD');
const siteId = Number(env('SITE_ID', '9'));
if (!email || !password) { console.log(JSON.stringify({ ok: false, error: 'EMAIL/PASSWORD required' })); process.exit(2); }

console.log(JSON.stringify({ phase: 'windows-grab-start' }));
const grabbed = await windowsGrab({ origin, email, password, waitSec: 55 });
console.log(JSON.stringify({
  phase: 'windows-grab-done',
  turnstileLen: grabbed.turnstileLen || 0,
  snap: grabbed.snap,
  windowsLogin: grabbed.windowsLogin,
  hasWinAccess: !!grabbed.accessToken,
}, null, 2));

let vpsBound = null;
if ((grabbed.turnstileLen || 0) > 20 || grabbed.turnstile) {
  vpsBound = await vpsLogin({
    origin, email, password,
    turnstile: grabbed.turnstile,
    revision: grabbed.windowsLogin?.revision,
  });
  console.log(JSON.stringify({ phase: 'vps-login-with-win-turnstile', status: vpsBound.status, code: vpsBound.code, message: vpsBound.message, reason: vpsBound.reason, hasAccess: !!vpsBound.accessToken }, null, 2));
  if (vpsBound.accessToken) {
    const me = await vpsMe(origin, vpsBound.accessToken);
    console.log(JSON.stringify({ phase: 'vps-me-rebound', ...me }, null, 2));
    if (me.code === 0) {
      const imp = await importGpf(siteId, vpsBound.accessToken, email);
      console.log(JSON.stringify({ phase: 'import-gpf', ...imp }, null, 2));
      console.log(JSON.stringify({ ok: true, mode: 'vps-rebound-token', balance: me.balance }, null, 2));
      process.exit(imp.site?.authStatus === 'valid' ? 0 : 4);
    }
  }
}

if (grabbed.accessToken) {
  const me = await vpsMe(origin, grabbed.accessToken);
  console.log(JSON.stringify({ phase: 'vps-me-windows-token', ...me }, null, 2));
  if (me.code === 0) {
    const imp = await importGpf(siteId, grabbed.accessToken, email);
    console.log(JSON.stringify({ ok: true, mode: 'windows-token-works-on-vps', import: imp }, null, 2));
    process.exit(0);
  }
}

console.log(JSON.stringify({
  ok: false,
  error: 'rebind-failed',
  grabbed: { turnstileLen: grabbed.turnstileLen, windowsLogin: grabbed.windowsLogin, snap: grabbed.snap },
  vpsBound: vpsBound && { status: vpsBound.status, code: vpsBound.code, message: vpsBound.message, reason: vpsBound.reason },
}, null, 2));
process.exit(3);
