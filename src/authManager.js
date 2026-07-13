import { mkdir, open, readFile, rm } from "node:fs/promises";
import path from "node:path";
import { normalizeBaseUrl } from "./httpClient.js";
import { findEdgeExecutable, resolveEdgeToken } from "./edgeAuth.js";

export class AuthError extends Error {
  constructor(message, options = {}) {
    super(message);
    this.name = "AuthError";
    this.code = options.code ?? "AUTH_FAILED";
    this.status = options.status ?? 401;
    this.details = options.details ?? null;
  }
}

export function createAuthManager({
  repository,
  browserAdapter,
  credentialStore = null,
  edgeImporter = resolveEdgeToken,
  fetchImpl = globalThis.fetch
}) {
  if (!repository) throw new Error("AuthManager 缺少 repository");
  if (!browserAdapter) throw new Error("AuthManager 缺少 browserAdapter");
  const mutex = createMutex();
  const passwordSessions = new Map();

  async function getAccess(site, options = {}) {
    return mutex(async () => {
      const authMode = site.authMode ?? "edge-profile";
      if (authMode === "public") {
        repository.recordAuthStatus(site.id, { status: "valid", source: "public", error: "" });
        return { token: "", headers: {}, source: "public" };
      }
      if (authMode === "sub2api-password") {
        return getPasswordAccess(site, options);
      }
      if (authMode === "sub2api-token") {
        return getStoredTokenAccess(site, options);
      }
      if (authMode === "newapi-token") {
        const credentials = await requireCredentials(site);
        if (!credentials.accessToken || !credentials.userId) {
          throw loginRequired(site, "NewAPI Access Token 或用户 ID 缺失");
        }
        repository.recordAuthStatus(site.id, { status: "valid", source: "newapi:token", error: "" });
        return {
          token: "",
          headers: {
            Authorization: credentials.accessToken,
            "New-Api-User": credentials.userId
          },
          source: "newapi:token"
        };
      }
      if (authMode !== "edge-profile") {
        throw new AuthError(`不支持的认证方式：${authMode}`, { code: "AUTH_MODE_UNSUPPORTED", status: 400 });
      }
      const state = await browserAdapter.readState(site);
      if (!options.forceRefresh && state.accessToken && (await validateToken(site.baseUrl, state.accessToken, fetchImpl)).ok) {
        repository.recordAuthStatus(site.id, { status: "valid", source: "profile:auth_token", error: "" });
        return { token: state.accessToken, source: "profile:auth_token" };
      }

      if (state.refreshToken) {
        const refreshed = await refreshToken(site.baseUrl, state.refreshToken, fetchImpl);
        if (refreshed?.accessToken) {
          await browserAdapter.writeState(site, refreshed);
          repository.recordAuthStatus(site.id, { status: "valid", source: "profile:refresh_token", error: "" });
          return { token: refreshed.accessToken, source: "profile:refresh_token" };
        }
      }

      repository.recordAuthStatus(site.id, {
        status: "login_required",
        source: "profile",
        error: "登录态缺失或已经过期"
      });
      throw new AuthError("需要重新登录", { code: "LOGIN_REQUIRED" });
    });
  }

  async function login(site) {
    if (site.authMode === "sub2api-token") {
      return getAccess(site);
    }
    if ((site.authMode ?? "edge-profile") !== "edge-profile") {
      return getAccess(site, { forceRefresh: true });
    }
    return mutex(async () => {
      await browserAdapter.login(site);
      const state = await browserAdapter.readState(site);
      const validation = state.accessToken
        ? await validateToken(site.baseUrl, state.accessToken, fetchImpl)
        : { ok: false };
      if (!validation.ok) {
        repository.recordAuthStatus(site.id, {
          status: "login_required",
          source: "profile:interactive",
          error: "登录窗口关闭后仍未检测到有效登录态"
        });
        throw new AuthError("登录未完成或登录态无效", { code: "LOGIN_INCOMPLETE" });
      }
      repository.recordAuthStatus(site.id, { status: "valid", source: "profile:interactive", error: "" });
      return { token: state.accessToken, source: "profile:interactive" };
    });
  }

  async function importFromEdge(site) {
    return mutex(async () => {
      const imported = await edgeImporter(site.baseUrl, {
        allowRefresh: false,
        openEdgeOnFailure: false
      });
      const validation = imported?.token
        ? await validateToken(site.baseUrl, imported.token, fetchImpl)
        : { ok: false };
      if (!validation.ok) {
        repository.recordAuthStatus(site.id, {
          status: "login_required",
          source: "edge:import",
          error: "现有 Edge 登录态验证失败"
        });
        throw new AuthError("现有 Edge 登录态无效，无法导入", { code: "EDGE_IMPORT_INVALID" });
      }
      await browserAdapter.writeState(site, {
        accessToken: imported.token,
        refreshToken: imported.refreshToken ?? ""
      });
      repository.recordAuthStatus(site.id, { status: "valid", source: "edge:import", error: "" });
      return { token: imported.token, source: "edge:import" };
    });
  }

  async function captureBrowserSession(site) {
    if (site.providerId !== "sub2api" || (site.authMode ?? "edge-profile") !== "edge-profile") {
      throw new AuthError("仅支持从 sub2api 的 Edge Profile 提取登录态", {
        code: "BROWSER_SESSION_CAPTURE_UNSUPPORTED",
        status: 400
      });
    }
    const access = await getAccess(site);
    const state = await browserAdapter.readState(site);
    return {
      accessToken: access.token,
      refreshToken: state.refreshToken ?? ""
    };
  }

  async function configureCredentials(site, input) {
    if (!credentialStore) throw new AuthError("凭据库未配置", { code: "CREDENTIAL_STORE_MISSING", status: 500 });
    const reference = `site:${site.id}`;
    const authMode = String(input?.authMode ?? site.authMode ?? "");
    let credentials;
    let username;
    if (authMode === "sub2api-password") {
      const email = requiredCredential(input.email, "邮箱");
      const password = requiredCredential(input.password, "密码");
      credentials = { email, password };
      username = email;
    } else if (authMode === "newapi-token") {
      const accessToken = requiredCredential(input.accessToken, "Access Token");
      const userId = requiredCredential(input.userId, "用户 ID");
      credentials = { accessToken, userId };
      username = `user:${userId}`;
    } else if (authMode === "sub2api-token") {
      const accessToken = requiredCredential(input.accessToken, "Access Token");
      const refreshToken = String(input.refreshToken ?? "").trim();
      credentials = { accessToken, refreshToken };
      username = "token";
    } else {
      throw new AuthError("该认证方式不接受凭据", { code: "AUTH_MODE_HAS_NO_CREDENTIALS", status: 400 });
    }

    await credentialStore.set(reference, credentials);
    passwordSessions.delete(site.id);
    try {
      return repository.setSiteAuthConfig(site.id, { authMode, username, credentialRef: reference });
    } catch (error) {
      await credentialStore.delete(reference).catch(() => {});
      throw error;
    }
  }

  async function clearCredentials(site) {
    if (!credentialStore) throw new AuthError("凭据库未配置", { code: "CREDENTIAL_STORE_MISSING", status: 500 });
    passwordSessions.delete(site.id);
    await credentialStore.delete(`site:${site.id}`);
    return repository.clearSiteAuthConfig(site.id);
  }

  async function getPasswordAccess(site, options) {
    const current = passwordSessions.get(site.id);
    if (current && !options.forceRefresh) {
      repository.recordAuthStatus(site.id, { status: "valid", source: "password:cache", error: "" });
      return { token: current.accessToken, headers: {}, source: "password:cache" };
    }
    if (current?.refreshToken && options.forceRefresh) {
      const refreshed = await refreshToken(site.baseUrl, current.refreshToken, fetchImpl);
      if (refreshed?.accessToken) {
        passwordSessions.set(site.id, refreshed);
        repository.recordAuthStatus(site.id, { status: "valid", source: "password:refresh", error: "" });
        return { token: refreshed.accessToken, headers: {}, source: "password:refresh" };
      }
    }

    const credentials = await requireCredentials(site);
    if (!credentials.email || !credentials.password) {
      throw loginRequired(site, "sub2api 邮箱或密码缺失");
    }
    const session = await loginWithPassword(site.baseUrl, credentials, fetchImpl);
    passwordSessions.set(site.id, session);
    repository.recordAuthStatus(site.id, { status: "valid", source: "password:login", error: "" });
    return { token: session.accessToken, headers: {}, source: "password:login" };
  }

  async function getStoredTokenAccess(site, options) {
    const credentials = await requireCredentials(site);
    if (!options.forceRefresh && credentials.accessToken
      && (await validateToken(site.baseUrl, credentials.accessToken, fetchImpl)).ok) {
      repository.recordAuthStatus(site.id, { status: "valid", source: "token:access", error: "" });
      return { token: credentials.accessToken, headers: {}, source: "token:access" };
    }
    if (credentials.refreshToken) {
      const refreshed = await refreshToken(site.baseUrl, credentials.refreshToken, fetchImpl);
      if (refreshed?.accessToken) {
        await credentialStore.set(`site:${site.id}`, refreshed);
        repository.recordAuthStatus(site.id, { status: "valid", source: "token:refresh", error: "" });
        return { token: refreshed.accessToken, headers: {}, source: "token:refresh" };
      }
    }
    throw loginRequired(site, "sub2api Token 已过期，需要从 Windows 重新提取");
  }

  async function requireCredentials(site) {
    if (!credentialStore) throw loginRequired(site, "凭据库未配置");
    const credentials = await credentialStore.get(`site:${site.id}`);
    if (!credentials) throw loginRequired(site, "尚未配置登录凭据");
    return credentials;
  }

  function loginRequired(site, message) {
    repository.recordAuthStatus(site.id, { status: "login_required", source: site.authMode ?? "", error: message });
    return new AuthError(message, { code: "LOGIN_REQUIRED" });
  }

  return {
    getAccess,
    login,
    importFromEdge,
    captureBrowserSession,
    configureCredentials,
    clearCredentials,
    close: () => mutex(async () => {
      passwordSessions.clear();
      await browserAdapter.close();
    })
  };
}

