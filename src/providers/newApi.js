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
  let keys = null;
  let currentRates = [];
  if (authenticated) {
    const tokenPayload = await safeRequestPayload(client, {
      baseUrl,
      path: "/api/token/?p=1&size=100",
      headers
    });
    keys = normalizeNewApiTokens(tokenPayload?.data);
    currentRates = deriveNewApiCurrentRates(keys, groups);
  }
  const fetchedAt = new Date().toISOString();
  const account = authenticated
    ? await collectNewApiAccount({ baseUrl, headers, fetchedAt, client })
    : { status: "unknown", balanceUsd: null, source: "newapi:user-self", error: "", fetchedAt };
  return {
    providerId: newApiProvider.id,
    providerLabel: newApiProvider.label,
    baseUrl,
    mode: authenticated ? "authenticated" : "public",
    fetchedAt,
    groups,
    keys,
    currentRates,
    account,
    userOverrides: [],
    summary: summarizeGroups(groups, currentRates, keys ?? [])
  };
}

async function collectNewApiAccount({ baseUrl, headers, fetchedAt, client }) {
  try {
    const [userPayload, statusPayload] = await Promise.all([
      requestPayload(client, { baseUrl, path: "/api/user/self", headers }),
      requestPayload(client, { baseUrl, path: "/api/status", headers: {} })
    ]);
    const quota = Number(userPayload.data?.quota);
    const quotaPerUnit = Number(statusPayload.data?.quota_per_unit);
    if (!Number.isFinite(quota) || !Number.isFinite(quotaPerUnit) || quotaPerUnit <= 0) {
      throw new Error("余额或额度单位字段无效");
    }
    return {
      status: "known",
      balanceUsd: quota / quotaPerUnit,
      source: "newapi:user-self",
      error: "",
      fetchedAt
    };
  } catch (error) {
    return {
      status: "unavailable",
      balanceUsd: null,
      source: "newapi:user-self",
      error: String(error?.message || "余额接口不可用").slice(0, 200),
      fetchedAt
    };
  }
}

async function safeRequestPayload(client, request) {
  try {
    return await requestPayload(client, request);
  } catch {
    return null;
  }
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

function normalizeNewApiTokens(data) {
  const items = Array.isArray(data) ? data : data?.items;
  if (!Array.isArray(items)) return null;
  const active = items.filter((token) => Number(token?.status) === 1);
  const preferred = active.filter((token) => {
    const name = String(token?.name ?? "").trim();
    return name === "1111" || name === "grok";
  });
  return (preferred.length ? preferred : active).map((token) => ({
    id: token.id,
    name: String(token.name ?? ""),
    groupId: String(token.group ?? "default"),
    status: Number(token.status),
    isActive: true
  }));
}

function deriveNewApiCurrentRates(keys, groups) {
  if (!Array.isArray(keys) || keys.length === 0) return [];
  const groupsById = new Map(groups.map((group) => [String(group.groupId), group]));
  return keys.flatMap((key) => {
    const group = groupsById.get(String(key.groupId));
    if (!group) return [];
    return [{
      keyId: key.id,
      keyName: key.name,
      keyStatus: "active",
      isActive: true,
      groupId: key.groupId,
      groupName: group.groupName,
      platform: group.platform,
      baseRateMultiplier: group.baseRateMultiplier,
      userRateMultiplier: null,
      currentRateMultiplier: group.effectiveRateMultiplier,
      source: "api/token.group"
    }];
  });
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
