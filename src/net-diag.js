// 网络错误诊断 —— 把 undici 那句没头没尾的 `fetch failed` 展开成「哪种故障、打谁、卡在哪」。
//
// 为什么需要它：undici 抛 `TypeError: fetch failed` 时，真正的原因（ECONNREFUSED / ENOTFOUND /
// headers timeout / TLS …）藏在 `err.cause`，再深一次还可能藏在 `cause.cause`。而 `errMsg()`
// 只取 `err.message`，于是全链路日志里只剩 `fetch failed` —— 这正是「组员 B 回报 502 fetch failed、
// 却谁也说不清它为什么打不到上游」的死因（member 侧 broadband execAndPost 原样把 errMsg 回给组长）。
//
// 本模块是纯函数、零依赖：把 err 连同 cause 链压成 { name, code, message, addr, syscall, summary }，
// 让成员侧、组长侧、CLI 三处都能写同一口径的一句话。

/** 检测 fetch 网络错误标志位的有序列表：先 code，再 name，再看 message。 */
const KNOWN_CODES = new Set([
  "ECONNREFUSED", "ENOTFOUND", "EAI_AGAIN", "ETIMEDOUT", "ECONNRESET", "EPIPE",
  "ENETUNREACH", "EHOSTUNREACH", "EADDRNOTAVAIL", "ENETDOWN", "ECONNABORTED",
  "UND_ERR_CONNECT_TIMEOUT", "UND_ERR_HEADERS_TIMEOUT", "UND_ERR_BODY_TIMEOUT",
  "UND_ERR_SOCKET", "UND_ERR_CLOSED", "UND_ERR_ABORTED", "UND_ERR_RESPONSE_STATUS_CODE",
  "CERT_HAS_EXPIRED", "ERR_TLS_CERT_ALTNAME_INVALID", "UNABLE_TO_VERIFY_LEAF_SIGNATURE",
  "DEPTH_ZERO_SELF_SIGNED_CERT", "SELF_SIGNED_CERT_IN_CHAIN",
]);

/** code/name → 人话短语。查不到就回落成 code 本身。 */
const CODE_ZH = {
  ECONNREFUSED: "连接被拒绝",
  ENOTFOUND: "DNS 解析失败",
  EAI_AGAIN: "DNS 暂时失败",
  ETIMEDOUT: "连接超时",
  ECONNRESET: "连接被重置",
  EPIPE: "管道已断开",
  ENETUNREACH: "网络不可达",
  EHOSTUNREACH: "主机不可达",
  EADDRNOTAVAIL: "本地地址不可用（出口绑定失败）",
  ECONNABORTED: "连接被中断",
  UND_ERR_CONNECT_TIMEOUT: "建连超时",
  UND_ERR_HEADERS_TIMEOUT: "等响应头超时",
  UND_ERR_BODY_TIMEOUT: "读响应体超时",
  UND_ERR_SOCKET: "socket 异常",
  UND_ERR_CLOSED: "连接已被关闭",
  UND_ERR_ABORTED: "请求被取消",
  CERT_HAS_EXPIRED: "TLS 证书过期",
  ERR_TLS_CERT_ALTNAME_INVALID: "TLS 证书域名不匹配",
  UNABLE_TO_VERIFY_LEAF_SIGNATURE: "TLS 证书链无法验证",
  DEPTH_ZERO_SELF_SIGNED_CERT: "TLS 自签证书",
  SELF_SIGNED_CERT_IN_CHAIN: "TLS 证书链含自签证书",
};

/** 从一层的 err/cause 对象上读 code：优先 `.code`，其次 `.name`（undici 超时类常用 name）。 */
function pickCode(node) {
  if (!node) return "";
  const c = node.code;
  if (typeof c === "string" && c) return c;
  const n = node.name;
  if (typeof n === "string" && n && n !== "Error" && n !== "TypeError") return n;
  return "";
}

/** 把 message 里可能带的 URL 提炼出来（`fetch failed to http://…` 少见，但 socket 错误常带地址）。 */
function pickAddr(node) {
  const a = node?.address || node?.host || node?.hostname;
  if (typeof a === "string" && a) return a;
  const m = /(?:https?:\/\/)?(\d{1,3}(?:\.\d{1,3}){3}(?::\d+)?)/.exec(String(node?.message || ""));
  return m ? m[1] : "";
}

/**
 * 把任意 thrown 值展开成诊断对象。
 * @param {unknown} err
 * @returns {{ name: string, code: string, message: string, addr: string, syscall: string, summary: string }}
 */
export function describeError(err) {
  const chain = [];
  let node = err;
  for (let depth = 0; node && depth < 5; depth++) {
    chain.push(node);
    node = node.cause;
  }
  const first = chain[0] || {};
  const name = String(first.name || "Error");

  // 选定「有信息量」的那层：第一层带已知 code 的层；都没有就用最深的非空 code，再退回第一层。
  let chosen = null;
  for (const n of chain) {
    const c = pickCode(n);
    if (c && KNOWN_CODES.has(c)) { chosen = { node: n, code: c }; break; }
  }
  if (!chosen) {
    for (let i = chain.length - 1; i >= 0; i--) {
      const c = pickCode(chain[i]);
      if (c) { chosen = { node: chain[i], code: c }; break; }
    }
  }
  const code = chosen?.code || "";
  const addr = pickAddr(chosen?.node || first);
  const syscall = String(chosen?.node?.syscall || first.syscall || "");

  // message 取「最深一条非空 message」—— 那通常是最贴近 syscall 的一句；都没有就用第一层。
  let message = "";
  for (let i = chain.length - 1; i >= 0; i--) {
    const m = String(chain[i]?.message || "").trim();
    if (m) { message = m; break; }
  }
  if (!message) message = String(first.message || err || "");

  const zh = CODE_ZH[code] || "";
  const parts = [];
  parts.push(code ? `${code}${zh ? `（${zh}）` : ""}` : name);
  if (addr) parts.push(`peer=${addr}`);
  if (syscall) parts.push(`syscall=${syscall}`);
  const head = parts.join(" ");
  // message 已含 code 时不重复（如 "connect ECONNREFUSED …" 与 code=ECONNREFUSED）；
  // 注意 code 为空时不能建空正则——空 pattern 匹配一切，会把 message 误判成冗余。
  const redundant = code && new RegExp(escapeRegExp(code)).test(message);
  const summary = message && message !== code && !redundant
    ? `${head} — ${message}`
    : head;
  return { name, code, message, addr, syscall, summary };
}

/** 一句话诊断，供日志/回包直接用。 */
export function describeErrorText(err) {
  return describeError(err).summary;
}

function escapeRegExp(s) {
  return String(s).replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}
