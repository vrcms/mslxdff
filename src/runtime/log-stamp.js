// daemon.log 行归因前缀（时间 + pid）：一个日志文件被多个进程写时，没有它就无法回答
// 「这行是谁写的、是这一轮还是上一轮」。2026-10-17 组长 VPS 事故就卡在这里——同一份 daemon.log 里
// 混着两个 daemon、两个版本的行，而旧版行与新版本行只差措辞（`已复活` vs `已复活（第 N 次尝试成功）`），
// 肉眼分不出来，于是「日志什么都没看出来」。时间解决「哪一轮」，pid 解决「谁写的」。
// 只在 daemon 模式装：前台/CLI 的输出是给人看的，不额外加噪。
const MARK = Symbol.for("mslxdff.logStamp");

/** 行前缀：`[HH:MM:SS pid] `（本地时间，秒级足够定位一轮启动）。 */
export function stampPrefix({ now = Date.now, pid = process.pid } = {}) {
  const d = new Date(now());
  const p2 = (n) => String(n).padStart(2, "0");
  return `[${p2(d.getHours())}:${p2(d.getMinutes())}:${p2(d.getSeconds())} ${pid}] `;
}

/**
 * 给整段文本的每一行加前缀（纯函数，行首状态由调用方跨次传递）。
 * 只在行首加：半行写入（`write("半句")` 之后 `write("收尾\n")`）不会被重复打标。
 * @returns {{ text: string, atLineStart: boolean }}
 */
export function stampText(text, { prefix = stampPrefix(), atLineStart = true } = {}) {
  const src = String(text ?? "");
  if (!src) return { text: "", atLineStart };
  let out = "";
  let atStart = atLineStart;
  let idx = 0;
  while (idx < src.length) {
    const nl = src.indexOf("\n", idx);
    if (nl === -1) {
      out += (atStart ? prefix : "") + src.slice(idx);
      atStart = false;
      break;
    }
    out += (atStart ? prefix : "") + src.slice(idx, nl + 1);
    atStart = true;
    idx = nl + 1;
  }
  return { text: out, atLineStart: atStart };
}

/**
 * 给流装行前缀（幂等：重复调用不会套两层）。绝不抛——日志格式化不许挡住启动。
 * @param {{ streams?: object[], now?: Function, pid?: number }} [opts]
 * @returns {object[]} 实际装上的流
 */
export function installLogStamp({ streams = [process.stdout, process.stderr], now = Date.now, pid = process.pid } = {}) {
  const done = [];
  for (const s of streams) {
    if (!s || typeof s.write !== "function" || s[MARK]) continue;
    const orig = s.write.bind(s);
    let atLineStart = true;
    s.write = (chunk, enc, cb) => {
      let encoding = enc;
      let callback = cb;
      if (typeof enc === "function") {
        callback = enc;
        encoding = undefined;
      }
      const text = typeof chunk === "string"
        ? chunk
        : (chunk && typeof chunk.toString === "function" ? chunk.toString(encoding || "utf8") : String(chunk ?? ""));
      const r = stampText(text, { prefix: stampPrefix({ now, pid }), atLineStart });
      atLineStart = r.atLineStart;
      return orig(r.text, encoding, callback);
    };
    try {
      Object.defineProperty(s, MARK, { value: true, enumerable: false });
    } catch {
      s[MARK] = true;
    }
    done.push(s);
  }
  return done;
}
