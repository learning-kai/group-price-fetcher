import { spawn } from "node:child_process";
import { writeFile, mkdir } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));

function env(name, fallback = "") {
  return String(process.env[name] ?? fallback);
}

function defaultConfig() {
  return {
    host: env("WINDOWS_EDGE_SSH_HOST", "100.75.182.32"),
    user: env("WINDOWS_EDGE_SSH_USER", "Lenovo"),
    keyPath: env("WINDOWS_EDGE_SSH_KEY", "/etc/group-price-fetcher/windows-tailscale"),
    remoteDir: env("WINDOWS_EDGE_REMOTE_DIR", "C:/Users/Lenovo/AppData/Local/Temp/gpf-edge"),
    nodePath: env("WINDOWS_EDGE_NODE", "D:\\\\nodejs\\\\node.exe"),
    sshBin: env("WINDOWS_EDGE_SSH_BIN", "/usr/bin/ssh"),
    scpBin: env("WINDOWS_EDGE_SCP_BIN", "/usr/bin/scp"),
    connectTimeout: Number(env("WINDOWS_EDGE_SSH_TIMEOUT", "12")) || 12,
  };
}

function run(command, args, options = {}) {
  return new Promise((resolve) => {
    const child = spawn(command, args, {
      stdio: ["ignore", "pipe", "pipe"],
      env: process.env,
    });
    let stdout = "";
    let stderr = "";
    const timer = setTimeout(() => {
      try { child.kill("SIGKILL"); } catch {}
    }, options.timeoutMs || 120000);
    child.stdout.on("data", (chunk) => { stdout += chunk.toString("utf8"); });
    child.stderr.on("data", (chunk) => { stderr += chunk.toString("utf8"); });
    child.on("close", (code) => {
      clearTimeout(timer);
      resolve({ code: code ?? 1, stdout, stderr });
    });
    child.on("error", (error) => {
      clearTimeout(timer);
      resolve({ code: 1, stdout, stderr: String(error.message || error) });
    });
  });
}

function parseMarkedJson(text) {
  const raw = String(text || "");
  const start = raw.indexOf("RESULT_START");
  if (start < 0) return null;
  const after = raw.slice(start + "RESULT_START".length);
  const end = after.indexOf("RESULT_END");
  const body = (end >= 0 ? after.slice(0, end) : after).trim();
  if (!body) return null;
  try { return JSON.parse(body); } catch { return null; }
}

const runnerSource = `const payload = JSON.parse(process.argv[2] || "{}");
const { url, method = "GET", headers = {}, body = null, timeoutMs = 30000 } = payload;
const controller = new AbortController();
const timer = setTimeout(() => controller.abort(), timeoutMs);
try {
  const init = {
    method,
    headers,
    signal: controller.signal
  };
  if (body != null) {
    init.body = typeof body === "string" ? body : JSON.stringify(body);
  }
  const response = await fetch(url, init);
  const text = await response.text();
  let json = null;
  try { json = JSON.parse(text); } catch {}
  console.log("RESULT_START");
  console.log(JSON.stringify({
    ok: response.ok,
    status: response.status,
    headers: Object.fromEntries(response.headers.entries()),
    text,
    json
  }));
  console.log("RESULT_END");
  process.exit(0);
} catch (error) {
  console.log("RESULT_START");
  console.log(JSON.stringify({ ok: false, status: 0, error: String(error.message || error) }));
  console.log("RESULT_END");
  process.exit(2);
} finally {
  clearTimeout(timer);
}
`;

