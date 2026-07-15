import test from "node:test";
import assert from "node:assert/strict";
import { createAuthManager, AuthError, readStorageStateFromPage } from "../src/authManager.js";

const site = { id: 7, baseUrl: "https://auth.example.com", name: "认证站" };

test("valid profile access token is reused and status contains no credential", async () => {
  const statuses = [];
  const manager = createAuthManager({
    repository: fakeRepository(statuses),
    browserAdapter: fakeBrowser({ accessToken: "valid-access", refreshToken: "refresh-value" }),
    fetchImpl: authFetch()
  });

  const resolved = await manager.getAccess(site);

  assert.deepEqual(resolved, { token: "valid-access", source: "profile:auth_token" });
  assert.equal(statuses[0].status, "valid");
  assert.equal(JSON.stringify(statuses).includes("valid-access"), false);
  assert.equal(JSON.stringify(statuses).includes("refresh-value"), false);
});

test("expired access token is refreshed once and written back to the profile", async () => {
  const writes = [];
  const manager = createAuthManager({
    repository: fakeRepository([]),
    browserAdapter: fakeBrowser(
      { accessToken: "expired-access", refreshToken: "refresh-value" },
      { writes }
    ),
    fetchImpl: authFetch({ validTokens: ["new-access"], refreshedAccess: "new-access", refreshedRefresh: "new-refresh" })
  });

  const resolved = await manager.getAccess(site);

  assert.deepEqual(resolved, { token: "new-access", source: "profile:refresh_token" });
  assert.deepEqual(writes, [{ accessToken: "new-access", refreshToken: "new-refresh" }]);
});

test("forceRefresh bypasses a valid-looking access token after provider 401", async () => {
  const writes = [];
  const manager = createAuthManager({
    repository: fakeRepository([]),
    browserAdapter: fakeBrowser(
      { accessToken: "valid-access", refreshToken: "refresh-value" },
      { writes }
    ),
    fetchImpl: authFetch({
      validTokens: ["valid-access", "forced-access"],
      refreshedAccess: "forced-access",
      refreshedRefresh: "forced-refresh"
    })
  });

  const resolved = await manager.getAccess(site, { forceRefresh: true });

  assert.deepEqual(resolved, { token: "forced-access", source: "profile:refresh_token" });
  assert.deepEqual(writes, [{ accessToken: "forced-access", refreshToken: "forced-refresh" }]);
});

test("missing profile state requires explicit interactive login", async () => {
  const statuses = [];
  const browser = fakeBrowser({}, { loginState: { accessToken: "after-login", refreshToken: "after-refresh" } });
  const manager = createAuthManager({
    repository: fakeRepository(statuses),
    browserAdapter: browser,
    fetchImpl: authFetch({ validTokens: ["after-login"] })
  });

  await assert.rejects(() => manager.getAccess(site), (error) => {
    assert.ok(error instanceof AuthError);
    assert.equal(error.code, "LOGIN_REQUIRED");
    return true;
  });
  assert.equal(browser.loginCalls, 0);

  const resolved = await manager.login(site);
  assert.equal(browser.loginCalls, 1);
  assert.deepEqual(resolved, { token: "after-login", source: "profile:interactive" });
  assert.equal(statuses.at(-1).status, "valid");
});

test("existing Edge state is validated before one-time profile import", async () => {
  const writes = [];
  const manager = createAuthManager({
    repository: fakeRepository([]),
    browserAdapter: fakeBrowser({}, { writes }),
    edgeImporter: async () => ({ token: "edge-access", refreshToken: "edge-refresh" }),
    fetchImpl: authFetch({ validTokens: ["edge-access"] })
  });

  const resolved = await manager.importFromEdge(site);

  assert.deepEqual(resolved, { token: "edge-access", source: "edge:import" });
  assert.deepEqual(writes, [{ accessToken: "edge-access", refreshToken: "edge-refresh" }]);
});

