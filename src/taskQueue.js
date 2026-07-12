export class TaskTimeoutError extends Error {
  constructor(timeoutMs) {
    super(`任务超过 ${timeoutMs}ms 未完成`);
    this.name = "TaskTimeoutError";
    this.code = "TASK_TIMEOUT";
  }
}

export function createTaskQueue({ concurrency = 5, timeoutMs = 30_000 } = {}) {
  if (!Number.isInteger(concurrency) || concurrency <= 0) throw new Error("并发数必须是正整数");
  const pending = [];
  let active = 0;

  function add(action, options = {}) {
    if (typeof action !== "function") return Promise.reject(new Error("任务必须是函数"));
    return new Promise((resolve, reject) => {
      pending.push({ action, timeoutMs: options.timeoutMs ?? timeoutMs, resolve, reject });
      pump();
    });
  }

  function pump() {
    while (active < concurrency && pending.length) start(pending.shift());
  }

  function start(item) {
    active += 1;
    let settled = false;
    const timer = item.timeoutMs > 0
      ? setTimeout(() => {
        if (!settled) {
          settled = true;
          item.reject(new TaskTimeoutError(item.timeoutMs));
        }
      }, item.timeoutMs)
      : null;

    Promise.resolve()
      .then(item.action)
      .then(
        (value) => {
          if (!settled) {
            settled = true;
            item.resolve(value);
          }
        },
        (error) => {
          if (!settled) {
            settled = true;
            item.reject(error);
          }
        }
      )
      .finally(() => {
        if (timer) clearTimeout(timer);
        active -= 1;
        pump();
      });
  }

  return {
    add,
    stats: () => ({ active, pending: pending.length, concurrency })
  };
}
