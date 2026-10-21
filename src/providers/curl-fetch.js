// curl-fetch 适配器：fetch(url, init) → curl.exe 子进程 → 标准 Response
// 背景（ADR-0066 门槛④，2026-10-21 现网取证）：agentrouter 对 Node/undici 新建 TCP 连接
// 选择性丢包（undici 0/4~0/6 全 connect 超时、curl 同刻 100% 200），供应商传输层整体换 curl。
// 契约：只消费 init 的 method/headers/body(string)/signal；其余字段（如 undici dispatcher）忽略。
// 失败语义：拿不到响应头即抛 Error（交上层 runner 的 network 重试/冷却，与 fetch 抛错同语义）。
// ⚠ 流式关键教训（2026-10-21 本机踩坑）：stdout 必须**立即挂 data 监听进流式（flowing）模式**
//   ——等消费者 pull 才读会让 curl 写满管道后卡住/退出，res.text() 永不返回；
//   统一 chunk 队列：header 阶段从队列文本判就绪，body 阶段同一队列续吐，零丢字节。
// ⚠ 弹窗教训（2026-10-21 用户机实测）：daemon 是无控制台后台进程，spawn 不加 `windowsHide`
//   时 Windows 会给每个 console 子进程（curl.exe）新开一个控制台窗口——流式+重试+预热
//   叠加就是窗口轰炸。
// ⚠ 100-continue 教训（2026-10-21 同批，Claude Code 大 body 实锤）：body 超 ~1KB 时 curl 自动
//   带 `Expect: 100-continue`，`-D` 头文件先落 `HTTP/1.1 100 Continue` 伪段；若把它当终局
//   交卷，`new Response(status=100)` 直接 RangeError → 上层 502 → key 冷却 30s 连锁。
//   双保险：请求侧 `-H "Expect:"` 关掉该机制 + 头解析侧跳过所有 1xx/CONNECT 伪段。
import { spawn } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const DEFAULT_CURL = process.env.MSLXDFF_CURL_PATH || "curl.exe";
const HEAD_WAIT_MS = Number(process.env.MSLXDFF_CURL_HEAD_WAIT_MS) || 15_000; // 等响应头的上限（连接失败由 curl 退出/EOF 提前揭穿）
// curl 侧整请求硬闸（防无 signal 调用方遗留僵尸进程；runner 的 connectTimeoutMs 通常先到期掐进程）
const FALLBACK_MAX_TIME_S = Number(process.env.MSLXDFF_CURL_MAX_TIME_S) || 600;
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const safeRead = (fp) => { try { return readFileSync(fp, "latin1"); } catch { return ""; } };

/** 1xx 中间应答段（含代理 CONNECT 的 `200 Connection established` 伪应答——curl 虽按 RFC 记
 *  它为 1xx 语义，现网写出的是 `HTTP/1.1 200 Connection established`，两者都不算终局）。 */
const INTERMEDIATE_SEGMENT = /^HTTP\/[\d.]+[ \t]+(?:1\d{2}|200[ \t]+Connection established)/i;

