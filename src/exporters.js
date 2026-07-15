export function toCsv(result) {
  const currentRates = flattenCurrentRates(result);
  if (currentRates.length > 0) {
    return toCurrentRatesCsv(currentRates);
  }

  const groups = flattenGroups(result);
  const rows = [
    [
      "site_name",
      "site_url",
      "provider",
      "base_url",
      "mode",
      "group_id",
      "group_name",
      "platform",
      "status",
      "subscription_type",
      "billing_type",
      "base_rate_multiplier",
      "user_rate_multiplier",
      "effective_rate_multiplier",
      "peak_enabled",
      "peak_start",
      "peak_end",
      "peak_multiplier",
      "peak_effective_multiplier",
      "rpm_limit",
      "daily_limit_usd",
      "weekly_limit_usd",
      "monthly_limit_usd",
      "image_price_1k",
      "image_price_2k",
      "image_price_4k",
      "description"
    ]
  ];

  for (const { site, result: source, group } of groups) {
    rows.push([
      site.name,
      site.baseUrl,
      source.providerId,
      source.baseUrl,
      source.mode,
      group.groupId,
      group.groupName,
      group.platform,
      group.status,
      group.subscriptionType,
      group.billingType,
      group.baseRateMultiplier,
      group.userRateMultiplier,
      group.effectiveRateMultiplier,
      group.peakRate.enabled,
      group.peakRate.start,
      group.peakRate.end,
      group.peakRate.multiplier,
      group.peakRate.effectiveMultiplier,
      group.rpmLimit,
      group.dailyLimitUsd,
      group.weeklyLimitUsd,
      group.monthlyLimitUsd,
      group.imagePricing.price1k,
      group.imagePricing.price2k,
      group.imagePricing.price4k,
      group.description
    ]);
  }

  return `${rows.map((row) => row.map(csvCell).join(",")).join("\n")}\n`;
}

export function toJson(result) {
  return JSON.stringify(result, null, 2);
}

export function ratesToCsv(rates) {
  if (!Array.isArray(rates)) throw new Error("倍率导出数据必须是数组");
  const rows = [[
    "site_name",
    "site_url",
    "category",
    "group_id",
    "group_name",
    "platform",
    "status",
    "base_rate_multiplier",
    "user_rate_multiplier",
    "source_effective_rate_multiplier",
    "rate_conversion_factor",
    "effective_rate_multiplier",
    "rpm_limit",
    "description",
    "updated_at"
  ]];
  for (const rate of rates) {
    rows.push([
      rate.siteName,
      rate.baseUrl,
      rate.categoryName,
      rate.groupId,
      rate.groupName,
      rate.platform,
      rate.status,
      rate.baseRateMultiplier,
      rate.userRateMultiplier,
      rate.sourceEffectiveRateMultiplier,
      rate.rateConversionFactor,
      rate.effectiveRateMultiplier,
      rate.rpmLimit,
      rate.description,
      rate.validFrom
    ]);
  }
  return `${rows.map((row) => row.map(csvCell).join(",")).join("\n")}\n`;
}

function toCurrentRatesCsv(currentRates) {
  const rows = [
    [
      "site_name",
      "site_url",
      "current_rate_multiplier",
      "key_id",
      "key_name",
      "key_status",
      "group_id",
      "group_name",
      "platform",
      "source"
    ]
  ];

  for (const { site, rate } of currentRates) {
    rows.push([
      site.name,
      site.baseUrl,
      rate.currentRateMultiplier,
      rate.keyId,
      rate.keyName,
      rate.keyStatus,
      rate.groupId,
      rate.groupName,
      rate.platform,
      rate.source
    ]);
  }

  return `${rows.map((row) => row.map(csvCell).join(",")).join("\n")}\n`;
}

function flattenCurrentRates(result) {
  if (result?.batch) {
    return result.results.flatMap((source) => (
      (source.currentRates ?? []).map((rate) => ({
        site: source.site ?? { name: "", baseUrl: source.baseUrl },
        rate
      }))
    ));
  }

  return (result?.currentRates ?? []).map((rate) => ({
    site: result.site ?? { name: "", baseUrl: result.baseUrl },
    rate
  }));
}

function flattenGroups(result) {
  if (result?.batch) {
    return result.results.flatMap((source) => (
      (source.groups ?? []).map((group) => ({
        site: source.site ?? { name: "", baseUrl: source.baseUrl },
        result: source,
        group
      }))
    ));
  }

  return (result.groups ?? []).map((group) => ({
    site: result.site ?? { name: "", baseUrl: result.baseUrl },
    result,
    group
  }));
}

function csvCell(value) {
  if (value === null || value === undefined) return "";
  const text = String(value);
  if (/["\n\r,]/.test(text)) {
    return `"${text.replace(/"/g, '""')}"`;
  }
  return text;
}
