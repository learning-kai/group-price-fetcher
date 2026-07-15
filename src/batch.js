export async function fetchBatchPrices({ provider, targets, options = {} }) {
  const results = [];
  const errors = [];

  for (const target of targets) {
    let site = {
      name: String(target?.name || target?.baseUrl || target?.url || "未知站点"),
      baseUrl: String(target?.baseUrl || target?.url || "")
    };

    try {
      site = normalizeTarget(target);
      let token = site.token || options.token;
      let authSource = token ? "manual" : "";

      if (!token) {
        if (typeof options.resolveToken === "function") {
          const resolved = await options.resolveToken(site.baseUrl);
          token = resolved.token;
          authSource = resolved.source;
        } else {
          throw new Error("缺少 Token");
        }
      }

      const result = await provider.fetchPrices({
        ...options,
        baseUrl: site.baseUrl,
        token
      });

      results.push({
        ...result,
        site: {
          name: site.name,
          baseUrl: site.baseUrl,
          authSource
        }
      });
    } catch (error) {
      errors.push({
        site: {
          name: site.name,
          baseUrl: site.baseUrl
        },
        error: error.message || "请求失败",
        status: error.status ?? null,
        code: error.code ?? null,
        detail: error.details ?? error.detail ?? null
      });
    }
  }

  return {
    batch: true,
    providerId: provider.id,
    providerLabel: provider.label,
    mode: options.mode || "user",
    fetchedAt: new Date().toISOString(),
    results,
    errors,
    summary: summarizeBatch(results, errors)
  };
}

export function summarizeBatch(results, errors = []) {
  const groups = results.flatMap((result) => result.groups ?? []);
  const currentRates = results.flatMap((result) => result.currentRates ?? []);
  const rates = groups
    .map((group) => group.effectiveRateMultiplier)
    .filter(Number.isFinite);
  const activeCurrentRates = currentRates
    .filter((rate) => rate.isActive)
    .map((rate) => rate.currentRateMultiplier)
    .filter(Number.isFinite);

  return {
    siteCount: results.length + errors.length,
    successCount: results.length,
    errorCount: errors.length,
    groupCount: groups.length,
    currentRateCount: currentRates.length,
    activeCount: groups.filter((group) => !group.status || group.status === "active").length,
    minRate: rates.length ? Math.min(...rates) : null,
    maxRate: rates.length ? Math.max(...rates) : null,
    avgRate: rates.length
      ? Number.parseFloat((rates.reduce((sum, rate) => sum + rate, 0) / rates.length).toFixed(6))
      : null,
    currentMinRate: activeCurrentRates.length ? Math.min(...activeCurrentRates) : null,
    currentMaxRate: activeCurrentRates.length ? Math.max(...activeCurrentRates) : null,
    platforms: [...new Set(groups.map((group) => group.platform).filter(Boolean))].sort()
  };
}

export function parseTargetLines(text, tokenResolver = () => null) {
  return String(text || "")
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter((line) => line && !line.startsWith("#"))
    .map((line) => {
      const parts = line.split("|").map((part) => part.trim());
      const [nameOrUrl, maybeUrl, maybeTokenRef] = parts;
      const baseUrl = maybeUrl || nameOrUrl;
      const name = maybeUrl ? nameOrUrl : hostnameLabel(baseUrl);
      const token = maybeTokenRef ? tokenResolver(maybeTokenRef) : null;
      return { name, baseUrl, token };
    });
}

function normalizeTarget(target) {
  const baseUrl = String(target.baseUrl || target.url || "").trim();
  if (!baseUrl) {
    throw new Error("站点 URL 不能为空");
  }

  return {
    name: String(target.name || hostnameLabel(baseUrl)).trim(),
    baseUrl,
    token: typeof target.token === "string" ? target.token.trim() : ""
  };
}

function hostnameLabel(baseUrl) {
  try {
    return new URL(baseUrl).hostname;
  } catch {
    return baseUrl;
  }
}
