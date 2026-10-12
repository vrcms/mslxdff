// codearts 上游硬限并发：FIFO 排队闸，超限请求等前面的让出额度再发（该上游对并发极敏感）。
export function createGate({ limit = 3 } = {}) {
  const cap = Number.isFinite(limit) && limit > 0 ? Math.floor(limit) : Infinity;
  let active = 0;
  const waiters = [];

  function release() {
    active--;
    const w = waiters.shift();
    if (w) w();
  }

  async function run(fn, onWait) {
    if (active >= cap) {
      const t0 = Date.now();
      const queued = waiters.length + 1;
      await new Promise((resolve) => waiters.push(resolve));
      if (onWait) { try { onWait({ waitedMs: Date.now() - t0, queued, limit: cap }); } catch {} }
    }
    active++;
    try {
      return await fn();
    } finally {
      release();
    }
  }

  return {
    run,
    stats: () => ({ active, queued: waiters.length, limit: cap }),
    get active() { return active; },
    get queued() { return waiters.length; },
  };
}
