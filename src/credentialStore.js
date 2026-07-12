import { spawn } from "node:child_process";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";

export function createCredentialStore({ vaultPath, protector = createDpapiProtector() }) {
  if (!vaultPath) throw new Error("凭据库路径不能为空");
  if (!protector?.protect || !protector?.unprotect) throw new Error("凭据保护器无效");
  const mutex = createMutex();

  async function get(reference) {
    validateReference(reference);
    return mutex(async () => {
      const vault = await readVault();
      return vault[reference] ? structuredClone(vault[reference]) : null;
    });
  }

  async function has(reference) {
    return (await get(reference)) !== null;
  }

  async function set(reference, credentials) {
    validateReference(reference);
    validateCredentials(credentials);
    return mutex(async () => {
      const vault = await readVault();
      vault[reference] = structuredClone(credentials);
      await writeVault(vault);
      return true;
    });
  }

  async function remove(reference) {
    validateReference(reference);
    return mutex(async () => {
      const vault = await readVault();
      if (!Object.hasOwn(vault, reference)) return false;
      delete vault[reference];
      await writeVault(vault);
      return true;
    });
  }

  async function exportAll() {
    return mutex(async () => structuredClone(await readVault()));
  }

  async function replaceAll(entries) {
    validateVaultEntries(entries);
    return mutex(async () => {
      await writeVault(structuredClone(entries));
      return true;
    });
  }

  async function readVault() {
    let cipherText;
    try {
      cipherText = await readFile(vaultPath, "utf8");
    } catch (error) {
      if (error?.code === "ENOENT") return {};
      throw error;
    }
    if (!cipherText.trim()) return {};
    const plainText = await protector.unprotect(cipherText.trim());
    const parsed = JSON.parse(plainText);
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
      throw new Error("凭据库内容无效");
    }
    return parsed;
  }

  async function writeVault(vault) {
    await mkdir(path.dirname(vaultPath), { recursive: true });
    const cipherText = await protector.protect(JSON.stringify(vault));
    await writeFile(vaultPath, cipherText, { encoding: "utf8", mode: 0o600 });
  }

  return { get, has, set, delete: remove, exportAll, replaceAll };
}

export function createDpapiProtector({ run = runPowerShell } = {}) {
  if (process.platform !== "win32") {
    throw new Error("Windows DPAPI 凭据保护仅支持 Windows");
  }
  return {
    async protect(plainText) {
      return run(dpapiScript("Protect"), Buffer.from(String(plainText), "utf8").toString("base64"));
    },
    async unprotect(cipherText) {
      const plainBase64 = await run(dpapiScript("Unprotect"), String(cipherText));
      return Buffer.from(plainBase64, "base64").toString("utf8");
    }
  };
}

function dpapiScript(operation) {
  return [
    "$ErrorActionPreference = 'Stop'",
    "Add-Type -AssemblyName System.Security.Cryptography.ProtectedData",
    "$inputValue = [Console]::In.ReadToEnd().Trim()",
    "$bytes = [Convert]::FromBase64String($inputValue)",
    `$result = [Security.Cryptography.ProtectedData]::${operation}($bytes, $null, [Security.Cryptography.DataProtectionScope]::CurrentUser)`,
    "[Console]::Out.Write([Convert]::ToBase64String($result))"
  ].join("; ");
}

async function runPowerShell(script, input) {
  const candidates = ["pwsh.exe", "powershell.exe"];
  let lastError;
  for (const executable of candidates) {
    try {
      return await spawnWithInput(executable, ["-NoProfile", "-NonInteractive", "-Command", script], input);
    } catch (error) {
      lastError = error;
      if (error?.code !== "ENOENT") throw error;
    }
  }
  throw lastError ?? new Error("未找到 PowerShell");
}

function spawnWithInput(executable, args, input) {
  return new Promise((resolve, reject) => {
    const child = spawn(executable, args, { windowsHide: true, stdio: ["pipe", "pipe", "pipe"] });
    const stdout = [];
    const stderr = [];
    child.stdout.on("data", (chunk) => stdout.push(chunk));
    child.stderr.on("data", (chunk) => stderr.push(chunk));
    child.once("error", reject);
    child.once("close", (code) => {
      if (code === 0) return resolve(Buffer.concat(stdout).toString("utf8").trim());
      const message = Buffer.concat(stderr).toString("utf8").trim();
      reject(Object.assign(new Error(`DPAPI 操作失败${message ? `：${message}` : ""}`), { code: "DPAPI_FAILED" }));
    });
    child.stdin.end(input);
  });
}

function validateReference(reference) {
  if (!/^site:\d+$/.test(String(reference))) throw new Error("凭据引用无效");
}

function validateCredentials(credentials) {
  if (!credentials || typeof credentials !== "object" || Array.isArray(credentials)) {
    throw new Error("凭据必须是对象");
  }
  if (Object.keys(credentials).length === 0) throw new Error("凭据不能为空");
  for (const value of Object.values(credentials)) {
    if (typeof value !== "string") throw new Error("凭据字段必须是字符串");
  }
}

function validateVaultEntries(entries) {
  if (!entries || typeof entries !== "object" || Array.isArray(entries)) {
    throw new Error("凭据库内容无效");
  }
  for (const [reference, credentials] of Object.entries(entries)) {
    validateReference(reference);
    validateCredentials(credentials);
  }
}

function createMutex() {
  let tail = Promise.resolve();
  return async (action) => {
    const previous = tail;
    let release;
    tail = new Promise((resolve) => { release = resolve; });
    await previous;
    try { return await action(); }
    finally { release(); }
  };
}
