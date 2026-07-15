const DEFAULT_TIMEOUT_MS = 30_000;

export class ApiError extends Error {
  constructor(message, options = {}) {
    super(message);
    this.name = "ApiError";
    this.status = options.status ?? null;
    this.code = options.code ?? null;
    this.detail = options.detail ?? null;
    this.url = options.url ?? null;
    this.retryAfterMs = options.retryAfterMs ?? null;
  }
}

export function normalizeBaseUrl(input) {
  if (!input || typeof input !== "string") {
    throw new ApiError("Base URL 不能为空");
  }

  const parsed = new URL(input.trim());
  if (!["http:", "https:"].includes(parsed.protocol)) {
    throw new ApiError("Base URL 只支持 http 或 https");
  }

  parsed.hash = "";
  parsed.search = "";
  return parsed.toString().replace(/\/+$/, "");
}

export function buildApiUrl(baseUrl, path, query = {}) {
  const normalizedBase = normalizeBaseUrl(baseUrl);
  const apiBase = normalizedBase.endsWith("/api/v1")
    ? normalizedBase
    : `${normalizedBase}/api/v1`;
  const cleanPath = path.startsWith("/") ? path : `/${path}`;
  const url = new URL(`${apiBase}${cleanPath}`);

  for (const [key, value] of Object.entries(query ?? {})) {
    if (value === undefined || value === null || value === "") continue;
    url.searchParams.set(key, String(value));
  }

  return url;
}

export function createSelectiveProxyFetch({
  fetchImpl = globalThis.fetch,
  proxyFetchImpl = fetchImpl,
  proxyUrl = "",
  proxyHosts = "",
  proxyAgentFactory
} = {}) {
  if (typeof fetchImpl !== "function") {
    throw new ApiError("当前 Node 运行时不支持 fetch，请升级 Node 18+");
  }

  const hosts = new Set(
    (Array.isArray(proxyHosts) ? proxyHosts : String(proxyHosts).split(","))
      .map((host) => String(host).trim().toLowerCase())
      .filter(Boolean)
  );
  const normalizedProxyUrl = String(proxyUrl).trim();
  let dispatcher;

  return async function selectiveProxyFetch(input, init = {}) {
    const rawUrl = input instanceof URL ? input : input?.url ?? input;
    const hostname = new URL(rawUrl).hostname.toLowerCase();
    if (!normalizedProxyUrl || !hosts.has(hostname)) {
      return fetchImpl(input, init);
    }
    if (typeof proxyAgentFactory !== "function") {
      throw new ApiError("已配置单站代理，但缺少代理客户端");
    }
    if (typeof proxyFetchImpl !== "function") {
      throw new ApiError("已配置单站代理，但缺少代理请求客户端");
    }
    dispatcher ??= proxyAgentFactory(normalizedProxyUrl);
    return proxyFetchImpl(input, { ...init, dispatcher });
  };
}

export async function apiFetch({
  baseUrl,
  path,
  token,
  query,
  method = "GET",
  body,
  timeoutMs = DEFAULT_TIMEOUT_MS,
  fetchImpl = globalThis.fetch
}) {
  if (typeof fetchImpl !== "function") {
    throw new ApiError("当前 Node 运行时不支持 fetch，请升级 Node 18+");
  }

  const upperMethod = method.toUpperCase();
  const nextQuery = upperMethod === "GET"
    ? { timezone: Intl.DateTimeFormat().resolvedOptions().timeZone || "UTC", ...query }
    : query;
  const url = buildApiUrl(baseUrl, path, nextQuery);
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), timeoutMs);

  try {
    const headers = {
      "Accept": "application/json",
      "Accept-Language": "zh"
    };

    if (token) {
      headers.Authorization = token.trim().startsWith("Bearer ")
        ? token.trim()
        : `Bearer ${token.trim()}`;
    }

    const init = {
      method: upperMethod,
      headers,
      signal: controller.signal
    };

    if (body !== undefined) {
      headers["Content-Type"] = "application/json";
      init.body = JSON.stringify(body);
    }

    const response = await fetchImpl(url, init);
    const rawText = await response.text();
    const payload = parseJson(rawText);

    if (!response.ok) {
      throw new ApiError(statusMessage(response.status), {
        status: response.status,
        code: payload?.code,
        detail: payload?.message ?? payload?.detail ?? rawText,
        url: url.toString(),
        retryAfterMs: parseRetryAfter(response.headers?.get?.("retry-after"))
      });
    }

    if (payload && typeof payload === "object" && "code" in payload) {
      if (payload.code === 0) return payload.data;
      throw new ApiError(payload.message || payload.detail || "接口返回失败", {
        status: response.status,
        code: payload.code,
        detail: payload.detail,
        url: url.toString()
      });
    }

    return payload;
  } catch (error) {
    if (error instanceof ApiError) throw error;
    if (error?.name === "AbortError") {
      throw new ApiError("请求超时", { url: url.toString() });
    }
    throw new ApiError(error?.message || "请求失败", { url: url.toString() });
  } finally {
    clearTimeout(timeout);
  }
}

function parseJson(text) {
  if (!text) return null;
  try {
    return JSON.parse(text);
  } catch {
    return text;
  }
}

function statusMessage(status) {
  if (status === 401) return "未授权：Token 无效、过期，或没有登录";
  if (status === 403) return "权限不足：当前账号不能访问该接口";
  if (status === 404) return "接口不存在：请检查 Base URL 或适配器";
  return `接口请求失败：HTTP ${status}`;
}

function parseRetryAfter(value) {
  if (!value) return null;
  const seconds = Number(value);
  if (Number.isFinite(seconds) && seconds >= 0) return seconds * 1000;
  const date = new Date(value);
  return Number.isNaN(date.getTime()) ? null : Math.max(0, date.getTime() - Date.now());
}
