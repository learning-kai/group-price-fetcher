import { AuthError } from "./authManager.js";
import { createExternalApiAuth } from "./apiKeyAuth.js";
import { ApiError } from "./httpClient.js";
import { listProviders } from "./providerRegistry.js";
import { redactSecrets, redactSensitiveValue } from "./security.js";

export class RouteError extends Error {
  constructor(message, status = 400) {
    super(message);
    this.name = "RouteError";
    this.status = status;
  }
}

export function createApiRouter({ repository, collector, authManager, scheduler, exportService, apiAuth = null }) {
  const externalAuth = apiAuth ?? createExternalApiAuth({
    getHash: () => repository.getExternalApiKeyHash(),
    setHash: (hash) => repository.setExternalApiKeyHash(hash)
  });
  return async function route({ method, url, body = {}, headers = {}, remoteAddress = "" }) {
    const pathname = url.pathname;
    const parts = pathname.split("/").filter(Boolean);
    const external = pathname.startsWith("/api/external/v1/") || pathname === "/api/external/v1";
    if (external) externalAuth.authorize({ remoteAddress, headers });
    else if (pathname.startsWith("/api/")) externalAuth.authorizeManagement({ remoteAddress });

    if (external && method === "GET") {
      return routeExternalApi({ pathname, parts, url, repository });
    }

    if (method === "GET" && pathname === "/api/exports/data.json") {
      return downloadResponse(await exportService.exportDataJson());
    }
    if (method === "GET" && pathname === "/api/exports/rates.csv") {
      return downloadResponse(await exportService.exportRatesCsv());
    }
    if (method === "POST" && pathname === "/api/exports/encrypted-backup") {
      try {
        return downloadResponse(await exportService.exportEncryptedBackup(body.password));
      } catch (error) {
        throw sanitizeExportError(error, body.password);
      }
    }

    if (method === "GET" && pathname === "/api/status") {
      return ok({
        scheduler: scheduler.status(),
        globalScheduleMinutes: repository.getGlobalSchedule()
      });
    }
    if (method === "GET" && pathname === "/api/providers") {
      return ok({ providers: listProviders() });
    }
    if (pathname === "/api/settings/schedule") {
      if (method === "GET") return ok({ globalScheduleMinutes: repository.getGlobalSchedule() });
      if (method === "PUT") {
        return ok({ globalScheduleMinutes: repository.setGlobalSchedule(body.minutes) });
      }
    }
    if (pathname === "/api/settings/api-key") {
      if (method === "GET") return ok({ configured: externalAuth.isConfigured() });
      if (method === "POST") return created({ apiKey: externalAuth.rotateKey() });
      if (method === "DELETE") {
        externalAuth.clearKey();
        return { status: 204, body: null };
      }
    }
    if (pathname === "/api/categories") {
      if (method === "GET") return ok({ items: repository.listCategories() });
      if (method === "POST") return created(repository.createCategory(body));
    }
    if (parts[0] === "api" && parts[1] === "categories" && parts.length === 3) {
      const id = parseId(parts[2]);
      if (method === "GET") return ok(requireEntity(repository.getCategory(id), "分类"));
      if (method === "PATCH") return ok(repository.updateCategory(id, body));
      if (method === "DELETE") {
        if (!repository.deleteCategory(id)) throw new RouteError("分类不存在", 404);
        return { status: 204, body: null };
      }
    }
    if (pathname === "/api/tags" && method === "GET") {
      return ok({ items: repository.listTags() });
    }
    if (pathname === "/api/sites") {
      if (method === "GET") {
        const result = repository.listSites(siteQuery(url.searchParams));
        return ok({
          ...result,
          items: result.items.map((site) => ({
            ...site,
            effectiveScheduleMinutes: repository.getEffectiveSchedule(site.id)
          }))
        });
      }
      if (method === "POST") return created(repository.createSite(body));
    }
    if (pathname === "/api/sites/bulk" && method === "POST") {
      if (!Array.isArray(body.sites) || body.sites.length === 0) throw new RouteError("批量站点不能为空");
      const items = [];
      const errors = [];
      for (const input of body.sites) {
        try { items.push(repository.createSite(input)); }
        catch (error) { errors.push({ input: { name: input?.name, baseUrl: input?.baseUrl }, error: error.message }); }
      }
      return { status: errors.length ? 207 : 201, body: { items, errors } };
    }
    if (parts[0] === "api" && parts[1] === "sites" && parts.length >= 3) {
      const id = parseId(parts[2]);
      const site = requireEntity(repository.getSite(id), "站点");
      if (parts.length === 3) {
        if (method === "GET") return ok({ ...site, effectiveScheduleMinutes: repository.getEffectiveSchedule(id) });
        if (method === "PATCH") return ok(repository.updateSite(id, body));
        if (method === "DELETE") {
          await authManager.clearCredentials(site);
          repository.deleteSite(id);
          return { status: 204, body: null };
        }
      }
      if (parts.length === 4 && parts[3] === "credentials") {
        if (method === "PUT") return ok(await authManager.configureCredentials(site, body));
        if (method === "DELETE") return ok(await authManager.clearCredentials(site));
      }
      if (parts.length === 4 && method === "POST" && parts[3] === "refresh") {
        const result = await collector.collectSite(site, { trigger: "manual" });
        return ok({ fetchedAt: result.fetchedAt, summary: result.summary });
      }
      if (parts.length === 4 && method === "POST" && parts[3] === "login") {
        const result = await authManager.login(site);
        const compatibility = typeof collector.probeSite === "function"
          ? await collector.probeSite(site, { token: result.token })
          : null;
        return ok({ source: result.source, compatibility });
      }
      if (parts.length === 4 && method === "POST" && parts[3] === "import-edge") {
        const result = await authManager.importFromEdge(site);
        const compatibility = typeof collector.probeSite === "function"
          ? await collector.probeSite(site, { token: result.token })
          : null;
        return ok({ source: result.source, compatibility });
      }
      if (parts.length === 4 && method === "GET" && parts[3] === "history") {
        const groupId = url.searchParams.get("groupId");
        if (!groupId) throw new RouteError("groupId 不能为空");
        return ok({ items: repository.getRateHistory(id, groupId, numberParam(url.searchParams, "limit", 200)) });
      }
      if (parts.length === 4 && method === "GET" && parts[3] === "runs") {
        return ok({ items: repository.listRuns({ siteId: id, limit: numberParam(url.searchParams, "limit", 100) }) });
      }
      if (parts.length === 4 && method === "GET" && parts[3] === "changes") {
        return ok(repository.listChanges({
          siteId: id,
          changeType: url.searchParams.get("changeType") || "",
          page: numberParam(url.searchParams, "page", 1),
          pageSize: numberParam(url.searchParams, "pageSize", 100)
        }));
      }
      if (parts.length === 6 && parts[3] === "groups" && parts[5] === "hidden") {
        const groupId = decodeURIComponent(parts[4]);
        if (method === "PUT") {
          const result = repository.hideRateGroup(id, groupId);
          if (!result) throw new RouteError("当前分组不存在", 404);
          return ok(result);
        }
        if (method === "DELETE") return ok(repository.restoreRateGroup(id, groupId));
      }
    }
    if (pathname === "/api/rates" && method === "GET") {
      return ok(repository.listLatestRates(rateQuery(url.searchParams, "visible", true)));
    }
    if (pathname === "/api/runs" && method === "GET") {
      return ok({ items: repository.listRuns({ limit: numberParam(url.searchParams, "limit", 100) }) });
    }
    if (pathname === "/api/changes" && method === "GET") {
      return ok(repository.listChanges({
        siteId: url.searchParams.get("siteId") || undefined,
        changeType: url.searchParams.get("changeType") || "",
        page: numberParam(url.searchParams, "page", 1),
        pageSize: numberParam(url.searchParams, "pageSize", 100)
      }));
    }

    if (pathname.startsWith("/api/")) throw new RouteError("API 不存在", 404);
    return null;
  };
}

