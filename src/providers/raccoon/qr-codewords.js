// raccoon 二维码编码的「码字层」：byte 模式位流 → RS 纠错 → 块切分与交错。
// 只覆盖 byte 模式与版本 1–10（v10-M 容量 213 字节，够装下扫码登录 URL）。
// 纠错级固定为 M（约 15% 冗余）——终端字符画本身易被拍照角度影响，M 是稳妥档。
const DATA_CODEWORDS = [0, 16, 28, 44, 64, 86, 108, 124, 154, 182, 216];

/** 纠错级 M 的块结构（QR 规范表）：每块 ecPerBlock 个纠错码字 + 若干 [块数, 每块数据码字]。 */
const EC_BLOCKS_M = [
  null,
  { ecPerBlock: 10, groups: [[1, 16]] },
  { ecPerBlock: 16, groups: [[1, 28]] },
  { ecPerBlock: 26, groups: [[1, 44]] },
  { ecPerBlock: 18, groups: [[2, 32]] },
  { ecPerBlock: 24, groups: [[2, 43]] },
  { ecPerBlock: 16, groups: [[4, 27]] },
  { ecPerBlock: 18, groups: [[4, 31]] },
  { ecPerBlock: 22, groups: [[2, 38], [2, 39]] },
  { ecPerBlock: 22, groups: [[3, 36], [2, 37]] },
  { ecPerBlock: 26, groups: [[4, 43], [1, 44]] },
];

const GF_EXP = new Uint8Array(512);
const GF_LOG = new Uint8Array(256);
(() => {
  let x = 1;
  for (let i = 0; i < 255; i++) {
    GF_EXP[i] = x;
    GF_LOG[x] = i;
    x <<= 1;
    if (x & 0x100) x ^= 0x11d; // 本原多项式 x^8+x^4+x^3+x^2+1
  }
  for (let i = 255; i < 512; i++) GF_EXP[i] = GF_EXP[i - 255];
})();

const gfMul = (a, b) => (a === 0 || b === 0 ? 0 : GF_EXP[GF_LOG[a] + GF_LOG[b]]);

function polyMul(a, b) {
  const out = new Array(a.length + b.length - 1).fill(0);
  for (let i = 0; i < a.length; i++) for (let j = 0; j < b.length; j++) out[i + j] ^= gfMul(a[i], b[j]);
  return out;
}

/** 生成多项式连乘 (x - α^0)…(x - α^(ecCount-1))，再做多项式除法取余数即纠错码字。 */
function rsEncode(data, ecCount) {
  const gen = qrEcGeneratorPoly(ecCount);
  // qrEcGeneratorPoly 定义在文件末尾（函数声明提升，调用点在前无妨）
  const buf = [...data, ...new Array(ecCount).fill(0)];
  for (let i = 0; i < data.length; i++) {
    const coef = buf[i];
    if (coef === 0) continue;
    for (let j = 0; j < gen.length; j++) buf[i + j] ^= gfMul(gen[j], coef);
  }
  return buf.slice(data.length);
}

/** 选能装下 byteLength 字节的最小版本；超出 v10 容量返回 undefined。 */
export function pickQrVersion(byteLength) {
  for (let version = 1; version <= 10; version++) {
    const capacityBits = DATA_CODEWORDS[version] * 8;
    const overheadBits = 4 + (version <= 9 ? 8 : 16); // 模式指示符 + 字符计数
    if (overheadBits + byteLength * 8 <= capacityBits) return version;
  }
  return undefined;
}

/**
 * byte 模式位流 → 最终码字序列（数据块与纠错块按规范交错）。
 * 位流 = 0100（byte 模式）+ 字符计数 + 数据字节 + 终止符 + 字节对齐 + 0xEC/0x11 补齐。
 */
export function buildQrCodewords(bytes, version) {
  const blocks = EC_BLOCKS_M[version];
  if (!blocks) throw new Error(`不支持的二维码版本 ${version}`);
  const capacityBits = DATA_CODEWORDS[version] * 8;
  const bits = [];
  const pushBits = (value, length) => {
    for (let i = length - 1; i >= 0; i--) bits.push((value >> i) & 1);
  };
  pushBits(4, 4);
  pushBits(bytes.length, version <= 9 ? 8 : 16);
  for (const byte of bytes) pushBits(byte, 8);
  pushBits(0, Math.min(4, capacityBits - bits.length));
  while (bits.length % 8 !== 0) bits.push(0);
  for (let i = 0; bits.length < capacityBits; i++) pushBits([0xec, 0x11][i % 2], 8);

  const dataCodewords = [];
  for (let i = 0; i < bits.length; i += 8) {
    let byte = 0;
    for (let j = 0; j < 8; j++) byte = (byte << 1) | bits[i + j];
    dataCodewords.push(byte);
  }

  const dataBlocks = [];
  const ecBlocks = [];
  let offset = 0;
  for (const [count, perBlock] of blocks.groups) {
    for (let b = 0; b < count; b++) {
      const block = dataCodewords.slice(offset, offset + perBlock);
      offset += perBlock;
      dataBlocks.push(block);
      ecBlocks.push(rsEncode(block, blocks.ecPerBlock));
    }
  }

  const out = [];
  const maxDataLen = Math.max(...dataBlocks.map((b) => b.length));
  for (let i = 0; i < maxDataLen; i++) for (const block of dataBlocks) if (i < block.length) out.push(block[i]);
  for (let i = 0; i < blocks.ecPerBlock; i++) for (const block of ecBlocks) out.push(block[i]);
  return out;
}

/** 纠错生成多项式系数（QR 规范定义）。导出供单测用已知向量锚定 GF 运算。 */
export function qrEcGeneratorPoly(degree) {
  let gen = [1];
  for (let i = 0; i < degree; i++) gen = polyMul(gen, [1, GF_EXP[i]]);
  return gen;
}