test("profile operations are serialized by one mutex", async () => {
  let active = 0;
  let maxActive = 0;
  const browserAdapter = {
    async readState() {
      active += 1;
      maxActive = Math.max(maxActive, active);
      await new Promise((resolve) => setTimeout(resolve, 20));
      active -= 1;
      return { accessToken: "valid-access", refreshToken: "" };
    },
    async writeState() {},
    async login() {},
    async close() {}
  };
  const manager = createAuthManager({
    repository: fakeRepository([]),
    browserAdapter,
    fetchImpl: authFetch()
  });

  await Promise.all([manager.getAccess(site), manager.getAccess({ ...site, id: 8 })]);

  assert.equal(maxActive, 1);
});

test("browser page closes only after localStorage evaluation resolves", async () => {
  const events = [];
  const page = {
    async evaluate() {
      events.push("evaluate:start");
      await new Promise((resolve) => setImmediate(resolve));
      events.push("evaluate:end");
      return { accessToken: "access", refreshToken: "refresh" };
    },
    async close() { events.push("close"); }
  };

  const state = await readStorageStateFromPage(page);

  assert.deepEqual(state, { accessToken: "access", refreshToken: "refresh" });
  assert.deepEqual(events, ["evaluate:start", "evaluate:end", "close"]);
});

test("public authentication mode does not access credentials or browser state", async () => {
  let browserReads = 0;
  let credentialReads = 0;
  const manager = createAuthManager({
    repository: fakeRepository([]),
    credentialStore: { async get() { credentialReads += 1; return null; } },
    browserAdapter: {
      async readState() { browserReads += 1; return {}; },
      async writeState() {}, async login() {}, async close() {}
    }
  });

  const resolved = await manager.getAccess({ ...site, authMode: "public" });

  assert.deepEqual(resolved, { token: "", headers: {}, source: "public" });
  assert.equal(browserReads, 0);
  assert.equal(credentialReads, 0);
});

test("sub2api password mode logs in and keeps returned tokens in memory", async () => {
  const calls = [];
  const statuses = [];
  const manager = createAuthManager({
    repository: fakeRepository(statuses),
    credentialStore: {
      async get(reference) {
        assert.equal(reference, "site:7");
        return { email: "user@example.com", password: "plain-secret" };
      }
    },
    browserAdapter: fakeBrowser({}),
    fetchImpl: async (url, init = {}) => {
      calls.push({ url: String(url), init });
      return jsonResponse(200, {
        code: 0,
        data: { access_token: "password-access", refresh_token: "password-refresh", expires_in: 3600 }
      });
    }
  });
  const passwordSite = { ...site, authMode: "sub2api-password", credentialConfigured: true };

  const first = await manager.getAccess(passwordSite);
  const second = await manager.getAccess(passwordSite);

  assert.deepEqual(first, { token: "password-access", headers: {}, source: "password:login" });
  assert.deepEqual(second, { token: "password-access", headers: {}, source: "password:cache" });
  assert.equal(calls.length, 1);
  assert.match(calls[0].url, /\/api\/v1\/auth\/login$/);
  assert.deepEqual(JSON.parse(calls[0].init.body), { email: "user@example.com", password: "plain-secret" });
  assert.equal(JSON.stringify(statuses).includes("plain-secret"), false);
  assert.equal(JSON.stringify(statuses).includes("password-access"), false);
});

test("sub2api force refresh uses refresh token before falling back to password", async () => {
  const calls = [];
  const manager = createAuthManager({
    repository: fakeRepository([]),
    credentialStore: { async get() { return { email: "user@example.com", password: "plain-secret" }; } },
    browserAdapter: fakeBrowser({}),
    fetchImpl: async (url) => {
      calls.push(String(url));
      if (String(url).endsWith("/api/v1/auth/login")) {
        return jsonResponse(200, { code: 0, data: { access_token: "first", refresh_token: "refresh", expires_in: 3600 } });
      }
      return jsonResponse(200, { code: 0, data: { access_token: "second", refresh_token: "refresh-2", expires_in: 3600 } });
    }
  });
  const passwordSite = { ...site, authMode: "sub2api-password", credentialConfigured: true };

  await manager.getAccess(passwordSite);
  const refreshed = await manager.getAccess(passwordSite, { forceRefresh: true });

  assert.deepEqual(refreshed, { token: "second", headers: {}, source: "password:refresh" });
  assert.deepEqual(calls.map((url) => new URL(url).pathname), ["/api/v1/auth/login", "/api/v1/auth/refresh"]);
});

