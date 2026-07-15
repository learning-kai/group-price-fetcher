import { apiFetch } from "../httpClient.js";

export const ulingGatewayProvider = {
  id: "uling-gateway",
  label: "Uling19 / AI API Gateway",
  description: "兼容 Uling19 小站和同类 AI API Gateway 部署",
  defaultBaseUrl: "https://api-provider.uling19.com",
  supports: {
    userMode: true,
    adminMode: true,
    userOverrides: true
  },
  probeCompatibility,
  fetchPrices
};

export async function probeCompatibility(options, client = apiFetch) {
  const { baseUrl, token } = options;
  await client({ baseUrl, token, path: "/auth/me" });
  const groups = await client({ baseUrl, token, path: "/groups/available" });
  const normalized = normalizeGroups(groups);
  return {
    compatible: true,
    providerId: ulingGatewayProvider.id,
    groupCount: normalized.length
  };
}

export async function fetchPrices(options, client = apiFetch) {
  const {
    baseUrl = ulingGatewayProvider.defaultBaseUrl,
    token,
    mode = "user",
    includeKeys = false,
    includeUserOverrides = false
  } = options;

  const isAdmin = mode === "admin";
  const groups = isAdmin
    ? await client({ baseUrl, token, path: "/admin/groups/all", query: { include_inactive: true } })
    : await client({ baseUrl, token, path: "/groups/available" });

  const userRates = isAdmin
    ? {}
    : await safeClient(client, { baseUrl, token, path: "/groups/rates" }, {});

  const keysPayload = await safeClient(
    client,
    { baseUrl, token, path: "/keys", query: { page: 1, page_size: 100 } },
    null
  );

  const normalizedGroups = normalizeGroups(groups).map((group) => (
    normalizeGroupRate(group, userRates)
  ));
  const normalizedKeys = normalizeKeys(keysPayload);
  const selectedKeys = selectCurrentRateKeys(normalizedKeys);
  const currentRates = deriveCurrentRates(selectedKeys, normalizedGroups, userRates);
  const fetchedAt = new Date().toISOString();
  const account = await collectSub2ApiAccount({ baseUrl, token, fetchedAt, client });

  let overrides = [];
  if (isAdmin && includeUserOverrides) {
    overrides = await collectAdminOverrides({ baseUrl, token, groups: normalizedGroups, client });
  }

  return {
    providerId: ulingGatewayProvider.id,
    providerLabel: ulingGatewayProvider.label,
    baseUrl,
    mode,
    fetchedAt,
    groups: normalizedGroups,
    keys: includeKeys ? normalizedKeys : null,
    currentRates,
    account,
    userOverrides: overrides,
    summary: summarizeGroups(normalizedGroups, currentRates, selectedKeys)
  };
}

export function normalizeGroupRate(group, userRates = {}) {
  const groupId = group.id ?? group.group_id ?? group.value ?? group.name;
  const rateFromMap = getUserRate(userRates, groupId);
  const baseRate = numberOrDefault(group.rate_multiplier, 1);
  const effectiveRate = numberOrDefault(rateFromMap, baseRate);
  const peakMultiplier = numberOrDefault(group.peak_rate_multiplier, 1);
  const peakEnabled = Boolean(group.peak_rate_enabled);

  return {
    groupId,
    groupName: String(group.name ?? group.label ?? `group-${groupId}`),
    platform: group.platform ?? "",
    status: group.status ?? "",
    description: group.description ?? "",
    subscriptionType: group.subscription_type ?? group.subscriptionType ?? "",
    billingType: group.billing_type ?? group.billingType ?? "",
    baseRateMultiplier: baseRate,
    userRateMultiplier: rateFromMap === undefined ? null : numberOrDefault(rateFromMap, baseRate),
    effectiveRateMultiplier: effectiveRate,
    rpmLimit: numberOrDefault(group.rpm_limit, 0),
    isExclusive: Boolean(group.is_exclusive),
    dailyLimitUsd: nullableNumber(group.daily_limit_usd),
    weeklyLimitUsd: nullableNumber(group.weekly_limit_usd),
    monthlyLimitUsd: nullableNumber(group.monthly_limit_usd),
    peakRate: {
      enabled: peakEnabled,
      start: group.peak_start ?? "",
      end: group.peak_end ?? "",
      multiplier: peakMultiplier,
      effectiveMultiplier: peakEnabled ? roundNumber(effectiveRate * peakMultiplier) : effectiveRate
    },
    imagePricing: {
      allowImageGeneration: Boolean(group.allow_image_generation),
      independentMultiplier: Boolean(group.image_rate_independent),
      multiplier: numberOrDefault(group.image_rate_multiplier, effectiveRate),
      price1k: nullableNumber(group.image_price_1k),
      price2k: nullableNumber(group.image_price_2k),
      price4k: nullableNumber(group.image_price_4k)
    },
    raw: group
  };
}

