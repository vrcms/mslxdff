// v6pool · 起池前的实证探活：**用池里的源地址**打一次上游。
//
// 为什么必须有（这是本功能唯一不能省的实测）：内核接受地址（bind 成功）≠ 机房真把整段路由到本机。
// 只路由单个 /128 的机器上，从段内随机地址发出的包全部黑洞——那种池进了池就是「请求挂到超时」，
// 比直连更糟。判据只有一条：**从该地址真的能拿到上游响应**。
import { compatFetch, getUndici, timeoutSignal } from "../compat.js";
import { opencodeUa } from "../opencode-identity.js";

/**
 * @param {{ addr: string, baseUrl?: string, path?: string, agentFactory: Function, fetchImpl?: Function, timeoutMs?: number }} opts
 * @returns {Promise<{ ok: boolean, status: number, ms: number, error?: string }>}
 */
export async function probeFrom({ addr, baseUrl = "https://opencode.ai", path = "/zen/v1/models", agentFactory, fetchImpl, timeoutMs = 8000 } = {}) {
  const agent = agentFactory(addr);
  const url = `${String(baseUrl).replace(/\/+$/, "")}${path}`;
  const t0 = Date.now();
  try {
    const f = fetchImpl || getUndici().fetch || compatFetch;
    const res = await f(url, {
      method: "GET",
      headers: { "User-Agent": opencodeUa() },
      dispatcher: agent,
      signal: timeoutSignal(timeoutMs),
    });
    try {
      await res.text();
    } catch {
      /* 读不完不影响判活：拿到状态码就算数 */
    }
    return { ok: !!res.ok, status: res.status, ms: Date.now() - t0 };
  } catch (e) {
    return { ok: false, status: 0, ms: Date.now() - t0, error: String(e?.message || e) };
  } finally {
    try {
      await agent?.close?.();
    } catch {
      /* 探活用的 Agent 是一次性的，关不掉也不影响后续 */
    }
  }
}
