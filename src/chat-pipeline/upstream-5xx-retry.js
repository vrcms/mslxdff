// 指定模型撞 5xx 的原地重试（用户口径，2026-10-23）：
//   5xx → 等 5s → 同模型重拉，连续重试 3 次；仍 5xx 才交给上层换 1 个节点。
// 为什么不在 auto 里用：auto 的候选是不同模型池，换模型比等待更划算；指定模型的模型不能换，
// 只能先等上游缓过来，避免「一失败就换节点」把一次故障放大成整组节点同时打上游。
// 只处理 HTTP 5xx；429（按出口 IP 的额度）与 4xx 一律不等待，交回上层走原有路径。
const DEFAULTS = Object.freeze({ retries: 3, delayMs: 5000 });

function envIntOrZero(env, name, fallback) {
  const raw = String(env[name] ?? "").trim();
  if (raw === "") return fallback;
  const n = Number(raw);
  return Number.isInteger(n) && n >= 0 ? n : fallback;
}

/** 读配置：次数与间隔都允许 0（0 次 = 关闭；0ms = 不等待）。空串/非法值回落默认。 */
export function http5xxRetryCfg(env = process.env) {
  return {
    retries: envIntOrZero(env, "MSLXDFF_5XX_RETRIES", DEFAULTS.retries),
    delayMs: envIntOrZero(env, "MSLXDFF_5XX_RETRY_DELAY_MS", DEFAULTS.delayMs),
  };
}

export function isHttp5xx(status) {
  return Number.isInteger(Number(status)) && Number(status) >= 500 && Number(status) <= 599;
}

function sleep(ms) {
  return ms > 0 ? new Promise((r) => setTimeout(r, ms)) : Promise.resolve();
}

// 上一发失败的 5xx 响应体没有被业务消费（判据只读 clone），重试前主动取消，防连接空占。
function cancelBody(res) {
  try {
    const p = res?.body?.cancel?.();
    if (p && typeof p.catch === "function") p.catch(() => {});
  } catch { /* 取消失败不影响重试 */ }
}

/**
 * 包一层 upstream.chat：指定模型 + 5xx 时原地退避重试。
 * @param {object} p
 * @param {() => Promise<any>} p.call 真正发上游（每次调用都重新发）
 * @param {boolean} p.singleModel 是否指定模型（false=auto，原样返回）
 * @param {object} [p.cfg] http5xxRetryCfg()
 * @param {(name:string, data:object)=>void} [p.evt]
 * @param {string} [p.reqId]
 * @param {string} [p.model]
 * @param {() => boolean} [p.isClosed] 客户端是否已断开；断开即停止重试
 * @returns {Promise<any>} 最后一发响应（可能是 5xx，也可能是成功）
 */
export async function chatWith5xxRetry({
  call,
  singleModel = false,
  cfg = http5xxRetryCfg(),
  evt,
  reqId,
  model,
  isClosed,
} = {}) {
  let res = await call();
  if (!singleModel || !cfg.retries) return res;
  let retried = 0;
  while (isHttp5xx(res?.status) && retried < cfg.retries) {
    if (typeof isClosed === "function" && isClosed()) break;
    retried += 1;
    cancelBody(res);
    try { evt?.("upstream-5xx-retry", { reqId, model, retry: retried, max: cfg.retries, delayMs: cfg.delayMs, status: res.status }); } catch {}
    await sleep(cfg.delayMs);
    res = await call();
  }
  return res;
}
