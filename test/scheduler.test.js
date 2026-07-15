import test from "node:test";
import assert from "node:assert/strict";
import { createScheduler, calculateNextRun } from "../src/scheduler.js";

test("next run applies deterministic jitter around the effective interval", () => {
  const base = new Date("2026-07-13T00:00:00.000Z");
  assert.equal(
    calculateNextRun(base, 60, { random: () => 1, jitterRatio: 0.1 }).toISOString(),
    "2026-07-13T01:06:00.000Z"
  );
  assert.equal(
    calculateNextRun(base, 60, { random: () => 0, jitterRatio: 0.1 }).toISOString(),
    "2026-07-13T00:54:00.000Z"
  );
});

test("tick collects persisted due sites and schedules their next run", async () => {
  const nextRuns = [];
  const repository = {
    listDueSites() {
      return [{ id: 1, name: "到期站", enabled: true }];
    },
    getEffectiveSchedule() { return 30; },
    setNextRun(siteId, value) { nextRuns.push({ siteId, value }); }
  };
  const collected = [];
  const scheduler = createScheduler({
    repository,
    collector: { async collectSite(site) { collected.push(site.id); } },
    clock: () => new Date("2026-07-13T00:00:00.000Z"),
    random: () => 0.5
  });

  await scheduler.tick();

  assert.deepEqual(collected, [1]);
  assert.deepEqual(nextRuns, [{ siteId: 1, value: "2026-07-13T00:30:00.000Z" }]);
});

test("one site never overlaps when a second tick occurs", async () => {
  let release;
  const pending = new Promise((resolve) => { release = resolve; });
  let calls = 0;
  const repository = {
    listDueSites: () => [{ id: 1, enabled: true }],
    getEffectiveSchedule: () => 60,
    setNextRun() {}
  };
  const scheduler = createScheduler({
    repository,
    collector: { async collectSite() { calls += 1; await pending; } }
  });

  const first = scheduler.tick();
  await Promise.resolve();
  await scheduler.tick();
  assert.equal(calls, 1);
  release();
  await first;
});

test("start immediately recovers persisted due work and stop clears timer", async () => {
  let timerCallback;
  let cleared = false;
  let calls = 0;
  const scheduler = createScheduler({
    repository: {
      listDueSites: () => calls === 0 ? [{ id: 9, enabled: true }] : [],
      getEffectiveSchedule: () => 60,
      setNextRun() {}
    },
    collector: { async collectSite() { calls += 1; } },
    setIntervalImpl(callback) { timerCallback = callback; return 42; },
    clearIntervalImpl(id) { cleared = id === 42; }
  });

  await scheduler.start();
  assert.equal(calls, 1);
  assert.equal(typeof timerCallback, "function");
  scheduler.stop();
  assert.equal(cleared, true);
});
