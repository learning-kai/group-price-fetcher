import { spawn } from "node:child_process";
import { mkdir, writeFile, copyFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));

function env(name, fallback = "") {
  return String(process.env[name] ?? fallback);
}

let bundleReady = false; // reset on process restart

function defaultConfig() {
  return {
    host: env("WINDOWS_EDGE_SSH_HOST", "100.75.182.32"),
    user: env("WINDOWS_EDGE_SSH_USER", "Lenovo"),
    keyPath: env("WINDOWS_EDGE_SSH_KEY", "/etc/group-price-fetcher/windows-tailscale"),
    remoteDir: env("WINDOWS_EDGE_REMOTE_DIR", "C:/Users/Lenovo/AppData/Local/Temp/gpf-edge"),
    nodePath: env("WINDOWS_EDGE_NODE", "D:\\\\nodejs\\\\node.exe"),
    connectTimeout: Number(env("WINDOWS_EDGE_SSH_TIMEOUT", "12")) || 12
  };
}

function run(command, args, options = {}) {
  return new Promise((resolve) => {
    const child = spawn(command, args, {
      stdio: ["ignore", "pipe", "pipe"],
      env: process.env
    });
    let stdout = "";
    let stderr = "";
    const timer = setTimeout(() => {
      try { child.kill("SIGKILL"); } catch {}
    }, options.timeoutMs || 180000);
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

function parseJsonOutput(text) {
  const raw = String(text || "").trim();
  if (!raw) return null;
  // Find last JSON object in output
  const start = raw.lastIndexOf("{");
  if (start < 0) return null;
  try {
    return JSON.parse(raw.slice(start));
  } catch {
    // try first object
    try { return JSON.parse(raw); } catch { return null; }
  }
}

async function ensureRemoteBundle(cfg) {
  const localEdge = path.join(__dirname, "edgeAuth.js");
  const localHttp = path.join(__dirname, "httpClient.js");
  const localRunner = path.join(__dirname, "edge-token-runner.mjs");
  // runner is also kept next to this module
  await run(env("WINDOWS_EDGE_SSH_BIN", "/usr/bin/ssh"), [
    "-i", cfg.keyPath,
    "-o", "BatchMode=yes",
    "-o", `ConnectTimeout=${cfg.connectTimeout}`,
    "-o", "ConnectionAttempts=1",
    "-o", "StrictHostKeyChecking=accept-new",
    "-o", `UserKnownHostsFile=${process.env.HOME || "/var/lib/group-price-fetcher"}/.ssh/known_hosts`,
    `${cfg.user}@${cfg.host}`,
    `mkdir "${cfg.remoteDir.replace(/\//g, "\\\\")}" 2>nul & echo ok`
  ], { timeoutMs: 30000 });

  for (const [local, name] of [
    [localEdge, "edgeAuth.js"],
    [localHttp, "httpClient.js"],
    [localRunner, "edge-token-runner.mjs"]
  ]) {
    const remote = `${cfg.user}@${cfg.host}:${cfg.remoteDir}/${name}`;
    const result = await run(env("WINDOWS_EDGE_SCP_BIN", "/usr/bin/scp"), [
      "-i", cfg.keyPath,
      "-o", "BatchMode=yes",
      "-o", `ConnectTimeout=${cfg.connectTimeout}`,
    "-o", "ConnectionAttempts=1",
      local,
      remote
    ], { timeoutMs: 60000 });
    if (result.code !== 0) {
      throw new Error(`scp ${name} failed: ${result.stderr || result.stdout}`);
    }
  }
}

export async function extractEdgeTokenViaWindows({
  baseUrl,
  openEdge = true,
  pollSeconds = 90,
  printTokens = true
} = {}) {
  const cfg = defaultConfig();
  if (!cfg.host || !cfg.user || !cfg.keyPath) {
    return { ok: false, error: "Windows Edge SSH 未配置" };
  }
  try {
    // Always sync scripts so Edge open/runner fixes reach Windows quickly.
    await ensureRemoteBundle(cfg);
    bundleReady = true;
  } catch (error) {
    return { ok: false, error: `同步 Windows 提取脚本失败: ${error.message || error}` };
  }

  const remoteDirWin = cfg.remoteDir.replace(/\//g, "\\");
  const args = [
    "--url", String(baseUrl || ""),
  ];
  if (openEdge) args.push("--open");
  if (printTokens) args.push("--print-tokens");
  if (pollSeconds > 0) {
    args.push("--poll-seconds", String(pollSeconds));
    args.push("--poll-interval-ms", "3000");
  }
  const remoteCmd = `cd /d ${remoteDirWin} && ${cfg.nodePath} edge-token-runner.mjs ${args.map((a) => `"${String(a).replace(/"/g, '\\"')}"`).join(" ")}`;
  const result = await run(env("WINDOWS_EDGE_SSH_BIN", "/usr/bin/ssh"), [
    "-i", cfg.keyPath,
    "-o", "BatchMode=yes",
    "-o", `ConnectTimeout=${cfg.connectTimeout}`,
    "-o", "ConnectionAttempts=1",
    "-o", "StrictHostKeyChecking=accept-new",
    "-o", `UserKnownHostsFile=${process.env.HOME || "/var/lib/group-price-fetcher"}/.ssh/known_hosts`,
    `${cfg.user}@${cfg.host}`,
    remoteCmd
  ], { timeoutMs: Math.max(120000, (pollSeconds + 60) * 1000) });

  const parsed = parseJsonOutput(result.stdout) || parseJsonOutput(result.stderr);
  if (!parsed) {
    return {
      ok: false,
      error: `Windows Edge 提取无输出 (code=${result.code})`,
      stderr: (result.stderr || "").slice(0, 500),
      stdout: (result.stdout || "").slice(0, 500)
    };
  }
  if (!parsed.ok) {
    return {
      ok: false,
      error: parsed.error || "未取到有效登录态",
      diagnostics: parsed.diagnostics || null,
      edgeOpened: parsed.edgeOpened || openEdge
    };
  }
  return {
    ok: true,
    accessToken: parsed.accessToken,
    refreshToken: parsed.refreshToken || "",
    source: parsed.source,
    profile: parsed.profile,
    origin: parsed.origin,
    tokenPreview: parsed.tokenPreview,
    edgeOpened: parsed.edgeOpened || openEdge
  };
}

export function windowsEdgeBridgeConfigured() {
  const cfg = defaultConfig();
  return Boolean(cfg.host && cfg.user && cfg.keyPath);
}
