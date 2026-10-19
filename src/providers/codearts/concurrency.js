// codearts 上游硬限并发：FIFO 排队闸，超限请求等前面的让出额度再发（该上游对并发极敏感）。
//
// 两道约束同时生效：
//  ① 在途并发（active < cap）：同一时刻打到上游的请求数 ≤3。
//  ② 最近窗口内已开会话数（opens < cap）：上游按「账号最近约 90s 内打开过的会话数」判限，
//     每个请求占一个会话槽、**请求结束不立即释放**（实测 ~80s 才回收）。只压 ① 不够——
//     串行连发 4 个（间隔 1s）第 4 个仍被拒 TM.00001041 并发会话数已达上限(3个)（2026-10-19 现网实测）。
//     故本闸维护「窗口内已开会话」这个**动态值**，到 cap 就让下一个请求等到最早一次会话过期再放。
const DEFAULT_SESSION_WINDOW_MS = 90_000;

export function createGate({ limit = 3, sessionWindowMs = DEFAULT_SESSION_WINDOW_MS } = {}) {
  const cap = Number.isFinite(limit) && limit > 0 ? Math.floor(limit) : Infinity;
  const winMs = Number.isFinite(sessionWindowMs) && sessionWindowMs >= 0 ? sessionWindowMs : DEFAULT_SESSION_WINDOW_MS;
  let active = 0;
  let waiting = 0;
  const opens = []; // 窗口内每次「开会话」的时间戳（升序）；不随 release 移除，靠时间过期

  function prune(now) {
    const cut = now - winMs;
    while (opens.length && opens[0] <= cut) opens.shift();
  }

  function release() {
    active--;
  }

  // 取得一个槽位，返回「释放一次」的幂等函数。释放的时机交给调用方——
  // 流式请求必须**等流真正读完/取消**才释放 active，否则 runChat 一返回（流还没消费）就放行。
  // 注意：releaseOnce 只回收 active；窗口内的 opens 记录不被它清掉（会话槽在上游还要占 ~80s）。
  async function acquire(onWait) {
    const t0 = Date.now();
    let counted = false;
    for (;;) {
      const now = Date.now();
      prune(now);
      if (active < cap && opens.length < cap) break;
      if (!counted) { counted = true; waiting++; }
      // 等到「最早那次会话过期」才能再开；若只是 active 满（窗口还没满），短轮询等释放
      const untilExpire = opens.length >= cap ? Math.max(0, winMs - (now - opens[0])) : 0;
      const sleepMs = Math.min(Math.max(untilExpire + 20, 50), 1000);
      await new Promise((r) => setTimeout(r, sleepMs));
    }
    if (counted) {
      waiting--;
      if (onWait) { try { onWait({ waitedMs: Date.now() - t0, queued: opens.length, limit: cap, windowMs: winMs }); } catch {} }
    }
    active++;
    opens.push(Date.now());
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
    stats: () => ({ active, queued: waiting, limit: cap, opens: opens.length, windowMs: winMs }),
    get active() { return active; },
    get queued() { return waiting; },
    get opens() { return opens.length; },
  };
}
