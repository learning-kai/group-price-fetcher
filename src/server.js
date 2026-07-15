import http from "node:http";
import { readFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { fetch as undiciFetch, ProxyAgent } from "undici";
import { resolveAppPaths } from "./appPaths.js";
import { createAuthManager, createPlaywrightEdgeAdapter } from "./authManager.js";
import { createCredentialStore } from "./credentialStore.js";
import { fetchBatchPrices } from "./batch.js";
import { createCollector } from "./collector.js";
import { resolveEdgeToken } from "./edgeAuth.js";
import { createExportService } from "./exportService.js";
import { getProvider } from "./providerRegistry.js";
import { createNotificationService } from "./notificationService.js";
import { createApiRouter, errorResponse } from "./routes.js";
import { createScheduler } from "./scheduler.js";
import { redactSecrets } from "./security.js";
import { createSiteTransferService } from "./siteTransferService.js";
import { createRepository } from "./storage.js";
import { createTaskQueue } from "./taskQueue.js";
import { createSelectiveProxyFetch } from "./httpClient.js";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const rootDir = path.resolve(__dirname, "..");
const publicDir = path.join(rootDir, "public");
const port = Number(process.env.PORT || 5177);
const host = process.env.HOST || "127.0.0.1";
const nativeFetch = globalThis.fetch;
globalThis.fetch = createSelectiveProxyFetch({
  fetchImpl: nativeFetch,
  proxyFetchImpl: undiciFetch,
  proxyUrl: process.env.SELECTIVE_PROXY_URL || process.env.HTTPS_PROXY || process.env.HTTP_PROXY || "",
  proxyHosts: process.env.SELECTIVE_PROXY_HOSTS || "",
  proxyAgentFactory: (proxyUrl) => new ProxyAgent(proxyUrl)
});

const mimeTypes = new Map([
  [".html", "text/html; charset=utf-8"],
  [".css", "text/css; charset=utf-8"],
  [".js", "application/javascript; charset=utf-8"],
  [".json", "application/json; charset=utf-8"],
  [".svg", "image/svg+xml"],
  [".png", "image/png"]
]);

export function createDefaultServices(options = {}) {
  const paths = options.paths ?? resolveAppPaths();
  const repository = createRepository({ dbPath: paths.dbPath });
  const credentialStore = createCredentialStore({ vaultPath: paths.credentialVaultPath });
  const browserAdapter = createBrowserAdapter({ profileDir: paths.profileDir });
  const authManager = createAuthManager({ repository, browserAdapter, credentialStore });
  const exportService = createExportService({
    repository,
    credentialStore,
    dbPath: paths.dbPath
  });
  const siteTransferService = createSiteTransferService({ repository, credentialStore, authManager });
  const notificationService = createNotificationService({
    repository,
    credentialStore,
    onError: (error) => console.error(redactSecrets(`[notification] ${error.message}`))
  });
  const queue = createTaskQueue({
    concurrency: Number(process.env.COLLECTOR_CONCURRENCY || 5),
    timeoutMs: Number(process.env.COLLECTOR_TIMEOUT_MS || 90_000)
  });
  const collector = createCollector({ repository, authManager, getProvider, queue, notificationService });
  const scheduler = createScheduler({
    repository,
    credentialStore,
    collector,
    onError: (error, site) => console.error(redactSecrets(`[scheduler] ${site?.name ?? "tick"}: ${error.message}`))
  });
  return {
    paths,
    browserAuthSupported: process.platform === "win32",
    repository,
    authManager,
    exportService,
    siteTransferService,
    notificationService,
    queue,
    collector,
    scheduler,
    async close() {
      scheduler.stop();
      await notificationService.close();
      await authManager.close();
      repository.close();
    }
  };
}

export function createBrowserAdapter({ profileDir, platform = process.platform }) {
  if (platform === "win32") return createPlaywrightEdgeAdapter({ profileDir });
  return {
    async readState() { throw browserAuthUnavailable(); },
    async writeState() { throw browserAuthUnavailable(); },
    async login() { throw browserAuthUnavailable(); },
    async close() {}
  };
}

function browserAuthUnavailable() {
  return Object.assign(new Error("浏览器登录、Edge Profile 导入和登录态提取仅支持 Windows；Linux 请使用公开模式、Token 或邮箱密码认证"), {
    code: "BROWSER_AUTH_UNAVAILABLE",
    status: 501
  });
}

export function createServer(services = createDefaultServices()) {
  const routeApi = createApiRouter(services);
  return http.createServer(async (req, res) => {
    try {
      const requestUrl = new URL(req.url, `http://${host}`);
      if (req.method === "GET" && requestUrl.pathname === "/health") {
        return sendJson(res, { ok: true, scheduler: services.scheduler.status() });
      }

      if (req.method === "POST" && requestUrl.pathname === "/api/price-groups") {
        const body = await readJsonBody(req);
        return sendJson(res, await legacyPriceGroups(body));
      }

      const body = ["POST", "PUT", "PATCH"].includes(req.method) ? await readJsonBody(req) : {};
      const routed = await routeApi({
        method: req.method,
        url: requestUrl,
        body,
        headers: req.headers,
        remoteAddress: req.socket.remoteAddress
      });
      if (routed) {
        if (Buffer.isBuffer(routed.body)) return sendBuffer(res, routed.body, routed.status, routed.headers);
        return sendJson(res, routed.body, routed.status, routed.headers);
      }

      if (req.method !== "GET") return sendJson(res, { error: "Method Not Allowed" }, 405);
      return serveStatic(requestUrl, res);
    } catch (error) {
      const response = errorResponse(error);
      return sendJson(res, response.body, response.status);
    }
  });
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  const services = createDefaultServices();
  const server = createServer(services);
  server.listen(port, host, async () => {
    console.log(`Group price fetcher running at http://${host}:${port}`);
    await services.scheduler.start();
  });
  const shutdown = async () => {
    server.close();
    await services.close();
    process.exit(0);
  };
  process.once("SIGINT", shutdown);
  process.once("SIGTERM", shutdown);
}

async function legacyPriceGroups(body) {
  const provider = getProvider(body.providerId);
  const commonOptions = {
    token: body.token,
    mode: body.mode || "user",
    includeKeys: Boolean(body.includeKeys),
    includeUserOverrides: Boolean(body.includeUserOverrides),
    resolveToken: body.useEdgeAuth === false
      ? null
      : async (baseUrl) => resolveEdgeToken(baseUrl, {
        allowRefresh: true,
        openEdgeOnFailure: true,
        edgeWaitMs: 90_000,
        edgePollMs: 2_000
      })
  };
  if (Array.isArray(body.targets) && body.targets.length > 0) {
    return fetchBatchPrices({ provider, targets: body.targets, options: commonOptions });
  }
  const token = body.token || (commonOptions.resolveToken
    ? (await commonOptions.resolveToken(body.baseUrl || provider.defaultBaseUrl)).token
    : "");
  return provider.fetchPrices({
    baseUrl: body.baseUrl || provider.defaultBaseUrl,
    ...commonOptions,
    token
  });
}

async function serveStatic(requestUrl, res) {
  const relativePath = requestUrl.pathname === "/" ? "index.html" : decodeURIComponent(requestUrl.pathname.slice(1));
  const safePath = path.normalize(relativePath).replace(/^(\.\.(\/|\\|$))+/, "");
  const filePath = path.join(publicDir, safePath);
  if (!filePath.startsWith(publicDir)) return sendJson(res, { error: "Forbidden" }, 403);
  try {
    const file = await readFile(filePath);
    res.writeHead(200, {
      "Content-Type": mimeTypes.get(path.extname(filePath)) || "application/octet-stream",
      "Cache-Control": "no-store"
    });
    res.end(file);
  } catch {
    sendJson(res, { error: "Not Found" }, 404);
  }
}

function sendJson(res, payload, status = 200, headers = {}) {
  if (status === 204) {
    res.writeHead(204, headers);
    return res.end();
  }
  const text = JSON.stringify(payload);
  res.writeHead(status, {
    "Content-Type": "application/json; charset=utf-8",
    "Content-Length": Buffer.byteLength(text),
    ...headers
  });
  res.end(text);
}

function sendBuffer(res, payload, status = 200, headers = {}) {
  res.writeHead(status, {
    ...headers,
    "Content-Length": payload.length
  });
  res.end(payload);
}

async function readJsonBody(req) {
  const chunks = [];
  let size = 0;
  for await (const chunk of req) {
    size += chunk.length;
    if (size > 1024 * 1024) throw Object.assign(new Error("请求体过大"), { status: 413 });
    chunks.push(chunk);
  }
  const raw = Buffer.concat(chunks).toString("utf8");
  if (!raw) return {};
  try { return JSON.parse(raw); }
  catch { throw Object.assign(new Error("请求体不是合法 JSON"), { status: 400 }); }
}