export function createPlaywrightEdgeAdapter({
  profileDir,
  edgeExecutable = findEdgeExecutable(),
  navigationTimeoutMs = 20_000,
  loginTimeoutMs = 120_000
}) {
  if (!profileDir) throw new Error("专用浏览器 Profile 目录不能为空");
  if (!edgeExecutable) throw new Error("未找到 Microsoft Edge 可执行文件");
  let context = null;
  let lockHandle = null;
  const lockPath = path.join(profileDir, ".collector.lock");

  async function launch(headless) {
    if (context) return context;
    await mkdir(profileDir, { recursive: true });
    lockHandle = await acquireProfileLock(lockPath);
    try {
      const { chromium } = await import("playwright-core");
      context = await chromium.launchPersistentContext(profileDir, {
        executablePath: edgeExecutable,
        headless,
        viewport: { width: 1360, height: 860 },
        args: ["--no-first-run", "--disable-features=msEdgeFirstRunExperience"]
      });
      context.setDefaultNavigationTimeout(navigationTimeoutMs);
      return context;
    } catch (error) {
      await releaseLock();
      if (error?.code === "ERR_MODULE_NOT_FOUND") {
        throw new AuthError("缺少 playwright-core，请先运行 npm install", { code: "PLAYWRIGHT_MISSING", status: 500 });
      }
      throw error;
    }
  }

  async function readState(site) {
    const activeContext = await launch(true);
    const page = await activeContext.newPage();
    await navigateToOrigin(page, site.baseUrl);
    return readStorageStateFromPage(page);
  }

  async function writeState(site, state) {
    const activeContext = await launch(true);
    const page = await activeContext.newPage();
    try {
      await navigateToOrigin(page, site.baseUrl);
      await page.evaluate(({ accessToken, refreshToken }) => {
        if (accessToken) localStorage.setItem("auth_token", accessToken);
        else localStorage.removeItem("auth_token");
        if (refreshToken) localStorage.setItem("refresh_token", refreshToken);
        else localStorage.removeItem("refresh_token");
      }, state);
    } finally {
      await page.close();
    }
  }

  async function login(site) {
    await close();
    const activeContext = await launch(false);
    const page = activeContext.pages()[0] ?? await activeContext.newPage();
    await page.goto(new URL("/keys", normalizeBaseUrl(site.baseUrl)).toString(), { waitUntil: "domcontentloaded" });
    try {
      await page.waitForFunction(() => Boolean(localStorage.getItem("auth_token")), null, { timeout: loginTimeoutMs });
    } catch (error) {
      if (error?.name === "TimeoutError") {
        throw new AuthError("等待登录超时", { code: "LOGIN_TIMEOUT" });
      }
      throw error;
    } finally {
      await close();
    }
  }

  async function close() {
    if (context) {
      const closing = context;
      context = null;
      await closing.close();
    }
    await releaseLock();
  }

  async function releaseLock() {
    if (lockHandle) {
      await lockHandle.close().catch(() => {});
      lockHandle = null;
    }
    await rm(lockPath, { force: true }).catch(() => {});
  }

  return { readState, writeState, login, close };
}