export function summarizeGroups(groups, currentRates = [], selectedKeys = []) {
  const count = groups.length;
  const activeCount = groups.filter((group) => !group.status || group.status === "active").length;
  const rates = groups.map((group) => group.effectiveRateMultiplier).filter(Number.isFinite);
  const activeCurrentRates = currentRates
    .filter((rate) => rate.isActive)
    .map((rate) => rate.currentRateMultiplier)
    .filter(Number.isFinite);
  const uniqueCurrentRates = [...new Set(activeCurrentRates)];
  const primaryCurrentRate = uniqueCurrentRates.length === 1 ? uniqueCurrentRates[0] : null;
  const minRate = rates.length ? Math.min(...rates) : null;
  const maxRate = rates.length ? Math.max(...rates) : null;
  const avgRate = rates.length
    ? roundNumber(rates.reduce((sum, rate) => sum + rate, 0) / rates.length)
    : null;
  const currentRatesByFamily = summarizeCurrentRatesByFamily(groups, currentRates, selectedKeys);
  const gptIdentity = currentRatesByFamily.gpt;
  const legacyCurrentRate = gptIdentity.currentRateMultiplier ?? primaryCurrentRate;

  return {
    count,
    activeCount,
    inactiveCount: count - activeCount,
    minRate,
    maxRate,
    avgRate,
    currentRateMultiplier: legacyCurrentRate,
    currentRateCount: gptIdentity.currentRateCount || currentRates.length,
    currentRateKeyName: gptIdentity.currentRateKeyName
      ?? (selectedKeys.length === 1 ? selectedKeys[0].name || null : null),
    currentMinRate: activeCurrentRates.length ? Math.min(...activeCurrentRates) : null,
    currentMaxRate: activeCurrentRates.length ? Math.max(...activeCurrentRates) : null,
    currentRateAmbiguous: gptIdentity.currentRateAmbiguous || uniqueCurrentRates.length > 1,
    currentRatesByFamily,
    platforms: [...new Set(groups.map((group) => group.platform).filter(Boolean))].sort()
  };
}

export function summarizeCurrentRatesByFamily(groups = [], currentRates = [], selectedKeys = []) {
  const activeRates = currentRates.filter((rate) => rate.isActive !== false);

  const gptIdentityRates = selectIdentityRates(activeRates, selectedKeys, "1111");
  const grokIdentityRates = selectIdentityRates(activeRates, selectedKeys, "grok");

  return {
    gpt: summarizeIdentityRates(gptIdentityRates, {
      keyName: gptIdentityRates.length ? "1111" : null
    }),
    grok: summarizeIdentityRates(grokIdentityRates, {
      keyName: grokIdentityRates.length ? "grok" : null,
      groupName: grokIdentityRates.length === 1
        ? (grokIdentityRates[0].groupName || null)
        : null
    })
  };
}

function selectIdentityRates(activeRates, selectedKeys, preferredName) {
  const exact = activeRates.filter((rate) => String(rate.keyName ?? "").trim() === preferredName);
  if (exact.length) return exact;

  const preferredSelected = selectedKeys.filter((key) => String(key?.name ?? "").trim() === preferredName);
  if (!preferredSelected.length) return [];

  const preferredIds = new Set(preferredSelected.map((key) => String(key.id)));
  const byId = activeRates.filter((rate) => preferredIds.has(String(rate.keyId)));
  return byId.length ? byId : [];
}

function summarizeIdentityRates(rateRows, meta = {}) {
  const values = rateRows
    .map((rate) => Number(rate.currentRateMultiplier))
    .filter(Number.isFinite);
  return summarizeNumericIdentity(values, {
    keyName: meta.keyName ?? null,
    groupName: meta.groupName ?? null
  });
}

function summarizeNumericIdentity(values, meta = {}) {
  const unique = [...new Set(values)];
  return {
    currentRateMultiplier: unique.length === 1 ? unique[0] : null,
    currentRateAmbiguous: unique.length > 1,
    currentRateCount: values.length,
    currentRateKeyName: meta.keyName ?? null,
    currentRateGroupName: meta.groupName ?? null
  };
}

export function selectCurrentRateKeys(keys, preferredNames = ["1111", "grok"]) {
  if (!Array.isArray(keys) || keys.length === 0) return keys;
  const names = new Set(
    (Array.isArray(preferredNames) ? preferredNames : [preferredNames])
      .map((name) => String(name ?? "").trim())
      .filter(Boolean)
  );
  const preferred = keys.filter((key) => key.isActive && names.has(String(key.name ?? "").trim()));
  return preferred.length ? preferred : keys;
}

