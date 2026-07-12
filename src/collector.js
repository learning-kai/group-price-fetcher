import { ApiError } from "./httpClient.js";

export function createCollector({
  repository,
  authManager,
  getProvider,
  queue,
  sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms)),
  clock = () => new Date()
}) {
  if (!repository || !authManager || !getProvider || !queue) {
    throw new Error("Collector 缺少必要依赖");
  }

  function collectSite(site, options = {}) {
    return queue.add(async () => {
      const startedAt = clock();
      const runId = repository.startRun(site.id, options.trigger ?? "scheduled", startedAt.toISOString());
      try {
        let auth = await authManager.getAccess(site);
        let authRefreshed = false;
        let transientRetries = 0;
        let rateLimitRetries = 0;
        const provider = getProvider(site.providerId);

        while (true) {
          try {
            const result = await provider.fetchPrices({
              baseUrl: site.baseUrl,
              token: auth.token,
              headers: auth.headers ?? {},
              mode: "user",
              includeKeys: false
            });
            repository.saveCollection(site.id, result, result.fetchedAt ?? clock().toISOString(), runId);
            repository.finishRun(runId, {
              status: "success",
              finishedAt: clock().toISOString(),
              durationMs: Math.max(0, clock() - startedAt)
            });
            return result;
          } catch (error) {
            if (error?.status === 401 && !authRefreshed) {
              authRefreshed = true;
              auth = await authManager.getAccess(site, { forceRefresh: true });
              continue;
            }
            if (error?.status === 429 && rateLimitRetries < 1) {
              rateLimitRetries += 1;
              await sleep(error.retryAfterMs ?? 60_000);
              continue;
            }
            if ((error?.status == null || error.status >= 500) && transientRetries < 2) {
              await sleep(1_000 * (2 ** transientRetries));
              transientRetries += 1;
              continue;
            }
            throw error;
          }
        }
      } catch (error) {
        const classified = classifyCollectionError(error);
        repository.finishRun(runId, {
          status: "failed",
          finishedAt: clock().toISOString(),
          durationMs: Math.max(0, clock() - startedAt),
          httpStatus: error?.status ?? null,
          errorCode: classified.code,
          errorMessage: classified.message
        });
        throw error;
      }
    }, { timeoutMs: options.timeoutMs });
  }

  async function collectMany(sites, options = {}) {
    const settled = await Promise.allSettled(sites.map((site) => collectSite(site, options)));
    const successes = [];
    const failures = [];
    settled.forEach((item, index) => {
      if (item.status === "fulfilled") successes.push({ site: sites[index], result: item.value });
      else failures.push({ site: sites[index], error: item.reason });
    });
    return { successes, failures };
  }

  async function probeSite(site, options = {}) {
    const provider = getProvider(site.providerId);
    if (typeof provider.probeCompatibility !== "function") {
      throw new Error(`Provider 不支持兼容探测：${site.providerId}`);
    }
    const auth = options.token ? { token: options.token } : await authManager.getAccess(site);
    return provider.probeCompatibility({ baseUrl: site.baseUrl, token: auth.token, headers: auth.headers ?? {} });
  }

  return { collectSite, collectMany, probeSite };
}

export function classifyCollectionError(error) {
  if (error?.code === "LOGIN_REQUIRED" || error?.status === 401) {
    return { code: "LOGIN_REQUIRED", message: error.message || "需要重新登录" };
  }
  if (error?.status === 403) return { code: "PERMISSION_DENIED", message: error.message || "权限不足" };
  if (error?.status === 429) return { code: "RATE_LIMITED", message: error.message || "请求过于频繁" };
  if (error?.code === "TASK_TIMEOUT") return { code: "TIMEOUT", message: error.message };
  if (error?.status >= 500) return { code: "UPSTREAM_ERROR", message: error.message || "上游服务异常" };
  if (error instanceof ApiError) return { code: "NETWORK_ERROR", message: error.message };
  return { code: "COLLECTION_FAILED", message: error?.message || "采集失败" };
}