export async function readStorageStateFromPage(page) {
  try {
    return await page.evaluate(() => ({
      accessToken: localStorage.getItem("auth_token") || "",
      refreshToken: localStorage.getItem("refresh_token") || ""
    }));
  } finally {
    await page.close();
  }
}

async function validateToken(baseUrl, token, fetchImpl) {
  try {
    const response = await fetchImpl(new URL("/api/v1/auth/me", normalizeBaseUrl(baseUrl)), {
      headers: { Authorization: `Bearer ${token}`, Accept: "application/json" }
    });
    const payload = await safeJson(response);
    return { ok: response.ok && payload?.code === 0, status: response.status };
  } catch (error) {
    return { ok: false, error: error.message };
  }
}

async function refreshToken(baseUrl, token, fetchImpl) {
  try {
    const response = await fetchImpl(new URL("/api/v1/auth/refresh", normalizeBaseUrl(baseUrl)), {
      method: "POST",
      headers: { "Content-Type": "application/json", Accept: "application/json" },
      body: JSON.stringify({ refresh_token: token })
    });
    const payload = await safeJson(response);
    if (!response.ok || payload?.code !== 0 || !payload?.data?.access_token) return null;
    return {
      accessToken: payload.data.access_token,
      refreshToken: payload.data.refresh_token || token
    };
  } catch {
    return null;
  }
}

