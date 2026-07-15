import { decryptBackup, encryptBackup } from "./backupCrypto.js";
import { normalizeBaseUrl } from "./httpClient.js";
import { redactSecrets } from "./security.js";

const PAYLOAD_TYPE = "site-transfer";
const PAYLOAD_VERSION = 1;
const PROVIDERS = new Set(["sub2api", "newapi"]);
const AUTH_MODES = new Set(["public", "sub2api-password", "sub2api-token", "newapi-token", "edge-profile"]);
const SITE_KEYS = new Set([
  "name",
  "baseUrl",
  "providerId",
  "categoryName",
  "tags",
  "scheduleMinutes",
  "enabled",
  "rateConversionFactor",
  "authMode",
  "credentials"
]);

export function createSiteTransferService({ repository, credentialStore, authManager, clock = () => new Date() }) {
  if (!repository || !credentialStore || !authManager) throw new Error("SiteTransferService 缺少必要依赖");

  async function exportTransfer(password) {
    const now = clock();
    const vault = await credentialStore.exportAll();
    const sites = repository.exportTransferSites().map((site) => ({
      name: site.name,
      baseUrl: site.baseUrl,
      providerId: site.providerId,
      categoryName: site.categoryName || null,
      tags: [...site.tags],
      scheduleMinutes: site.scheduleMinutes,
      enabled: site.enabled,
      rateConversionFactor: site.rateConversionFactor,
      authMode: site.authMode,
      credentials: exportCredentials(site.authMode, vault[`site:${site.id}`])
    }));
    const body = await encryptBackup({
      payloadType: PAYLOAD_TYPE,
      payloadVersion: PAYLOAD_VERSION,
      createdAt: now.toISOString(),
      sites
    }, password);
    return artifact(body, now);
  }

  async function importTransfer(serialized, password) {
    const payload = validatePayload(await decryptBackup(serialized, password));
    const result = { created: 0, overwritten: 0, needsCredentials: 0, failed: 0, errors: [] };
    const categories = new Map(repository.listCategories().map((category) => [category.name, category.id]));

    for (const input of payload.sites) {
      try {
        const categoryId = resolveCategory(input.categoryName, categories);
        const existing = repository.getSiteByBaseUrl(input.baseUrl);
        const siteInput = {
          name: input.name,
          baseUrl: input.baseUrl,
          providerId: input.providerId,
          categoryId,
          tags: input.tags,
          scheduleMinutes: input.scheduleMinutes,
          enabled: input.authMode === "edge-profile" ? false : input.enabled,
          rateConversionFactor: input.rateConversionFactor,
          authMode: input.authMode
        };
        const site = existing
          ? repository.updateSite(existing.id, siteInput)
          : repository.createSite(siteInput);

        if (input.credentials) {
          await authManager.configureCredentials(site, { authMode: input.authMode, ...input.credentials });
        } else {
          await authManager.clearCredentials(site);
        }

        if (input.authMode === "edge-profile" || (requiresCredentials(input.authMode) && !input.credentials)) {
          result.needsCredentials += 1;
        }
        if (existing) result.overwritten += 1;
        else result.created += 1;
      } catch (error) {
        result.failed += 1;
        result.errors.push({
          name: input.name,
          baseUrl: input.baseUrl,
          error: redactSecrets(error?.message || "导入失败")
        });
      }
    }
    return result;
  }

  function resolveCategory(name, categories) {
    if (name === null) return null;
    if (categories.has(name)) return categories.get(name);
    const category = repository.createCategory({ name });
    categories.set(name, category.id);
    return category.id;
  }

  return { exportTransfer, importTransfer };
}

function validatePayload(payload) {
  const allowedTopLevel = new Set(["payloadType", "payloadVersion", "createdAt", "sites"]);
  if (!isRecord(payload)
    || hasUnknownKeys(payload, allowedTopLevel)
    || payload.payloadType !== PAYLOAD_TYPE
    || payload.payloadVersion !== PAYLOAD_VERSION
    || !isIsoDate(payload.createdAt)
    || !Array.isArray(payload.sites)) {
    throw transferError("站点交换包载荷无效");
  }
  const seenUrls = new Set();
  const sites = payload.sites.map((site, index) => validateSite(site, index, seenUrls));
  return { ...payload, sites };
}