test("NewAPI token mode returns raw Authorization and New-Api-User headers", async () => {
  const manager = createAuthManager({
    repository: fakeRepository([]),
    credentialStore: {
      async get() { return { accessToken: "system-access", userId: "123" }; }
    },
    browserAdapter: fakeBrowser({})
  });

  const resolved = await manager.getAccess({ ...site, authMode: "newapi-token", credentialConfigured: true });

  assert.deepEqual(resolved, {
    token: "",
    headers: { Authorization: "system-access", "New-Api-User": "123" },
    source: "newapi:token"
  });
});

test("sub2api token mode reuses a valid stored access token", async () => {
  const writes = [];
  const manager = createAuthManager({
    repository: fakeRepository([]),
    credentialStore: {
      async get(reference) {
        assert.equal(reference, "site:7");
        return { accessToken: "portable-access", refreshToken: "portable-refresh" };
      },
      async set(reference, value) { writes.push({ reference, value }); }
    },
    browserAdapter: fakeBrowser({}),
    fetchImpl: authFetch({ validTokens: ["portable-access"] })
  });

  const resolved = await manager.getAccess({ ...site, authMode: "sub2api-token" });

  assert.deepEqual(resolved, { token: "portable-access", headers: {}, source: "token:access" });
  assert.deepEqual(writes, []);
});

test("sub2api token mode refreshes an expired token and persists the rotation", async () => {
  const writes = [];
  const manager = createAuthManager({
    repository: fakeRepository([]),
    credentialStore: {
      async get() { return { accessToken: "expired", refreshToken: "refresh-1" }; },
      async set(reference, value) { writes.push({ reference, value }); }
    },
    browserAdapter: fakeBrowser({}),
    fetchImpl: authFetch({
      validTokens: ["access-2"],
      refreshedAccess: "access-2",
      refreshedRefresh: "refresh-2"
    })
  });

  const resolved = await manager.getAccess({ ...site, authMode: "sub2api-token" });

  assert.deepEqual(resolved, { token: "access-2", headers: {}, source: "token:refresh" });
  assert.deepEqual(writes, [{
    reference: "site:7",
    value: { accessToken: "access-2", refreshToken: "refresh-2" }
  }]);
});

test("credential configuration stores secrets outside repository metadata", async () => {
  const writes = [];
  const configs = [];
  const repository = {
    ...fakeRepository([]),
    setSiteAuthConfig(siteId, config) {
      configs.push({ siteId, ...config });
      return { ...site, authMode: config.authMode, credentialConfigured: true };
    },
    clearSiteAuthConfig() { return { ...site, credentialConfigured: false }; }
  };
  const manager = createAuthManager({
    repository,
    credentialStore: {
      async set(reference, credentials) { writes.push({ reference, credentials }); },
      async delete() { return true; }
    },
    browserAdapter: fakeBrowser({})
  });

  await manager.configureCredentials(site, {
    authMode: "sub2api-password",
    email: "user@example.com",
    password: "plain-secret"
  });

  assert.deepEqual(writes, [{
    reference: "site:7",
    credentials: { email: "user@example.com", password: "plain-secret" }
  }]);
  assert.deepEqual(configs, [{
    siteId: 7,
    authMode: "sub2api-password",
    username: "user@example.com",
    credentialRef: "site:7"
  }]);
  assert.equal(JSON.stringify(configs).includes("plain-secret"), false);
});