/** 解析 curl -D 头文件（代理 CONNECT / 1xx 中间应答都是前置伪段，取最后一个非伪段）。 */
export function parseHeaderBlob(blob) {
  const segs = String(blob || "").split(/\r?\n\r?\n/).filter((s) => /^HTTP\//i.test(s.trim()));
  // 从后往前找第一个「终局」段（非 1xx / 非 CONNECT 伪应答）；全是伪段则回退最后一段
  let last = segs.length ? segs[segs.length - 1] : String(blob || "");
  for (let i = segs.length - 1; i >= 0; i--) {
    if (!INTERMEDIATE_SEGMENT.test(segs[i].trim())) { last = segs[i]; break; }
  }
  const m = last.match(/HTTP\/[\d.]+[ \t]+(\d{3})/i);
  // 伪段状态（1xx）绝不能外泄给 new Response（RangeError → 上层假 502）；归 0 按无头失败处理
  let status = m ? Number(m[1]) : 0;
  if (status && status < 200) status = 0;
  const headers = new Headers();
  for (const line of last.split(/\r?\n/).slice(1)) {
    const i = line.indexOf(":");
    if (i > 0) headers.set(line.slice(0, i).trim(), line.slice(i + 1).trim());
  }
  return { status, headers };
}

/**
 * 头块是否已完整可交卷：存在至少一个以空行收尾的 HTTP 段，且**最后一个完整段不是**
 * 1xx 中间应答/代理 CONNECT 伪应答（`-H "Expect:"` 之外的第二道保险：防上游无视 Expect
 * 仍回 100，或代理链回 CONNECT）。
 */
export function headerBlobReady(blob) {
  const segs = String(blob || "").split(/\r?\n\r?\n/);
  if (segs.length < 2) return false;
  const lastFull = segs[segs.length - 2];
  if (!/^HTTP\//i.test(String(lastFull || "").trim())) return false;
  if (INTERMEDIATE_SEGMENT.test(String(lastFull).trim())) return false;
  return true;
}

/**
 * 建 fetch 兼容函数。
 * @param {{curlPath?: string, headWaitMs?: number}} [opts]
 */
export function createCurlFetch({ curlPath = DEFAULT_CURL, headWaitMs = HEAD_WAIT_MS } = {}) {
  const tmpRoot = mkdtempSync(join(tmpdir(), "mslxdff-curl-"));
  return async function curlFetch(url, init = {}) {
    const dir = mkdtempSync(join(tmpRoot, "r"));
    const headerFile = join(dir, "hdr.txt");
    // `-H "Expect:"`：显式移除 curl 对大 body（>1KB）自动附加的 Expect 头，杜绝 100-continue 往返
    const args = ["-sS", "-N", "--http1.1", "--max-time", String(FALLBACK_MAX_TIME_S), "-H", "Expect:", "-D", headerFile];
    const body = init.body != null ? String(init.body) : null;
    if (body !== null) {
      const method = init.method && init.method !== "GET" ? init.method : "POST";
      args.push("-X", method, "--data-binary", "@-");
    } else if (init.method && init.method !== "GET") {
      args.push("-X", init.method);
    }
    const headers = init.headers || {};
    for (const k of Object.keys(headers)) {
      const v = headers[k];
      if (typeof v === "string" && v) args.push("-H", `${k}: ${v}`);
    }
    args.push(String(url));

    // windowsHide：daemon（无控制台后台进程）下不加这项，Windows 会**每次 spawn 弹一个 curl 控制台窗口**
    const child = spawn(curlPath, args, { stdio: ["pipe", "pipe", "pipe"], windowsHide: true });
    child.stdin.on("error", () => {}); // EPIPE：curl 启动即败时写 body 不崩主流程
    let stderr = "";
    child.stderr.on("data", (c) => { stderr += c.toString(); });
    if (body !== null) child.stdin.end(body);

    // ① spawn 即流式：stdout 全部进队列（header 就绪前的 body 字节也在其中，不丢）
    const chunks = [];
    let eof = false;
    let streamErr = null;
    let waiters = [];
    child.stdout.on("data", (c) => {
      chunks.push(c);
      if (waiters.length) waiters.shift()({ value: chunks.shift(), done: false });
    });
    child.stdout.on("error", (e) => { streamErr = e; eof = true; wakeAll(); });
    child.stdout.on("end", () => { eof = true; wakeAll(); });
    child.on("error", (e) => { streamErr = e; eof = true; wakeAll(); });
    function wakeAll() { const ws = waiters; waiters = []; for (const w of ws) w({ value: undefined, done: true }); }
    const kill = () => { try { child.kill(); } catch {} };

    // ② 等响应头（-D 文件出现完整非-CONNECT 段；curl 退出/EOF 提前结束等待）
    const deadline = Date.now() + headWaitMs;
    let blob = "";
    for (;;) {
      blob = safeRead(headerFile);
      if (headerBlobReady(blob)) break;
      if (eof || streamErr) break; // 无头 EOF：下面按失败处理
      if (Date.now() >= deadline) { kill(); break; }
      await sleep(20);
    }
    const { status, headers: resHeaders } = parseHeaderBlob(blob);
    if (!status) {
      kill();
      try { rmSync(dir, { recursive: true, force: true }); } catch {}
      const err = new Error(`curl-fetch: 无响应头（${String(url)}）${streamErr ? ` err=${streamErr.message}` : ""}${stderr ? ` stderr=${stderr.slice(0, 160)}` : ""}`);
      err._curlNoHeader = true;
      throw err; // 交上层 network 重试/冷却（等价 fetch 的连接类抛错）
    }

    // ③ Response.body：先吐队列积压、再随 data 事件续吐；signal/cancel 杀进程
    const cleanup = () => { try { rmSync(dir, { recursive: true, force: true }); } catch {} };
    const stream = new ReadableStream({
      async pull(controller) {
        if (chunks.length) { controller.enqueue(new Uint8Array(chunks.shift())); return; }
        if (streamErr) { cleanup(); controller.error(streamErr); return; }
        if (eof) { cleanup(); controller.close(); return; }
        const r = await new Promise((res) => waiters.push(res));
        if (r.done) {
          if (streamErr) { cleanup(); controller.error(streamErr); return; }
          cleanup(); controller.close(); return;
        }
        controller.enqueue(new Uint8Array(r.value));
      },
      cancel() { kill(); cleanup(); },
    });
    const onAbort = () => kill();
    if (init.signal) {
      if (init.signal.aborted) kill();
      else init.signal.addEventListener("abort", onAbort, { once: true });
    }
    return new Response(stream, { status, statusText: "", headers: resHeaders });
  };
}
