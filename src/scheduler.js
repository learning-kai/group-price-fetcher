export function createScheduler({
  repository,
  collector,
  clock = () => new Date(),
  random = Math.random,
  jitterRatio = 0.1,
  tickMs = 30_000,
  setIntervalImpl = setInterval,
  clearIntervalImpl = clearInterval,
  onError = () => {}
}) {
  if (!repository || !collector) throw new Error("Scheduler 缺少必要依赖");
  const runningSiteIds = new Set();
  let timer = null;

  async function tick() {
    const dueSites = repository.listDueSites(clock().toISOString());
    const jobs = dueSites
      .filter((site) => site.enabled !== false && !runningSiteIds.has(site.id))
      .map(async (site) => {
        runningSiteIds.add(site.id);
        try {
          await collector.collectSite(site, { trigger: "scheduled" });
        } catch (error) {
          onError(error, site);
        } finally {
          const minutes = repository.getEffectiveSchedule(site.id);
          const nextRun = calculateNextRun(clock(), minutes, { random, jitterRatio });
          repository.setNextRun(site.id, nextRun.toISOString());
          runningSiteIds.delete(site.id);
        }
      });
    await Promise.all(jobs);
    return { submitted: jobs.length, running: runningSiteIds.size };
  }

  async function start() {
    if (timer) return;
    await tick();
    timer = setIntervalImpl(() => {
      tick().catch((error) => onError(error, null));
    }, tickMs);
    timer?.unref?.();
  }

  function stop() {
    if (!timer) return;
    clearIntervalImpl(timer);
    timer = null;
  }

  return {
    start,
    stop,
    tick,
    status: () => ({ started: Boolean(timer), runningSiteIds: [...runningSiteIds] })
  };
}

export function calculateNextRun(base, intervalMinutes, { random = Math.random, jitterRatio = 0.1 } = {}) {
  const date = base instanceof Date ? base : new Date(base);
  const minutes = Number(intervalMinutes);
  if (Number.isNaN(date.getTime())) throw new Error("基准时间无效");
  if (!Number.isFinite(minutes) || minutes <= 0) throw new Error("采集频率必须大于 0");
  if (!Number.isFinite(jitterRatio) || jitterRatio < 0 || jitterRatio > 1) throw new Error("抖动比例必须在 0 到 1 之间");
  const sample = Math.min(1, Math.max(0, Number(random())));
  const factor = 1 + ((sample * 2) - 1) * jitterRatio;
  return new Date(date.getTime() + Math.round(minutes * 60_000 * factor));
}