test("sub2api token credential configuration accepts an optional refresh token", async () => {
  const writes = [];
  const configs = [];
  const repository = {
    ...fakeRepository([]),
    setSiteAuthConfig(siteId, config) {
      configs.push({ siteId, ...config });
      return { ...site, authMode: config.authMode, credentialConfigured: true };
    }
  };
  const manager = createAuthManager({
    repository,
    credentialStore: {
      async set(reference, credentials) { writes.push({ reference, credentials }); },
      async delete() { return true; }
    },
    browserAdapter: fakeBrowser({})
  });

  await manager.configureCredentials(site, {
    authMode: "sub2api-token",
    accessToken: "portable-access",
    refreshToken: ""
  });

  assert.deepEqual(writes, [{
    reference: "site:7",
    credentials: { accessToken: "portable-access", refreshToken: "" }
  }]);
  assert.deepEqual(configs, [{
    siteId: 7,
    authMode: "sub2api-token",
    username: "token",
    credentialRef: "site:7"
  }]);
});

test("browser session capture returns tokens without changing site configuration", async () => {
  let configWrites = 0;
  const repository = {
    ...fakeRepository([]),
    setSiteAuthConfig() { configWrites += 1; }
  };
  const manager = createAuthManager({
    repository,
    browserAdapter: fakeBrowser({ accessToken: "edge-access", refreshToken: "edge-refresh" }),
    fetchImpl: authFetch({ validTokens: ["edge-access"] })
  });
  const edgeSite = { ...site, providerId: "sub2api", authMode: "edge-profile" };

  const captured = await manager.captureBrowserSession(edgeSite);

  assert.deepEqual(captured, { accessToken: "edge-access", refreshToken: "edge-refresh" });
  assert.equal(configWrites, 0);
});

test("browser session capture rejects unsupported providers and auth modes", async () => {
  const manager = createAuthManager({
    repository: fakeRepository([]),
    browserAdapter: fakeBrowser({ accessToken: "edge-access", refreshToken: "edge-refresh" }),
    fetchImpl: authFetch({ validTokens: ["edge-access"] })
  });

  await assert.rejects(
    () => manager.captureBrowserSession({ ...site, providerId: "newapi", authMode: "edge-profile" }),
    (error) => error instanceof AuthError && error.code === "BROWSER_SESSION_CAPTURE_UNSUPPORTED"
  );
  await assert.rejects(
    () => manager.captureBrowserSession({ ...site, providerId: "sub2api", authMode: "public" }),
    (error) => error instanceof AuthError && error.code === "BROWSER_SESSION_CAPTURE_UNSUPPORTED"
  );
});

function fakeRepository(statuses) {
  return {
    recordAuthStatus(siteId, status) {
      statuses.push({ siteId, ...status });
    }
  };
}

function fakeBrowser(initialState, options = {}) {
  let state = { ...initialState };
  return {
    loginCalls: 0,
    async readState() {
      return { ...state };
    },
    async writeState(_site, next) {
      state = { ...next };
      options.writes?.push({ ...next });
    },
    async login() {
      this.loginCalls += 1;
      state = { ...(options.loginState ?? state) };
    },
    async close() {}
  };
}

function authFetch(options = {}) {
  const validTokens = new Set(options.validTokens ?? ["valid-access"]);
  return async (url, init = {}) => {
    if (String(url).endsWith("/api/v1/auth/refresh")) {
      return jsonResponse(200, {
        code: 0,
        data: {
          access_token: options.refreshedAccess,
          refresh_token: options.refreshedRefresh,
          expires_in: 3600
        }
      });
    }
    const token = String(init.headers?.Authorization ?? "").replace(/^Bearer\s+/i, "");
    return validTokens.has(token)
      ? jsonResponse(200, { code: 0, data: { id: 1 } })
      : jsonResponse(401, { code: 401, message: "expired" });
  };
}

function jsonResponse(status, payload) {
  return {
    ok: status >= 200 && status < 300,
    status,
    async text() { return JSON.stringify(payload); }
  };
}
