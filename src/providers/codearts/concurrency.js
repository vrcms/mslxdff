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

  // 取得一个槽位，返回「释放一次」的幂等函数。超限时 FIFO 排队（并回调 onWait）。
  // 关键：释放的时机交给调用方——流式请求必须**等流真正读完/取消**才释放，
  // 否则 runChat 一返回（流还没消费）就放行，上游其实仍占着会话 ⇒ 第 4 路被上游拒
  // （TM.00001041 并发会话数已达上限）。见 index.js 的 chat 接线。
  async function acquire(onWait) {
    if (active >= cap) {
      const t0 = Date.now();
      const queued = waiters.length + 1;
      await new Promise((resolve) => waiters.push(resolve));
      if (onWait) { try { onWait({ waitedMs: Date.now() - t0, queued, limit: cap }); } catch {} }
    }
    active++;
    let released = false;
    return function releaseOnce() {
      if (released) return;
      released = true;
      release();
    };
  }

  async function run(fn, onWait) {
    const rel = await acquire(onWait);
    try {
      return await fn();
    } finally {
      rel();
    }
  }

  return {
    run,
    acquire,
    stats: () => ({ active, queued: waiters.length, limit: cap }),
    get active() { return active; },
    get queued() { return waiters.length; },
  };
}