function routeExternalApi({ pathname, parts, url, repository }) {
  if (pathname === "/api/external/v1") {
    return ok({ apiVersion: "1", resources: ["sites", "rates", "changes"] });
  }
  if (pathname === "/api/external/v1/sites") {
    const result = repository.listSites(siteQuery(url.searchParams));
    return ok(externalPage({ ...result, items: result.items.map(externalSite) }));
  }
  if (pathname === "/api/external/v1/rates") {
    return ok(externalPage(repository.listLatestRates(rateQuery(url.searchParams, "all"))));
  }
  if (pathname === "/api/external/v1/changes") {
    return ok(externalPage(repository.listChanges(changeQuery(url.searchParams))));
  }
  if (parts.length >= 6 && parts[0] === "api" && parts[1] === "external" && parts[2] === "v1" && parts[3] === "sites") {
    const siteId = parseId(parts[4]);
    requireEntity(repository.getSite(siteId), "站点");
    if (parts.length === 6 && parts[5] === "rates") {
      return ok(externalPage(repository.listLatestRates({ ...rateQuery(url.searchParams, "all"), siteId })));
    }
    if (parts.length === 6 && parts[5] === "changes") {
      return ok(externalPage(repository.listChanges({ ...changeQuery(url.searchParams), siteId })));
    }
    if (parts.length === 8 && parts[5] === "groups" && parts[7] === "history") {
      const items = repository.getRateHistory(siteId, decodeURIComponent(parts[6]), numberParam(url.searchParams, "limit", 200));
      return ok({ apiVersion: "1", data: items, pagination: { page: 1, pageSize: items.length, total: items.length } });
    }
  }
  throw new RouteError("外部 API 不存在", 404);
}