// Edge browser-context fetch (TLS/browser fingerprint). Needed for sub2api session binding.
const browserRunnerSource = `import { spawn, execSync } from "child_process";
import fs from "fs";
import path from "path";
import http from "http";
import { setTimeout as sleep } from "timers/promises";

const payload = JSON.parse(process.argv[2] || "{}");
const { url, method = "GET", headers = {}, body = null, timeoutMs = 45000 } = payload;
const target = new URL(url);
const origin = target.origin;
const edge = process.env.EDGE_PATH || "C:\\\\Program Files (x86)\\\\Microsoft\\\\Edge\\\\Application\\\\msedge.exe";
const profileDir = path.join(process.env.LOCALAPPDATA || "C:\\\\Users\\\\Lenovo\\\\AppData\\\\Local", "Temp", "gpf-edge", "edge-profile-bridge");
const port = 9341;
fs.mkdirSync(profileDir, { recursive: true });

function getJson(u) {
  return new Promise((resolve, reject) => {
    http.get(u, (res) => {
      let data = "";
      res.on("data", (c) => data += c);
      res.on("end", () => { try { resolve(JSON.parse(data)); } catch (e) { reject(e); } });
    }).on("error", reject);
  });
}

async function cdpSession(wsUrl, fn) {
  return new Promise((resolve, reject) => {
    const ws = new WebSocket(wsUrl);
    let id = 0;
    const pending = new Map();
    const send = (m, params = {}) => new Promise((res, rej) => {
      const my = ++id;
      pending.set(my, { res, rej });
      ws.send(JSON.stringify({ id: my, method: m, params }));
    });
    const timer = setTimeout(() => { try { ws.close(); } catch {}; reject(new Error("browser session timeout")); }, Math.max(90000, timeoutMs + 30000));
    ws.addEventListener("open", async () => {
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
    ws.addEventListener("message", (ev) => {
      const msg = JSON.parse(typeof ev.data === "string" ? ev.data : Buffer.from(ev.data).toString());
      if (msg.id && pending.has(msg.id)) {
        const { res, rej } = pending.get(msg.id);
        pending.delete(msg.id);
        if (msg.error) rej(new Error(JSON.stringify(msg.error)));
        else res(msg.result);
      }
    });
    ws.addEventListener("error", (e) => { clearTimeout(timer); reject(e.error || e); });
  });
}

function printResult(obj) {
  console.log("RESULT_START");
  console.log(JSON.stringify(obj));
  console.log("RESULT_END");
}

try {
  // Keep a dedicated profile; do not kill user Edge if possible, but dedicated profile is isolated.
  const child = spawn(edge, [
    \`--remote-debugging-port=\${port}\`,
    \`--user-data-dir=\${profileDir}\`,
    "--no-first-run",
    "--no-default-browser-check",
    "--disable-popup-blocking",
    origin + "/"
  ], { detached: true, stdio: "ignore", windowsHide: true });
  child.unref();

  let targets = null;
  for (let i = 0; i < 80; i++) {
    await sleep(400);
    try {
      targets = await getJson(\`http://127.0.0.1:\${port}/json/list\`);
      if (targets?.length) break;
    } catch {}
  }
  if (!targets?.length) {
    printResult({ ok: false, status: 0, error: "edge cdp not up" });
    process.exit(2);
  }
  const page = targets.find((t) => t.type === "page" && t.webSocketDebuggerUrl) || targets.find((t) => t.webSocketDebuggerUrl);
  if (!page?.webSocketDebuggerUrl) {
    printResult({ ok: false, status: 0, error: "no cdp page" });
    process.exit(2);
  }

  const out = await cdpSession(page.webSocketDebuggerUrl, async (send) => {
    await send("Page.enable");
    await send("Runtime.enable");
    await sleep(800);
    // Ensure we are on same origin for cookie/storage context
    const href = await send("Runtime.evaluate", { returnByValue: true, expression: "location.origin" });
    if (href?.result?.value !== origin) {
      await send("Page.navigate", { url: origin + "/" });
      await sleep(1500);
    }
    // If Authorization bearer present, also seed common token keys (helps some sites).
    const auth = headers.Authorization || headers.authorization || "";
    const m = String(auth).match(/^Bearer\\s+(.+)$/i);
    if (m) {
      const tok = m[1];
      await send("Runtime.evaluate", {
        expression: \`(() => {
          const t = \${JSON.stringify(tok)};
          try { localStorage.setItem("auth_token", t); } catch {}
          try { localStorage.setItem("access_token", t); } catch {}
          try { sessionStorage.setItem("auth_token", t); } catch {}
          return true;
        })()\`
      });
    }
    const result = await send("Runtime.evaluate", {
      awaitPromise: true,
      returnByValue: true,
      expression: \`(async () => {
        const controller = new AbortController();
        const timer = setTimeout(() => controller.abort(), \${Number(timeoutMs) || 45000});
        try {
          const init = {
            method: \${JSON.stringify(method)},
            headers: \${JSON.stringify(headers || {})},
            signal: controller.signal,
          };
          const body = \${JSON.stringify(body)};
          if (body != null) init.body = typeof body === "string" ? body : JSON.stringify(body);
          const response = await fetch(\${JSON.stringify(url)}, init);
          const text = await response.text();
          let json = null;
          try { json = JSON.parse(text); } catch {}
          return {
            ok: response.ok,
            status: response.status,
            headers: {},
            text,
            json
          };
        } catch (error) {
          return { ok: false, status: 0, error: String(error && error.message || error) };
        } finally {
          clearTimeout(timer);
        }
      })()\`
    });
    return result?.result?.value || { ok: false, status: 0, error: "empty browser result" };
  });
  printResult(out);
  process.exit(out && out.status ? 0 : (out?.ok ? 0 : 2));
} catch (error) {
  printResult({ ok: false, status: 0, error: String(error.message || error) });
  process.exit(2);
}
`;