async function loginWithPassword(baseUrl, credentials, fetchImpl) {
  let response;
  try {
    response = await fetchImpl(new URL("/api/v1/auth/login", normalizeBaseUrl(baseUrl)), {
      method: "POST",
      headers: { "Content-Type": "application/json", Accept: "application/json" },
      body: JSON.stringify({ email: credentials.email, password: credentials.password })
    });
  } catch {
    throw new AuthError("sub2api 登录请求失败", { code: "LOGIN_REQUEST_FAILED", status: 502 });
  }
  const payload = await safeJson(response);
  if (!response.ok || payload?.code !== 0 || !payload?.data?.access_token) {
    throw new AuthError("sub2api 账号或密码错误", { code: "LOGIN_REJECTED", status: 401 });
  }
  return {
    accessToken: payload.data.access_token,
    refreshToken: payload.data.refresh_token ?? ""
  };
}

async function navigateToOrigin(page, baseUrl) {
  const target = new URL("/keys", normalizeBaseUrl(baseUrl)).toString();
  try {
    await page.goto(target, { waitUntil: "domcontentloaded" });
  } catch (error) {
    if (!page.url().startsWith(new URL(baseUrl).origin)) throw error;
  }
}

async function safeJson(response) {
  const text = await response.text();
  try { return JSON.parse(text); } catch { return null; }
}

function createMutex() {
  let tail = Promise.resolve();
  return async (action) => {
    const previous = tail;
    let release;
    tail = new Promise((resolve) => { release = resolve; });
    await previous;
    try {
      return await action();
    } finally {
      release();
    }
  };
}

function requiredCredential(value, label) {
  const text = String(value ?? "").trim();
  if (!text) throw new AuthError(`${label}不能为空`, { code: "CREDENTIAL_INVALID", status: 400 });
  return text;
}

async function acquireProfileLock(lockPath) {
  try {
    const handle = await open(lockPath, "wx");
    await handle.writeFile(JSON.stringify({ pid: process.pid, createdAt: new Date().toISOString() }));
    return handle;
  } catch (error) {
    if (error?.code !== "EEXIST") throw error;
    const details = await readFile(lockPath, "utf8").catch(() => "");
    throw new AuthError(`专用浏览器 Profile 正被其他进程使用${details ? `：${details}` : ""}`, {
      code: "PROFILE_LOCKED",
      status: 409
    });
  }
}