function externalPage(result) {
  return {
    apiVersion: "1",
    data: result.items,
    pagination: { page: result.page, pageSize: result.pageSize, total: result.total }
  };
}

function externalSite(site) {
  return {
    id: site.id,
    name: site.name,
    baseUrl: site.baseUrl,
    providerId: site.providerId,
    categoryId: site.categoryId,
    categoryName: site.categoryName,
    tags: site.tags,
    enabled: site.enabled,
    authStatus: site.authStatus,
    lastCollectedAt: site.lastCollectedAt,
    updatedAt: site.updatedAt
  };
}

export function errorResponse(error) {
  const status = error?.code === "BACKUP_PASSWORD_INVALID"
    ? 400
    : error instanceof RouteError
    ? error.status
    : error instanceof AuthError
      ? error.status
      : error instanceof ApiError && error.status
        ? error.status
        : Number.isInteger(error?.status)
          ? error.status
          : isValidationError(error)
          ? 400
          : 500;
  return {
    status,
    body: {
      error: redactSecrets(error.message || "Internal Server Error"),
      code: error.code ?? null,
      detail: redactSensitiveValue(error instanceof AuthError ? error.details : error.detail ?? null)
    }
  };
}

function siteQuery(params) {
  return {
    query: params.get("query") || "",
    categoryId: params.get("categoryId") || undefined,
    tag: params.get("tag") || "",
    authStatus: params.get("authStatus") || "",
    enabled: booleanParam(params.get("enabled")),
    sortBy: params.get("sortBy") || "name",
    sortDir: params.get("sortDir") || "asc",
    page: numberParam(params, "page", 1),
    pageSize: numberParam(params, "pageSize", 50)
  };
}

function rateQuery(params, defaultVisibility = "all", allowVisibility = false) {
  return {
    query: params.get("query") || "",
    siteId: params.get("siteId") || undefined,
    categoryId: params.get("categoryId") || undefined,
    tag: params.get("tag") || "",
    platform: params.get("platform") || "",
    status: params.get("status") || "",
    authStatus: params.get("authStatus") || "",
    visibility: allowVisibility ? params.get("visibility") || defaultVisibility : defaultVisibility,
    sortBy: params.get("sortBy") || "rate",
    sortDir: params.get("sortDir") || "asc",
    page: numberParam(params, "page", 1),
    pageSize: numberParam(params, "pageSize", 100)
  };
}

function changeQuery(params) {
  return {
    siteId: params.get("siteId") || undefined,
    changeType: params.get("changeType") || "",
    page: numberParam(params, "page", 1),
    pageSize: numberParam(params, "pageSize", 100)
  };
}

function numberParam(params, key, fallback) {
  const value = params.get(key);
  return value === null || value === "" ? fallback : Number(value);
}

function booleanParam(value) {
  if (value === null || value === "") return undefined;
  if (value === "true" || value === "1") return true;
  if (value === "false" || value === "0") return false;
  throw new RouteError("布尔查询参数无效");
}

function parseId(value) {
  const id = Number(value);
  if (!Number.isInteger(id) || id <= 0) throw new RouteError("ID 无效");
  return id;
}

function requireEntity(value, label) {
  if (!value) throw new RouteError(`${label}不存在`, 404);
  return value;
}

function ok(body) { return { status: 200, body }; }
function created(body) { return { status: 201, body }; }

function downloadResponse(artifact) {
  if (!artifact || !Buffer.isBuffer(artifact.body) || !/^[A-Za-z0-9._-]+$/.test(artifact.filename)) {
    throw new RouteError("导出文件无效", 500);
  }
  return {
    status: 200,
    body: artifact.body,
    headers: {
      "Content-Type": artifact.contentType,
      "Content-Disposition": `attachment; filename="${artifact.filename}"`,
      "Cache-Control": "no-store",
      "X-Content-Type-Options": "nosniff"
    }
  };
}

function sanitizeExportError(error, password) {
  const secret = typeof password === "string" ? password : "";
  const message = typeof error?.message === "string" ? error.message : "加密导出失败";
  const sanitized = new Error(secret ? message.split(secret).join("[REDACTED]") : message);
  if (Number.isInteger(error?.status) && error.status >= 400 && error.status <= 599) {
    sanitized.status = error.status;
  }
  if (typeof error?.code === "string" && /^[A-Z][A-Z0-9_]*$/.test(error.code)) {
    sanitized.code = error.code;
  }
  return sanitized;
}

function isValidationError(error) {
  return /不能为空|必须|不支持|已存在|禁止|无效|不存在/.test(error?.message ?? "");
}