async function ensureRunner(cfg) {
  const localDir = process.env.GROUP_PRICE_FETCHER_HOME
    || process.env.HOME
    || "/var/lib/group-price-fetcher";
  await mkdir(localDir, { recursive: true });
  const localRunner = path.join(localDir, "windows-fetch-runner.mjs");
  const localBrowserRunner = path.join(localDir, "windows-browser-fetch-runner.mjs");
  await writeFile(localRunner, runnerSource, "utf8");
  await writeFile(localBrowserRunner, browserRunnerSource, "utf8");
  const remoteDirWin = cfg.remoteDir.replace(/\//g, "\\\\");
  await run(cfg.sshBin, [
    "-i", cfg.keyPath,
    "-o", "BatchMode=yes",
    "-o", `ConnectTimeout=${cfg.connectTimeout}`,
    "-o", "StrictHostKeyChecking=accept-new",
    `${cfg.user}@${cfg.host}`,
    `mkdir "${remoteDirWin}" 2>nul & echo ok`,
  ], { timeoutMs: 30000 });
  for (const [local, name] of [
    [localRunner, "windows-fetch-runner.mjs"],
    [localBrowserRunner, "windows-browser-fetch-runner.mjs"],
  ]) {
    const remote = `${cfg.user}@${cfg.host}:${cfg.remoteDir}/${name}`;
    const result = await run(cfg.scpBin, [
      "-i", cfg.keyPath,
      "-o", "BatchMode=yes",
      "-o", `ConnectTimeout=${cfg.connectTimeout}`,
      local,
      remote,
    ], { timeoutMs: 60000 });
    if (result.code !== 0) {
      throw new Error(`scp ${name} failed: ${result.stderr || result.stdout}`);
    }
  }
}

export function windowsHttpBridgeConfigured() {
  const cfg = defaultConfig();
  return Boolean(cfg.host && cfg.user && cfg.keyPath);
}

async function windowsRunPayload(runnerFile, payload, timeoutMs) {
  const cfg = defaultConfig();
  await ensureRunner(cfg);
  const b64 = Buffer.from(JSON.stringify(payload), "utf8").toString("base64");
  const remoteDirWin = cfg.remoteDir.replace(/\//g, "\\\\");
  const remoteCmd = (
    `cd /d ${remoteDirWin} && ` +
    `${cfg.nodePath} -e "require('fs').writeFileSync('payload.json', Buffer.from(process.argv[1],'base64').toString('utf8'));" ${b64} && ` +
    `${cfg.nodePath} -e "const p=require('fs').readFileSync('payload.json','utf8'); const {spawnSync}=require('child_process'); const r=spawnSync(process.execPath,['${runnerFile}', p],{encoding:'utf8'}); process.stdout.write(r.stdout||''); process.stderr.write(r.stderr||''); process.exit(r.status||0);"`
  );
  const result = await run(cfg.sshBin, [
    "-i", cfg.keyPath,
    "-o", "BatchMode=yes",
    "-o", `ConnectTimeout=${cfg.connectTimeout}`,
    "-o", "StrictHostKeyChecking=accept-new",
    `${cfg.user}@${cfg.host}`,
    remoteCmd,
  ], { timeoutMs: Math.max(90000, timeoutMs + 45000) });
  const parsed = parseMarkedJson(result.stdout) || parseMarkedJson(result.stderr);
  if (!parsed) {
    throw new Error(`Windows fetch 无输出 (code=${result.code}): ${(result.stderr || result.stdout || "").slice(0, 400)}`);
  }
  if (parsed.error && !parsed.status) {
    throw new Error(parsed.error);
  }
  return parsed;
}

export async function windowsFetch(url, { method = "GET", headers = {}, body = null, timeoutMs = 30000 } = {}) {
  if (!windowsHttpBridgeConfigured()) {
    throw new Error("Windows HTTP bridge 未配置");
  }
  return windowsRunPayload("windows-fetch-runner.mjs", {
    url: String(url),
    method,
    headers,
    body,
    timeoutMs,
  }, timeoutMs);
}

export async function windowsBrowserFetch(url, { method = "GET", headers = {}, body = null, timeoutMs = 45000 } = {}) {
  if (!windowsHttpBridgeConfigured()) {
    throw new Error("Windows HTTP bridge 未配置");
  }
  return windowsRunPayload("windows-browser-fetch-runner.mjs", {
    url: String(url),
    method,
    headers,
    body,
    timeoutMs,
  }, timeoutMs);
}

function isBindingMismatch(result) {
  const msg = String(result?.json?.message || result?.json?.reason || result?.text || "");
  const code = result?.json?.code;
  return (
    result?.status === 401 &&
    (code === "SESSION_BINDING_MISMATCH" ||
      /SESSION_BINDING_MISMATCH|fingerprint changed|session network fingerprint/i.test(msg))
  );
}

export async function windowsValidateBearer(baseUrl, accessToken) {
  const origin = String(baseUrl || "").replace(/\/+$/, "");
  const headers = {
    Authorization: `Bearer ${accessToken}`,
    Accept: "application/json",
    "Accept-Language": "zh",
    "User-Agent": "Mozilla/5.0",
  };
  // Prefer browser-context first for session-binding sub2api hosts.
  // Node TLS fingerprint is rejected even from the same Windows IP.
  let result;
  try {
    result = await windowsBrowserFetch(`${origin}/api/v1/auth/me`, {
      method: "GET",
      headers,
      timeoutMs: 45000,
    });
  } catch (browserError) {
    // Fallback to node fetch on Windows.
    result = await windowsFetch(`${origin}/api/v1/auth/me`, {
      method: "GET",
      headers,
      timeoutMs: 20000,
    });
    if (isBindingMismatch(result)) {
      throw browserError;
    }
  }
  if (isBindingMismatch(result)) {
    // one more browser attempt if first path somehow returned node-like mismatch
    result = await windowsBrowserFetch(`${origin}/api/v1/auth/me`, {
      method: "GET",
      headers,
      timeoutMs: 45000,
    });
  }
  const ok = Boolean(result.ok && result.json && result.json.code === 0);
  return {
    ok,
    status: result.status,
    code: result.json?.code || null,
    message: result.json?.message || null,
    data: result.json?.data || null,
  };
}

export function createWindowsFetchImpl() {
  return async function windowsFetchImpl(input, init = {}) {
    const url = input instanceof URL ? input.toString() : String(input?.url || input);
    const method = init.method || "GET";
    const headers = { ...(init.headers || {}) };
    const plainHeaders = {};
    if (headers && typeof headers.forEach === "function") {
      headers.forEach((v, k) => { plainHeaders[k] = v; });
    } else {
      Object.assign(plainHeaders, headers || {});
    }
    let body = init.body ?? null;
    if (body && typeof body !== "string") {
      try { body = JSON.stringify(body); } catch { body = String(body); }
    }
    // Authenticated requests: browser context first (session binding).
    const hasAuth = Boolean(plainHeaders.Authorization || plainHeaders.authorization);
    if (hasAuth) {
      try {
        const browser = await windowsBrowserFetch(url, {
          method,
          headers: plainHeaders,
          body,
          timeoutMs: 45000,
        });
        return new Response(browser.text || "", {
          status: browser.status || 0,
          headers: browser.headers || {},
        });
      } catch {
        // fall through to node windows fetch
      }
    }
    const result = await windowsFetch(url, {
      method,
      headers: plainHeaders,
      body,
      timeoutMs: 30000,
    });
    if (hasAuth && isBindingMismatch(result)) {
      const browser = await windowsBrowserFetch(url, {
        method,
        headers: plainHeaders,
        body,
        timeoutMs: 45000,
      });
      return new Response(browser.text || "", {
        status: browser.status || 0,
        headers: browser.headers || {},
      });
    }
    return new Response(result.text || "", {
      status: result.status || 0,
      headers: result.headers || {},
    });
  };
}
