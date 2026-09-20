// 华为云 SDK-HMAC-SHA256 请求签名（AK/SK + 可选 STS security token）。
// 对齐 @huaweicloud/huaweicloud-sdk-core AKSKSigner（逆向参考：HITZY2002/codearts2api internal/upstream/signer.go）：
//   - SignedHeaders = 请求全部头（小写排序，含 host / x-sdk-content-sha256 / maas_type）
//   - CanonicalURI 每段 percent-encode 且末尾补 "/"
//   - payload hash 取 X-Sdk-Content-Sha256（= 请求体原样 sha256 hex）
import crypto from "node:crypto";

export const SIGN_ALGORITHM = "SDK-HMAC-SHA256";

export function sha256Hex(data) {
  const buf = typeof data === "string" ? Buffer.from(data, "utf8") : (data || Buffer.alloc(0));
  return crypto.createHash("sha256").update(buf).digest("hex");
}

export function hmacHex(key, msg) {
  return crypto.createHmac("sha256", String(key || "")).update(String(msg || ""), "utf8").digest("hex");
}

// Go url.PathEscape(encodePathSegment)：仅 / ; , ? 与非 URI 字符转义。
// 本项目全部端点路径均为纯字母数字（恒等），此处按 RFC3986 pchar 集保守实现。
const PCHAR = /[^A-Za-z0-9\-._~!$&'()*+,;=:@]/g;
function escapeSegment(seg) {
  return String(seg || "").replace(PCHAR, (c) => encodeURIComponent(c));
}

// 末尾强制补 "/"（对齐 JS SDK CanonicalURI；漏掉即签名失败）。
export function canonicalUriPath(pathname) {
  const out = String(pathname || "/").split("/").map(escapeSegment).join("/");
  return out.endsWith("/") ? out : out + "/";
}

// Go url.QueryEscape：空格 → "+"；key/value 各自排序。
const QESC = (s) => encodeURIComponent(s).replace(/%20/g, "+").replace(/[!'()*]/g, (c) => "%" + c.charCodeAt(0).toString(16).toUpperCase());
function decodeSafe(s) { try { return decodeURIComponent(s); } catch { return s; } }

export function canonicalQuery(rawQuery) {
  const raw = String(rawQuery || "");
  if (!raw) return "";
  const pairs = raw.replace(/^\?/, "").split("&").filter(Boolean).map((p) => {
    const i = p.indexOf("=");
    const k = i < 0 ? p : p.slice(0, i);
    const v = i < 0 ? "" : p.slice(i + 1);
    return [decodeSafe(k), decodeSafe(v)];
  });
  pairs.sort((a, b) => (a[0] < b[0] ? -1 : a[0] > b[0] ? 1 : a[1] < b[1] ? -1 : a[1] > b[1] ? 1 : 0));
  return pairs.map(([k, v]) => `${QESC(k)}=${QESC(v)}`).join("&");
}

// 全部请求头（小写 key 排序；值 TrimSpace）→ canonical 行集 + SignedHeaders 串。
export function canonicalHeaders(headers) {
  const canon = {};
  for (const [k, v] of Object.entries(headers || {})) {
    if (v === undefined || v === null) continue;
    canon[k.toLowerCase()] = String(v).trim();
  }
  const keys = Object.keys(canon).sort();
  const lines = keys.map((k) => `${k}:${canon[k]}\n`).join("");
  return { canonical: lines, signed: keys.join(";"), canon };
}

/**
 * 给请求补签名头：x-sdk-date / x-security-token / x-sdk-content-sha256 / authorization。
 * @param {object} p
 * @param {string} p.method  HTTP 方法
 * @param {string} p.url     完整 URL（host 取自这里）
 * @param {object} p.headers 签名前已就位的全部业务头（maas_type 必须已含）
 * @param {string|Buffer} [p.body] 请求体原样字节
 * @param {{accessKeyId, secretAccessKey, securityToken?}} p.cred
 * @returns {{headers: object, stringToSign: string, canonicalRequest: string}} 最终待发送头
 */
export function signRequest({ method, url, headers = {}, body = "", cred, now = new Date() }) {
  const u = new URL(url);
  const xDate = now.toISOString().slice(0, 19).replace(/[-:]/g, "") + "Z";
  const payloadHash = sha256Hex(body);
  const h = { ...headers };
  if (cred?.securityToken) h["x-security-token"] = cred.securityToken;
  h["x-sdk-date"] = xDate;
  h["x-sdk-content-sha256"] = payloadHash;
  // host 进签名集（Go 显式 Set("Host")）；fetch 会按 URL 自发同值 Host 头，服务端验签一致。
  h["host"] = u.host;
  const { canonical, signed } = canonicalHeaders(h);
  const canonicalRequest = [
    String(method || "GET").toUpperCase(),
    canonicalUriPath(u.pathname),
    canonicalQuery(u.search),
    canonical,
    signed,
    payloadHash,
  ].join("\n");
  const stringToSign = [SIGN_ALGORITHM, xDate, sha256Hex(canonicalRequest)].join("\n");
  const signature = hmacHex(cred?.secretAccessKey, stringToSign);
  const finalHeaders = { ...h };
  delete finalHeaders.host; // host 头由 HTTP 客户端自行发出，不在 fetch 头里透传
  finalHeaders.authorization = `${SIGN_ALGORITHM} Access=${cred?.accessKeyId || ""}, SignedHeaders=${signed}, Signature=${signature}`;
  return { headers: finalHeaders, stringToSign, canonicalRequest };
}
