// -setto claude-desktop 的 1M 证据 Adapter（design D1/D3、ADR-0056）：一次 GET 本机网关 /v1/models。
// 真相源唯一 = ADR-0054 四级解析后的已裁决值（双层同源同值；顶层 context_length 缺/非正才回落
// capabilities.context 作保险，CLI 进程不复刻聚合、不另起第二证据链）。
// 失败一律 {ok:false,reason} 不抛：写盘职责与网关可达性解耦（spec《证据获取失败不阻塞写盘》）。
import { compatFetch, timeoutSignal } from "../compat.js";

function positiveInt(v) {
  const n = Number(v);
  return Number.isFinite(n) && n > 0 ? Math.floor(n) : null;
}

/**
 * @param {{port:number|string, token?:string, fetchImpl?:Function, timeoutMs?:number}} p
 * @returns {Promise<{ok:true, contexts:Map<string,number>} | {ok:false, reason:string}>}
 */
export async function oneMContexts({ port, token = "", fetchImpl = compatFetch, timeoutMs = 3000 } = {}) {
  const url = `http://127.0.0.1:${Number(port) || 8989}/v1/models`;
  try {
    const res = await fetchImpl(url, {
      headers: { Accept: "application/json", Authorization: `Bearer ${token}` },
      signal: timeoutSignal(timeoutMs),
    });
    if (!res?.ok) return { ok: false, reason: `HTTP ${res?.status ?? "?"}` };
    const data = await res.json();
    const list = Array.isArray(data?.data) ? data.data : null;
    if (!list) return { ok: false, reason: "响应形状异常：缺 data[]" };
    const contexts = new Map();
    for (const e of list) {
      const id = String(e?.id || "").trim().toLowerCase();
      if (!id) continue;
      const n = positiveInt(e.context_length) ?? positiveInt(e?.capabilities?.context);
      if (n) contexts.set(id, n);
    }
    return { ok: true, contexts };
  } catch (err) {
    return { ok: false, reason: String(err?.message || err) };
  }
}
