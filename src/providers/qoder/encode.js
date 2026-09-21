// qoder COSY 自定义 base64 编解码（转译 qoder2api internal/cosy/encoding.go）
// 自定义字母表 + 1/3 尾部轮转，`$` 代 `=`
const CUSTOM = "_doRTgHZBKcGVjlvpC,@aFSx#DPuNJme&i*MzLOEn)sUrthbf%Y^w.(kIQyXqWA!";
const STD = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/";
const CUSTOM_PAD = "$";

const c2s = new Array(128).fill(-1);
const s2c = new Array(128).fill(-1);

for (let i = 0; i < 64; i++) {
  c2s[CUSTOM.charCodeAt(i)] = STD.charCodeAt(i);
  s2c[STD.charCodeAt(i)] = CUSTOM.charCodeAt(i);
}
c2s[CUSTOM_PAD.charCodeAt(0)] = "=".charCodeAt(0);
s2c["=".charCodeAt(0)] = CUSTOM_PAD.charCodeAt(0);

export function cosyEncode(plain) {
  const std = Buffer.from(plain).toString("base64");
  const n = std.length;
  const a = Math.floor(n / 3);
  const rearranged = std.slice(n - a) + std.slice(a, n - a) + std.slice(0, a);
  const out = new Array(n);
  for (let i = 0; i < n; i++) {
    const c = rearranged.charCodeAt(i);
    if (c >= 128 || s2c[c] < 0) throw new Error("char out of alphabet: " + c);
    out[i] = String.fromCharCode(s2c[c]);
  }
  return out.join("");
}

export function cosyDecode(encoded) {
  const n = encoded.length;
  const mapped = new Array(n);
  for (let i = 0; i < n; i++) {
    const c = encoded.charCodeAt(i);
    if (c >= 128 || c2s[c] < 0) throw new Error("char out of custom alphabet: " + c);
    mapped[i] = String.fromCharCode(c2s[c]);
  }
  const a = Math.floor(n / 3);
  const std = mapped.slice(n - a).join("") + mapped.slice(a, n - a).join("") + mapped.slice(0, a).join("");
  return Buffer.from(std, "base64");
}