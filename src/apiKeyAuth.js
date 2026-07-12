import { createHash, randomBytes, timingSafeEqual } from "node:crypto";

export function createExternalApiAuth({ getHash, setHash }) {
  if (typeof getHash !== "function" || typeof setHash !== "function") {
    throw new Error("API Key 存储接口无效");
  }

  function authorize({ remoteAddress, headers = {} }) {
    if (isLoopback(remoteAddress)) return;
    const expected = getHash();
    if (!expected) throw apiAuthError("尚未配置局域网 API Key", 403, "API_KEY_NOT_CONFIGURED");
    const token = bearerToken(headers.authorization ?? headers.Authorization);
    if (!token || !hashMatches(token, expected)) {
      throw apiAuthError("API Key 无效", 401, "API_KEY_INVALID");
    }
  }

  function authorizeManagement({ remoteAddress }) {
    if (!isLoopback(remoteAddress)) {
      throw apiAuthError("管理 API 仅允许本机访问", 403, "MANAGEMENT_LOCAL_ONLY");
    }
  }

  function rotateKey() {
    const key = randomBytes(32).toString("base64url");
    setHash(hashKey(key));
    return key;
  }

  function clearKey() {
    setHash("");
  }

  function isConfigured() {
    return Boolean(getHash());
  }

  return { authorize, authorizeManagement, rotateKey, clearKey, isConfigured };
}

export function isLoopback(address) {
  if (!address) return true;
  const value = String(address).toLowerCase();
  return value === "127.0.0.1"
    || value === "::1"
    || value === "localhost"
    || value.startsWith("127.")
    || value.startsWith("::ffff:127.");
}

function hashKey(key) {
  return createHash("sha256").update(String(key)).digest("hex");
}

function hashMatches(rawKey, expectedHex) {
  if (!/^[a-f0-9]{64}$/i.test(String(expectedHex))) return false;
  const actual = Buffer.from(hashKey(rawKey), "hex");
  const expected = Buffer.from(expectedHex, "hex");
  return actual.length === expected.length && timingSafeEqual(actual, expected);
}

function bearerToken(value) {
  const match = /^Bearer\s+(.+)$/i.exec(String(value ?? "").trim());
  return match?.[1]?.trim() ?? "";
}

function apiAuthError(message, status, code) {
  return Object.assign(new Error(message), { status, code });
}