function validateSite(site, index, seenUrls) {
  if (!isRecord(site) || hasUnknownKeys(site, SITE_KEYS)) {
    throw transferError(`站点交换包第 ${index + 1} 项无效`);
  }
  const name = requiredString(site.name, `第 ${index + 1} 项站点名称`);
  let baseUrl;
  try {
    baseUrl = normalizeBaseUrl(site.baseUrl);
  } catch {
    throw transferError(`第 ${index + 1} 项站点 URL 无效`);
  }
  if (seenUrls.has(baseUrl)) throw transferError(`站点交换包包含重复 URL：${baseUrl}`);
  seenUrls.add(baseUrl);

  const providerId = requiredString(site.providerId, `第 ${index + 1} 项 Provider`);
  if (!PROVIDERS.has(providerId)) throw transferError(`第 ${index + 1} 项 Provider 不受支持`);
  const authMode = requiredString(site.authMode, `第 ${index + 1} 项认证方式`);
  if (!AUTH_MODES.has(authMode)) throw transferError(`第 ${index + 1} 项认证方式不受支持`);

  const categoryName = site.categoryName === null
    ? null
    : requiredString(site.categoryName, `第 ${index + 1} 项分类名称`);
  if (!Array.isArray(site.tags)) throw transferError(`第 ${index + 1} 项标签无效`);
  const tags = [...new Set(site.tags.map((tag) => requiredString(tag, `第 ${index + 1} 项标签`)))].sort();
  const scheduleMinutes = site.scheduleMinutes === null
    ? null
    : positiveInteger(site.scheduleMinutes, `第 ${index + 1} 项采集频率`);
  if (typeof site.enabled !== "boolean") throw transferError(`第 ${index + 1} 项启用状态无效`);
  const rateConversionFactor = Number(site.rateConversionFactor);
  if (!Number.isFinite(rateConversionFactor) || rateConversionFactor <= 0) {
    throw transferError(`第 ${index + 1} 项倍率换算系数无效`);
  }
  const credentials = validateCredentials(authMode, site.credentials, index);

  return {
    name,
    baseUrl,
    providerId,
    categoryName,
    tags,
    scheduleMinutes,
    enabled: site.enabled,
    rateConversionFactor,
    authMode,
    credentials
  };
}

function validateCredentials(authMode, value, index) {
  if (value === null) return null;
  if (!isRecord(value)) throw transferError(`第 ${index + 1} 项凭据无效`);
  if (authMode === "sub2api-password") {
    requireExactKeys(value, ["email", "password"], index);
    return {
      email: requiredString(value.email, `第 ${index + 1} 项邮箱`),
      password: requiredString(value.password, `第 ${index + 1} 项密码`)
    };
  }
  if (authMode === "newapi-token") {
    requireExactKeys(value, ["accessToken", "userId"], index);
    return {
      accessToken: requiredString(value.accessToken, `第 ${index + 1} 项 Access Token`),
      userId: requiredString(value.userId, `第 ${index + 1} 项用户 ID`)
    };
  }
  if (authMode === "sub2api-token") {
    requireExactKeys(value, ["accessToken", "refreshToken"], index);
    return {
      accessToken: requiredString(value.accessToken, `第 ${index + 1} 项 Access Token`),
      refreshToken: optionalString(value.refreshToken, `第 ${index + 1} 项 Refresh Token`)
    };
  }
  throw transferError(`第 ${index + 1} 项认证方式不接受凭据`);
}

function exportCredentials(authMode, value) {
  if (!isRecord(value)) return null;
  if (authMode === "sub2api-password" && nonEmpty(value.email) && nonEmpty(value.password)) {
    return { email: value.email, password: value.password };
  }
  if (authMode === "newapi-token" && nonEmpty(value.accessToken) && nonEmpty(value.userId)) {
    return { accessToken: value.accessToken, userId: value.userId };
  }
  if (authMode === "sub2api-token" && nonEmpty(value.accessToken)) {
    return {
      accessToken: value.accessToken,
      refreshToken: typeof value.refreshToken === "string" ? value.refreshToken : ""
    };
  }
  return null;
}

function requireExactKeys(value, expected, index) {
  const actual = Object.keys(value).sort();
  const wanted = [...expected].sort();
  if (actual.length !== wanted.length || actual.some((key, keyIndex) => key !== wanted[keyIndex])) {
    throw transferError(`第 ${index + 1} 项凭据字段无效`);
  }
}

function artifact(body, now) {
  const stamp = now.toISOString().replace(/[-:]/g, "").replace("T", "-").slice(0, 15);
  return {
    body: Buffer.from(body, "utf8"),
    filename: `group-price-sites-${stamp}.gpftransfer`,
    contentType: "application/octet-stream"
  };
}

function requiredString(value, label) {
  if (typeof value !== "string" || !value.trim()) throw transferError(`${label}无效`);
  return value.trim();
}

function optionalString(value, label) {
  if (typeof value !== "string") throw transferError(`${label}无效`);
  return value.trim();
}

function positiveInteger(value, label) {
  const number = Number(value);
  if (!Number.isInteger(number) || number <= 0) throw transferError(`${label}无效`);
  return number;
}

function requiresCredentials(authMode) {
  return authMode === "sub2api-password" || authMode === "sub2api-token" || authMode === "newapi-token";
}

function hasUnknownKeys(value, allowed) {
  return Object.keys(value).some((key) => !allowed.has(key));
}

function isRecord(value) {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

function nonEmpty(value) {
  return typeof value === "string" && value.trim().length > 0;
}

function isIsoDate(value) {
  if (typeof value !== "string") return false;
  const date = new Date(value);
  return !Number.isNaN(date.getTime()) && date.toISOString() === value;
}

function transferError(message) {
  return Object.assign(new Error(message), { code: "TRANSFER_PAYLOAD_INVALID", status: 400 });
}
