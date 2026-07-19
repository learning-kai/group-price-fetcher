import { spawn, execSync } from "child_process";
import http from "http";
import path from "path";
import fs from "fs";
import { setTimeout as sleep } from "timers/promises";

let payloadRaw = "";
const arg = process.argv[2] || "rebind-payload.json";
try {
  if (String(arg).endsWith(".json")) payloadRaw = fs.readFileSync(arg, "utf8");
  else payloadRaw = String(arg || "");
} catch {}
if (!payloadRaw || payloadRaw.trim()[0] !== "{") {
  try { payloadRaw = fs.readFileSync("rebind-payload.json", "utf8"); } catch {}
}
const payload = JSON.parse(payloadRaw || "{}");
const origin = payload.origin;
const waitSec = payload.waitSec || 90;
const edge = process.env.EDGE_PATH || "C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe";
const profileDir = path.join(process.env.LOCALAPPDATA || "C:\\Users\\Lenovo\\AppData\\Local", "Temp", "gpf-edge", "rebind-profile");
const port = 9378;
fs.mkdirSync(profileDir, { recursive: true });

function getJson(url) {
  return new Promise((resolve, reject) => {
    http.get(url, (res) => {
      let data = "";
      res.on("data", (c) => data += c);
      res.on("end", () => { try { resolve(JSON.parse(data)); } catch (e) { reject(e); } });
    }).on("error", reject);
  });
}

async function cdp(wsUrl, fn) {
  return new Promise((resolve, reject) => {
    const ws = new WebSocket(wsUrl);
    let id = 0;
    const pending = new Map();
    const send = (method, params = {}) => new Promise((res, rej) => {
      const my = ++id;
      pending.set(my, { res, rej });
      ws.send(JSON.stringify({ id: my, method, params }));
    });
    const timer = setTimeout(() => { try { ws.close(); } catch {}; reject(new Error("cdp timeout")); }, Math.max(120000, waitSec * 1000 + 30000));
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

function print(obj) {
  console.log("RESULT_START");
  console.log(JSON.stringify(obj));
  console.log("RESULT_END");
}

try {
  try { execSync("taskkill /F /IM msedge.exe /T", { stdio: "ignore" }); } catch {}
  await sleep(1000);
  spawn("cmd.exe", [
    "/c", "start", "", edge,
    "--remote-debugging-port=" + port,
    "--user-data-dir=" + profileDir,
    "--no-first-run",
    "--no-default-browser-check",
    origin + "/login"
  ], { detached: true, stdio: "ignore", windowsHide: true }).unref();

  let targets = null;
  for (let i = 0; i < 80; i++) {
    await sleep(400);
    try {
      targets = await getJson("http://127.0.0.1:" + port + "/json/list");
      if (targets && targets.length) break;
    } catch {}
  }
  if (!targets || !targets.length) {
    print({ ok: false, error: "cdp not up" });
    process.exit(2);
  }
  const page = targets.find((t) => t.webSocketDebuggerUrl);

  const out = await cdp(page.webSocketDebuggerUrl, async (send) => {
    await send("Page.enable");
    await send("Runtime.enable");
    let turnstile = "";
    let snap = {};
    let revision = "";
    for (let i = 0; i < waitSec; i++) {
      const r = await send("Runtime.evaluate", {
        returnByValue: true,
        expression: "(() => {\n" +
          "  const resp = document.querySelector('input[name=\"cf-turnstile-response\"], textarea[name=\"cf-turnstile-response\"]');\n" +
          "  let t = resp && resp.value ? resp.value : '';\n" +
          "  for (const el of document.querySelectorAll('input,textarea')) {\n" +
          "    if (el.name && /turnstile|cf-/i.test(el.name) && el.value) t = el.value;\n" +
          "  }\n" +
          "  const inputs = [...document.querySelectorAll('input')];\n" +
          "  const pass = inputs.find(x => x.type === 'password');\n" +
          "  const mail = inputs.find(x => x !== pass);\n" +
          "  return {\n" +
          "    href: location.href,\n" +
          "    turnstileLen: t.length,\n" +
          "    turnstile: t,\n" +
          "    hasWidget: !!document.querySelector('.cf-turnstile,[data-sitekey],iframe[src*=\"turnstile\"],iframe[src*=\"challenges.cloudflare\"]'),\n" +
          "    iframeCount: document.querySelectorAll('iframe').length,\n" +
          "    mailDisabled: !!(mail && mail.disabled),\n" +
          "    passDisabled: !!(pass && pass.disabled),\n" +
          "    inputCount: inputs.length,\n" +
          "    body: (document.body && document.body.innerText || '').slice(0, 120)\n" +
          "  };\n" +
          "})()"
      });
      snap = (r && r.result && r.result.value) || {};
      if ((snap.turnstileLen || 0) > 20) {
        turnstile = snap.turnstile;
        break;
      }
      const auth = await send("Runtime.evaluate", {
        returnByValue: true,
        expression: "(() => {\n" +
          "  const bag = {...localStorage, ...sessionStorage};\n" +
          "  for (const k of Object.keys(bag)) {\n" +
          "    const v = bag[k];\n" +
          "    if (typeof v === 'string' && v.startsWith('eyJ') && v.length > 100) return v;\n" +
          "  }\n" +
          "  return '';\n" +
          "})()"
      });
      const authTok = (auth && auth.result && auth.result.value) || "";
      if (authTok.length > 100) {
        return {
          snap,
          turnstile: "",
          turnstileLen: 0,
          accessToken: authTok,
          refreshToken: "",
          windowsLogin: { hasAccess: true, message: "logged-in" }
        };
      }
      if (i % 10 === 0) {
        const rev = await send("Runtime.evaluate", {
          awaitPromise: true,
          returnByValue: true,
          expression: "(async()=>{try{const j=await fetch('/api/v1/settings/public').then(r=>r.json()); return j?.data?.login_agreement_revision||'';}catch{return ''}})()"
        });
        revision = (rev && rev.result && rev.result.value) || revision;
      }
      await sleep(1000);
    }
    if (!revision) {
      const rev = await send("Runtime.evaluate", {
        awaitPromise: true,
        returnByValue: true,
        expression: "(async()=>{try{const j=await fetch('/api/v1/settings/public').then(r=>r.json()); return j?.data?.login_agreement_revision||'';}catch{return ''}})()"
      });
      revision = (rev && rev.result && rev.result.value) || "";
    }
    return {
      snap,
      turnstile,
      turnstileLen: (turnstile || "").length,
      accessToken: "",
      refreshToken: "",
      windowsLogin: { revision, hasAccess: false, turnstileLen: (turnstile || "").length }
    };
  });

  print(Object.assign({ ok: true }, out));
  try { execSync("taskkill /F /IM msedge.exe /T", { stdio: "ignore" }); } catch {}
  process.exit(0);
} catch (e) {
  print({ ok: false, error: String(e.message || e) });
  try { execSync("taskkill /F /IM msedge.exe /T", { stdio: "ignore" }); } catch {}
  process.exit(1);
}