export function deriveCurrentRates(keys, groups, userRates = {}) {
  if (!Array.isArray(keys) || keys.length === 0) return [];

  const groupMap = new Map(groups.map((group) => [String(group.groupId), group]));
  const currentRates = [];

  for (const key of keys) {
    const groupId = key.groupId;
    const group = groupId === null || groupId === undefined
      ? null
      : groupMap.get(String(groupId));
    const overrideRate = getUserRate(userRates, groupId);
    const baseRate = firstFiniteNumber(
      key.groupRateMultiplier,
      group?.baseRateMultiplier
    );
    const currentRate = firstFiniteNumber(
      overrideRate,
      key.userRateMultiplier,
      group?.userRateMultiplier,
      baseRate
    );

    if (currentRate === null) continue;

    currentRates.push({
      keyId: key.id,
      keyName: key.name || `key-${key.id}`,
      keyStatus: key.status || "",
      isActive: !key.status || key.status === "active",
      groupId,
      groupName: key.groupName || group?.groupName || "",
      platform: key.groupPlatform || group?.platform || "",
      baseRateMultiplier: baseRate,
      userRateMultiplier: nullableNumber(overrideRate ?? key.userRateMultiplier ?? group?.userRateMultiplier),
      currentRateMultiplier: currentRate,
      source: overrideRate !== undefined ? "groups/rates" : "keys.group"
    });
  }

  return currentRates;
}

async function collectAdminOverrides({ baseUrl, token, groups, client }) {
  const overrides = [];

  for (const group of groups) {
    const entries = await safeClient(
      client,
      { baseUrl, token, path: `/admin/groups/${group.groupId}/rate-multipliers` },
      []
    );

    for (const entry of Array.isArray(entries) ? entries : []) {
      if (entry?.rate_multiplier == null) continue;
      overrides.push({
        groupId: group.groupId,
        groupName: group.groupName,
        userId: entry.user_id,
        userName: entry.user_name ?? "",
        userEmail: entry.user_email ?? "",
        rateMultiplier: nullableNumber(entry.rate_multiplier),
        userStatus: entry.user_status ?? ""
      });
    }
  }

  return overrides;
}

async function collectSub2ApiAccount({ baseUrl, token, fetchedAt, client }) {
  if (!token) return { status: "unknown", balanceUsd: null, source: "sub2api:auth/me", error: "", fetchedAt };
  try {
    const payload = await client({ baseUrl, token, path: "/auth/me" });
    const balanceUsd = nullableNumber(payload?.balance);
    if (balanceUsd === null) throw new Error("余额字段缺失");
    return { status: "known", balanceUsd, source: "sub2api:auth/me", error: "", fetchedAt };
  } catch (error) {
    return {
      status: "unavailable",
      balanceUsd: null,
      source: "sub2api:auth/me",
      error: String(error?.message || "余额接口不可用").slice(0, 200),
      fetchedAt
    };
  }
}

async function safeClient(client, request, fallback) {
  try {
    return await client(request);
  } catch {
    return fallback;
  }
}

function normalizeGroups(payload) {
  if (Array.isArray(payload)) return payload;
  if (Array.isArray(payload?.items)) return payload.items;
  if (Array.isArray(payload?.groups)) return payload.groups;
  return [];
}

function normalizeKeys(payload) {
  if (!payload) return null;
  const items = Array.isArray(payload) ? payload : payload.items;
  if (!Array.isArray(items)) return null;

  return items.map((key) => ({
    id: key.id,
    name: key.name,
    groupId: key.group_id ?? key.group?.id ?? null,
    groupName: key.group?.name ?? "",
    groupPlatform: key.group?.platform ?? "",
    groupRateMultiplier: nullableNumber(key.group?.rate_multiplier),
    userRateMultiplier: nullableNumber(key.group?.user_rate_multiplier),
    status: key.status ?? "",
    isActive: !key.status || key.status === "active",
    quota: nullableNumber(key.quota),
    quotaUsed: nullableNumber(key.quota_used),
    usage5h: nullableNumber(key.usage_5h),
    usage1d: nullableNumber(key.usage_1d),
    usage7d: nullableNumber(key.usage_7d)
  }));
}

function getUserRate(userRates, groupId) {
  if (!userRates || groupId === undefined || groupId === null) return undefined;
  return userRates[groupId] ?? userRates[String(groupId)] ?? userRates[Number(groupId)];
}

function nullableNumber(value) {
  if (value === null || value === undefined || value === "") return null;
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : null;
}

function numberOrDefault(value, fallback) {
  const parsed = nullableNumber(value);
  return parsed === null ? fallback : parsed;
}

function firstFiniteNumber(...values) {
  for (const value of values) {
    const parsed = nullableNumber(value);
    if (parsed !== null) return parsed;
  }
  return null;
}

function roundNumber(value) {
  return Number.parseFloat(Number(value).toFixed(6));
}
