// raccoon 二维码单测：GF/RS 用规范已知向量锚定，矩阵用结构判据（定位/定时/格式信息）锚定。
// 不引入解码库——结构判据足以抓住「图案画错、掩码没生效、格式位写反」这几类真故障。
import { test } from "node:test";
import assert from "node:assert/strict";
import { buildQrCodewords, pickQrVersion, qrEcGeneratorPoly } from "../src/providers/raccoon/qr-codewords.js";
import { encodeQr, renderTerminal } from "../src/providers/raccoon/qr.js";
import { raccoonQrPageUrl } from "../src/providers/raccoon/const.js";

test("qrEcGeneratorPoly: 10 次生成多项式等于 QR 规范已知向量", () => {
  assert.deepEqual(qrEcGeneratorPoly(10), [1, 216, 194, 159, 111, 199, 94, 95, 113, 157, 193]);
});

test("pickQrVersion: 按容量选最小版本，超 v10 返回 undefined", () => {
  assert.equal(pickQrVersion(1), 1);
  assert.equal(pickQrVersion(14), 1); // v1-M 可装 14 字节
  assert.equal(pickQrVersion(15), 2);
  assert.equal(pickQrVersion(213), 10); // v10-M 可装 213 字节
  assert.equal(pickQrVersion(214), undefined);
});

test("buildQrCodewords: 码字总数 = 数据码字 + 纠错码字", () => {
  assert.equal(buildQrCodewords([...Buffer.from("HI", "utf8")], 1).length, 16 + 10);
  assert.equal(buildQrCodewords([...Buffer.from("A".repeat(100), "utf8")], 6).length, 108 + 64);
});

test("encodeQr: 尺寸 = 版本*4+17，三个定位图案与定时线正确", () => {
  const m = encodeQr("HELLO");
  assert.equal(m.size, 21); // v1
  // 定位图案外圈全黑、内 3x3 全黑（在 (3,3) / (17,3) / (3,17) 中心）
  for (const [cx, cy] of [[3, 3], [m.size - 4, 3], [3, m.size - 4]]) {
    assert.equal(m.modules[cy][cx], true, `finder 中心 @${cx},${cy}`);
    assert.equal(m.modules[cy][cx + 2], false, `finder 白环（切比雪夫距离 2）@${cx},${cy}`);
    assert.equal(m.modules[cy][cx + 3], true, `finder 外圈（距离 3）@${cx},${cy}`);
  }
  // 定时线：第 6 行 / 第 6 列在数据区内交替
  for (let i = 8; i < m.size - 8; i++) assert.equal(m.modules[6][i], i % 2 === 0, `水平定时 @${i}`);
});

test("encodeQr: 格式信息声明纠错级 M，且固定黑模块在位", () => {
  const m = encodeQr("HELLO");
  // 读回第一份格式位（bit0..bit14）
  const bit = (i) => {
    if (i <= 5) return m.modules[i][8];
    if (i === 6) return m.modules[7][8];
    if (i === 7) return m.modules[8][8];
    if (i === 8) return m.modules[8][7];
    return m.modules[8][14 - i];
  };
  let bits = 0;
  for (let i = 0; i < 15; i++) if (bit(i)) bits |= 1 << i;
  const unmasked = bits ^ 0x5412;
  const ecLevel = (unmasked >> 13) & 0b11;
  const mask = (unmasked >> 10) & 0b111;
  assert.equal(ecLevel, 0b00, "纠错级应为 M(00)");
  assert.ok(mask >= 0 && mask <= 7, "掩码号应在 0..7");
  assert.equal(m.modules[m.size - 8][8], true, "固定黑模块应在 (8, size-8)");
});

test("encodeQr: 确定性 + 过长输入返回 undefined", () => {
  const a = encodeQr("https://example.com/x").modules.map((r) => r.map((v) => (v ? 1 : 0)).join("")).join("\n");
  const b = encodeQr("https://example.com/x").modules.map((r) => r.map((v) => (v ? 1 : 0)).join("")).join("\n");
  assert.equal(a, b);
  assert.equal(encodeQr("X".repeat(400)), undefined);
});

test("encodeQr: 真实扫码登录 URL 能编成码（中文 appname 也不溢出）", () => {
  const url = raccoonQrPageUrl("3c820ebeb0226c5c5661320244d93cd7");
  assert.ok(url.includes("code=3c820ebeb0226c5c5661320244d93cd7"));
  const m = encodeQr(url);
  assert.ok(m, "登录 URL 必须能编码（否则用户无法扫码）");
  assert.ok(m.size >= 21 && m.size <= 57);
});

test("renderTerminal: 半块渲染行数 = ceil(n/2)，宽度 = n；无矩阵返回 undefined", () => {
  const m = encodeQr("HELLO");
  const out = renderTerminal(m);
  const lines = out.split("\n");
  const n = m.size + 4; // 2 模块静区 × 2 边
  assert.equal(lines.length, Math.ceil(n / 2));
  assert.equal([...lines[0]].length, n);
  assert.equal(renderTerminal(undefined), undefined);
  assert.equal(renderTerminal({}), undefined);
});
