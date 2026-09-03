import { performance } from "node:perf_hooks";
import { resolveRetry, sleep, backoffDelay } from "./retry.js";
import { createSseParser } from "./sse.js";
import { createPool } from "./pool.js";

let UndiciFetch = null;
try {
  const mod = await import("undici");
  UndiciFetch = mod.fetch;
} catch {}

const DEFAULT_RETRY = {
  network: { attempts: 2, delayMs: 300 },
  429: { attempts: 1, delayMs: 100 },
  502: { attempts: 1, delayMs: 100 },
  503: { attempts: 1, delayMs: 100 },
  504: { attempts: 1, delayMs: 100 },
};

export function createTransport({
  baseUrl,
  headers: baseHeaders = {},
  keepAlive = true,
  fetchImpl,
  dispatcher: extDispatcher,
  timeoutMs: defaultTimeoutMs = 30_000,
  retry: defaultRetry = DEFAULT_RETRY,
  hooks,
} = {}) {
  if (!fetchImpl) fetchImpl = UndiciFetch || globalThis.fetch;
  const pool = keepAlive && !extDispatcher ? createPool({ keepAlive }) : null;
  const getDispatcher = () => extDispatcher || pool?.dispatcher || null;

  let closed = false;

  function resolveUrl(url) {
    if (!url) return baseUrl || "";
    if (/^https?:\/\//i.test(url)) return url;
    if (!baseUrl) return url;
    return `${String(baseUrl).replace(/\/+$/, "")}/${String(url).replace(/^\/+/, "")}`;
  }

  async function applyHooks(name, ctx) {
    if (!hooks) return null;
    try { return await hooks(name, ctx); } catch { return null; }
  }

  async function request({
    url,
    method = "POST",
    headers = {},
    body,
    stream,
    timeoutMs,
    retry,
    dispatcher,
  } = {}) {
    const finalUrl = resolveUrl(url);
    const retryCfg = retry ?? defaultRetry;
    const timeout = Number(timeoutMs ?? defaultTimeoutMs) || 30_000;
    const disp = dispatcher ?? getDispatcher();
    const t0 = performance.now();
    const attempts = [];
    let waitMs = 0;

    // 合并 headers
    const finalHeaders = { ...baseHeaders, ...headers };
    if (body != null && !finalHeaders["Content-Type"] && !finalHeaders["content-type"]) {
      finalHeaders["Content-Type"] = "application/json";
    }
    if (stream && !finalHeaders["Accept"] && !finalHeaders["accept"]) {
      finalHeaders["Accept"] = "text/event-stream";
    }

    const bodyStr = body != null && typeof body !== "string" ? JSON.stringify(body) : body;

    for (let attempt = 0; ; attempt++) {
      const tAttempt = performance.now();
      let res;
      let err = null;
      const controller = new AbortController();
      const timer = setTimeout(() => controller.abort(new Error(`upstream timed out after ${timeout}ms`)), timeout);
      try {
        let reqUrl = finalUrl;
        let reqHeaders = { ...finalHeaders };
        // hooks
        const hh = await applyHooks("upstream:headers", { url: reqUrl, body, headers: reqHeaders });
        if (hh?.changed && hh.value?.headers) reqHeaders = hh.value.headers;
        const br = await applyHooks("upstream:before-request", { url: reqUrl, method, body, headers: reqHeaders });
        if (br?.changed && br.value) {
          if (typeof br.value.url === "string" && br.value.url) reqUrl = br.value.url;
          if (br.value.headers && typeof br.value.headers === "object") reqHeaders = br.value.headers;
        }
        const opts = { method, headers: reqHeaders, body: bodyStr, signal: controller.signal };
        if (disp) opts.dispatcher = disp;
        res = await fetchImpl(reqUrl, opts);
      } catch (e) {
        err = e;
      } finally {
        clearTimeout(timer);
      }
      const ms = Math.round(performance.now() - tAttempt);

      if (err) {
        attempts.push({ type: "network", ms });
        const { shouldRetry, delayMs } = resolveRetry("network", attempt, retryCfg);
        if (shouldRetry) {
          await sleep(delayMs);
          waitMs += delayMs;
          continue;
        }
        err._t = { attempts, waitMs, totalMs: Math.round(performance.now() - t0) };
        throw err;
      }

      // http
      attempts.push({ type: `http${res.status}`, ms });
      const { shouldRetry, delayMs } = resolveRetry(res.status, attempt, retryCfg);
      if (shouldRetry) {
        // 消耗 body 以释放连接
        try { if (res.body) await res.text().catch(() => {}); } catch {}
        await sleep(delayMs);
        waitMs += delayMs;
        continue;
      }

      const ttfbMs = Math.round(performance.now() - t0);
      const isStreamRequested = stream === true;
      const contentType = res.headers.get("content-type") || "";
      // 若请求为 stream 但上游返回的是 JSON（测试桩常见），则回退为非流式处理，避免 SSE 空聚合
      const isStream = isStreamRequested && contentType.includes("text/event-stream");
      if (!isStream) {
        // 非流式：预读 body 以得 totalMs 与缓存（兼容 stream:true 但返回 JSON 的桩）
        let cachedText = "";
        let readMs = ttfbMs;
        try {
          cachedText = await res.text();
          readMs = Math.round(performance.now() - t0);
        } catch {
          cachedText = "";
          readMs = ttfbMs;
        }
        const totalMs = readMs;
        const headers = res.headers;
        return {
          status: res.status,
          headers,
          ok: res.ok,
          ttfbMs,
          totalMs,
          _t: { attempts, waitMs, totalMs },
          async json() { try { return JSON.parse(cachedText); } catch { return cachedText; } },
          async text() { return cachedText; },
          stream() { throw new Error("not-streaming: call with stream:true"); },
          get body() { return null; },
        };
      } else {
        // 流式：保留原始 res 用于 stream()
        const headers = res.headers;
        let firstTtfb = ttfbMs; // 更新为首事件到达时刻（测得即所得）
        let firstDone = false;
        let lastRead = ttfbMs;
        const markFirst = () => {
          if (!firstDone) { firstTtfb = Math.round(performance.now() - t0); firstDone = true; }
        };
        let _t = { attempts, waitMs, totalMs: ttfbMs };
        return {
          status: res.status,
          headers,
          ok: res.ok,
          get ttfbMs() { return firstDone ? firstTtfb : ttfbMs; },
          get totalMs() { return lastRead; },
          get _t() { return _t; },
          set _t(v) { _t = v; },
          async json() {
            let acc = "";
            for await (const chunk of this.stream()) acc += chunk;
            try { return JSON.parse(acc); } catch { return acc; }
          },
          async text() {
            let acc = "";
            for await (const chunk of this.stream()) acc += chunk;
            return acc;
          },
          get body() { return res.body; },
          async *stream() {
            const parser = createSseParser();
            if (res.body && typeof res.body.getReader === "function") {
              const reader = res.body.getReader();
              const decoder = new TextDecoder();
              while (true) {
                const { done, value } = await reader.read();
                if (done) break;
                lastRead = Math.round(performance.now() - t0);
                try { _t.totalMs = lastRead; } catch {}
                const text = decoder.decode(value, { stream: true });
                const evs = parser.push(text);
                for (const e of evs) {
                  if (e === "[DONE]") return;
                  if (e === "") continue;
                  markFirst();
                  yield e;
                }
              }
            } else if (typeof res.text === "function") {
              const txt = await res.text();
              const evs = parser.push(txt);
              for (const e of evs) {
                if (e === "[DONE]") return;
                if (e === "") continue;
                markFirst();
                yield e;
              }
            }
          },
        };
      }
    }
  }

  async function preheat(url) {
    const target = url || (baseUrl ? `${String(baseUrl).replace(/\/+$/, "")}/zen/v1/models` : null);
    if (!target) return { ok: false, skipped: true };
    const t0 = performance.now();
    try {
      const res = await request({ url: target, method: "GET", stream: false, timeoutMs: 3000 });
      try { if (res.text) await res.text().catch(() => {}); } catch {}
      return { ok: res.ok, status: res.status, ms: Math.round(performance.now() - t0) };
    } catch (e) {
      return { ok: false, error: String(e?.message || e), ms: Math.round(performance.now() - t0) };
    }
  }

  async function close() {
    if (closed) return;
    closed = true;
    if (pool) await pool.close();
  }

  return {
    request,
    preheat,
    close,
    get dispatcher() { return getDispatcher(); },
    get agent() { return pool?.agent || null; },
    [Symbol.asyncDispose]: close,
  };
}
