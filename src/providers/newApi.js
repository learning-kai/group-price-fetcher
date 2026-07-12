import { ApiError, normalizeBaseUrl } from "../httpClient.js";
import { summarizeGroups } from "./ulingGateway.js";

export const newApiProvider = {
  id: "newapi",
  label: "NewAPI",
  description: "支持公开分组和 Access Token 认证增强的 NewAPI 部署",
  defaultBaseUrl: "",
  supports: {
    publicMode: true,
    accessToken: true,
    userMode: true
  },
  probeCompatibility,
  fetchPrices
};

export async function probeCompatibility(options, client = requestNewApi) {
  const result = await fetchPrices(options, client);
  return {
    compatible: true,
    providerId: newApiProvider.id,
    groupCount: result.groups.length,
    mode: result.mode
  };
}

export async function fetchPrices(options, client = requestNewApi) {
  const baseUrl = normalizeBaseUrl(options.baseUrl);
  const headers = { ...(options.headers ?? {}) };
  const authenticated = Boolean(headers.Authorization);
  let payload;

  if (authenticated) {
    try {
      payload = await requestPayload(client, { baseUrl, path: "/api/user/self/groups", headers });
    } catch {
      payload = await requestPayload(client, { baseUrl, path: "/api/user/groups", headers });
    }
  } else {
    payload = await requestPayload(client, { baseUrl, path: "/api/user/groups", headers: {} });
  }

  const groups = normalizeNewApiGroups(payload.data);
  return {
    providerId: newApiProvider.id,
    providerLabel: newApiProvider.label,
    baseUrl,
    mode: authenticated ? "authenticated" : "public",
    fetchedAt: new Date().toISOString(),
    groups,
    keys: null,
    currentRates: [],
    userOverrides: [],
    summary: summarizeGroups(groups, [])
  };
}

async function requestPayload(client, request) {
  const payload = await client(request);
  if (!payload || typeof payload !== "object" || payload.success !== true || !payload.data || typeof payload.data !== "object") {
    throw new ApiError(payload?.message || "NewAPI 分组接口返回失败", {
      code: "NEWAPI_RESPONSE_FAILED",
      detail: payload?.message ?? null
    });
  }
  return payload;
}

async function requestNewApi({ baseUrl, path, headers = {}, fetchImpl = globalThis.fetch, timeoutMs = 30_000 }) {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), timeoutMs);
  const url = new URL(path, `${normalizeBaseUrl(baseUrl)}/`);
  try {
    const response = await fetchImpl(url, {
      headers: { Accept: "application/json", ...headers },
      signal: controller.signal
    });
    const text = await response.text();
    let payload;
    try { payload = text ? JSON.parse(text) : {}; }
    catch { payload = null; }
    if (!response.ok) {
      throw new ApiError(`NewAPI 接口请求失败：HTTP ${response.status}`, {
        status: response.status,
        code: payload?.code ?? null,
        detail: payload?.message ?? text,
        url: url.toString()
      });
    }
    if (!payload) throw new ApiError("NewAPI 接口没有返回合法 JSON", { url: url.toString() });
    return payload;
  } catch (error) {
    if (error instanceof ApiError) throw error;
    if (error?.name === "AbortError") throw new ApiError("NewAPI 请求超时", { url: url.toString() });
    throw new ApiError(error?.message || "NewAPI 请求失败", { url: url.toString() });
  } finally {
    clearTimeout(timeout);
  }
}

function normalizeNewApiGroups(data) {
  return Object.entries(data ?? {})
    .sort(([left], [right]) => left.localeCompare(right))
    .map(([name, raw]) => normalizeNewApiGroup(name, raw))
    .filter(Boolean);
}

function normalizeNewApiGroup(name, value) {
  const raw = value && typeof value === "object" ? value : {};
  const rate = Number(raw.ratio);
  if (!Number.isFinite(rate)) return null;
  return {
    groupId: String(raw.id ?? name),
    groupName: String(name),
    platform: String(raw.platform ?? "newapi"),
    status: String(raw.status ?? "active"),
    description: String(raw.desc ?? raw.description ?? ""),
    subscriptionType: String(raw.subscription_type ?? ""),
    billingType: String(raw.billing_type ?? ""),
    baseRateMultiplier: rate,
    userRateMultiplier: null,
    effectiveRateMultiplier: rate,
    rpmLimit: numericOrZero(raw.rpm_limit),
    dailyLimitUsd: null,
    weeklyLimitUsd: null,
    monthlyLimitUsd: null,
    peakRate: {
      enabled: false,
      start: "",
      end: "",
      multiplier: 1,
      effectiveMultiplier: rate
    },
    imagePricing: {
      allowImageGeneration: false,
      independentMultiplier: false,
      multiplier: rate,
      price1k: null,
      price2k: null,
      price4k: null
    },
    raw
  };
}

function numericOrZero(value) {
  const number = Number(value);
  return Number.isFinite(number) ? number : 0;
}
