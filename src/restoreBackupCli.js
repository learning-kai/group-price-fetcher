import net from "node:net";
import { StringDecoder } from "node:string_decoder";
import { fileURLToPath } from "node:url";
import { resolveAppPaths } from "./appPaths.js";
import { createCredentialStore } from "./credentialStore.js";
import { restoreEncryptedBackup } from "./restoreBackup.js";

const USAGE = "用法: npm run backup:restore -- <backup.gpfbackup>";

export async function runRestoreCli({
  args = process.argv.slice(2),
  stdin = process.stdin,
  stdout = process.stdout,
  stderr = process.stderr,
  env = process.env
} = {}) {
  if (args.length !== 1) throw Object.assign(new Error(USAGE), { code: "USAGE_INVALID" });
  if (!stdin.isTTY || !stdout.isTTY || !stderr.isTTY || typeof stdin.setRawMode !== "function") {
    throw Object.assign(new Error("恢复命令必须在交互式终端中运行"), { code: "TTY_REQUIRED" });
  }

  const paths = resolveAppPaths(env);
  const credentialStore = createCredentialStore({ vaultPath: paths.credentialVaultPath });
  const password = await readHiddenPassword({ stdin, output: stderr });
  const port = Number(env.PORT || 5177);
  if (!Number.isInteger(port) || port < 1 || port > 65535) {
    throw Object.assign(new Error("PORT 必须是有效端口"), { code: "PORT_INVALID" });
  }

  const result = await restoreEncryptedBackup({
    backupPath: args[0],
    password,
    paths,
    credentialStore,
    assertServiceStopped: () => assertLocalServiceStopped({ port })
  });
  stdout.write(`恢复完成：${result.siteCount} 个站点\n`);
  stdout.write(`数据库备份：${result.databaseBackupPath ?? "（原文件不存在）"}\n`);
  stdout.write(`凭据备份：${result.credentialBackupPath ?? "（原文件不存在）"}\n`);
  return result;
}

export function readHiddenPassword({ stdin = process.stdin, output = process.stderr } = {}) {
  return new Promise((resolve, reject) => {
    const wasRaw = Boolean(stdin.isRaw);
    const decoder = new StringDecoder("utf8");
    let password = "";
    let settled = false;

    const finish = (error) => {
      if (settled) return;
      settled = true;
      stdin.off("data", onData);
      let completionError = error;
      try {
        if (!wasRaw) stdin.setRawMode(false);
      } catch (cleanupError) {
        completionError ??= cleanupError;
      }
      try {
        stdin.pause();
      } catch (cleanupError) {
        completionError ??= cleanupError;
      }
      try {
        output.write("\r\x1b[2K");
      } catch (cleanupError) {
        completionError ??= cleanupError;
      }
      if (completionError) reject(completionError);
      else resolve(password);
    };

    const onData = (chunk) => {
      for (const character of decoder.write(Buffer.from(chunk))) {
        const codePoint = character.codePointAt(0);
        if (codePoint === 3) return finish(Object.assign(new Error("用户取消恢复"), { code: "USER_CANCELLED" }));
        if (codePoint === 13 || codePoint === 10) return finish();
        if (codePoint === 8 || codePoint === 127) {
          password = Array.from(password).slice(0, -1).join("");
          continue;
        }
        if (character >= " ") password += character;
      }
    };

    try {
      output.write("请输入备份密码: ");
      stdin.setRawMode(true);
      stdin.resume();
      stdin.on("data", onData);
    } catch (error) {
      finish(error);
    }
  });
}

export function assertLocalServiceStopped({ port, timeoutMs = 750, connect = net.createConnection } = {}) {
  return new Promise((resolve, reject) => {
    const socket = connect({ host: "127.0.0.1", port });
    let settled = false;
    const finish = (error) => {
      if (settled) return;
      settled = true;
      socket.destroy();
      if (error) reject(error);
      else resolve();
    };
    socket.setTimeout(timeoutMs);
    socket.once("connect", () => finish(Object.assign(
      new Error(`服务仍在 127.0.0.1:${port} 运行，请先停止服务`),
      { code: "SERVICE_RUNNING" }
    )));
    socket.once("timeout", () => finish(Object.assign(new Error("服务状态检查超时"), { code: "SERVICE_CHECK_FAILED" })));
    socket.once("error", (error) => {
      if (error?.code === "ECONNREFUSED") return finish();
      finish(Object.assign(new Error(`无法确认服务状态：${error.message}`), {
        code: "SERVICE_CHECK_FAILED",
        cause: error
      }));
    });
  });
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  runRestoreCli().catch((error) => {
    process.stderr.write(`${error.message}\n`);
    process.exitCode = 1;
  });
}
