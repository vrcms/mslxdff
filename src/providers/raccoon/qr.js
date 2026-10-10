// raccoon 扫码登录用的最小二维码「矩阵层」+ 终端渲染（零依赖，不引入 npm 包）。
// 码字计算在 qr-codewords.js；本文件只负责功能图案、码字摆放、掩码择优与字符画输出。
// 参考：dsh-our-free-model 的 vendor/channel-pack/src/raccoon-qr.ts（同为无依赖自写）。
//
// 与渲染分离：encodeQr() 出矩阵，renderTerminal() 出字符串；任何一步失败都返回 undefined，
// 由调用方退回「只打印 URL」——用户拿不到字符画也必须能登录。
import { buildQrCodewords, pickQrVersion } from "./qr-codewords.js";

/** 掩码条件（QR 规范 8 条），索引即掩码号。 */
function maskBit(mask, x, y) {
  switch (mask) {
    case 0: return (x + y) % 2 === 0;
    case 1: return y % 2 === 0;
    case 2: return x % 3 === 0;
    case 3: return (x + y) % 3 === 0;
    case 4: return (Math.floor(x / 3) + Math.floor(y / 2)) % 2 === 0;
    case 5: return ((x * y) % 2) + ((x * y) % 3) === 0;
    case 6: return (((x * y) % 2) + ((x * y) % 3)) % 2 === 0;
    default: return (((x + y) % 2) + ((x * y) % 3)) % 2 === 0;
  }
}

/** 校正图案中心坐标（规范表算法，与参考实现一致）。 */
function alignmentPositions(version, size) {
  if (version === 1) return [];
  const numAlign = Math.floor(version / 7) + 2;
  const step = Math.ceil((version * 4 + 4) / (numAlign * 2 - 2)) * 2;
  const result = [6];
  for (let pos = size - 7; result.length < numAlign; pos -= step) result.splice(1, 0, pos);
  return result;
}

class Matrix {
  constructor(size) {
    this.size = size;
    this.modules = Array.from({ length: size }, () => new Array(size).fill(false));
    this.isFunction = Array.from({ length: size }, () => new Array(size).fill(false));
  }

  set(x, y, dark) {
    this.modules[y][x] = dark;
    this.isFunction[y][x] = true;
  }

  drawFunctionPatterns(version) {
    const { size } = this;
    for (let i = 0; i < size; i++) {
      this.set(6, i, i % 2 === 0); // 竖向定时
      this.set(i, 6, i % 2 === 0); // 横向定时
    }
    for (const [x, y] of [[3, 3], [size - 4, 3], [3, size - 4]]) this.drawFinder(x, y);
    const positions = alignmentPositions(version, size);
    const n = positions.length;
    for (let i = 0; i < n; i++) {
      for (let j = 0; j < n; j++) {
        const isCorner = (i === 0 && j === 0) || (i === 0 && j === n - 1) || (i === n - 1 && j === 0);
        if (!isCorner) this.drawAlignment(positions[i], positions[j]);
      }
    }
    this.drawFormatBits(0); // 占位；掩码定下后重画
    if (version >= 7) this.drawVersionBits(version);
  }

  /** 定位图案含分隔带：切比雪夫距离 2 与 4 处为白，其余为黑（参考实现同款判据）。 */
  drawFinder(cx, cy) {
    for (let dy = -4; dy <= 4; dy++) {
      for (let dx = -4; dx <= 4; dx++) {
        const x = cx + dx;
        const y = cy + dy;
        if (x < 0 || x >= this.size || y < 0 || y >= this.size) continue;
        const dist = Math.max(Math.abs(dx), Math.abs(dy));
        this.set(x, y, dist !== 2 && dist !== 4);
      }
    }
  }

  drawAlignment(cx, cy) {
    for (let dy = -2; dy <= 2; dy++) {
      for (let dx = -2; dx <= 2; dx++) this.set(cx + dx, cy + dy, Math.max(Math.abs(dx), Math.abs(dy)) !== 1);
    }
  }

  /** 格式信息：纠错级 M 的格式位 = 00，BCH(15,5) 校验 + 固定掩码 0x5412，两处各写一份。 */
  drawFormatBits(mask) {
    const data = (0 << 3) | mask;
    let rem = data;
    for (let i = 0; i < 10; i++) rem = (rem << 1) ^ ((rem >>> 9) * 0x537);
    const bits = ((data << 10) | rem) ^ 0x5412;
    const bit = (i) => ((bits >> i) & 1) === 1;
    for (let i = 0; i <= 5; i++) this.set(8, i, bit(i));
    this.set(8, 7, bit(6));
    this.set(8, 8, bit(7));
    this.set(7, 8, bit(8));
    for (let i = 9; i < 15; i++) this.set(14 - i, 8, bit(i));
    for (let i = 0; i < 8; i++) this.set(this.size - 1 - i, 8, bit(i));
    for (let i = 8; i < 15; i++) this.set(8, this.size - 15 + i, bit(i));
    this.set(8, this.size - 8, true); // 固定黑模块
  }

  drawVersionBits(version) {
    let rem = version;
    for (let i = 0; i < 12; i++) rem = (rem << 1) ^ ((rem >>> 11) * 0x1f25);
    const bits = (version << 12) | rem;
    for (let i = 0; i < 18; i++) {
      const dark = ((bits >> i) & 1) === 1;
      const a = this.size - 11 + (i % 3);
      const b = Math.floor(i / 3);
      this.set(a, b, dark);
      this.set(b, a, dark);
    }
  }

  /** 码字按「自右向左、上下往复」的之字形填入非功能模块（跳过第 6 列定时线）。 */
  drawCodewords(codewords) {
    let i = 0;
    for (let right = this.size - 1; right >= 1; right -= 2) {
      if (right === 6) right = 5;
      for (let vert = 0; vert < this.size; vert++) {
        for (let j = 0; j < 2; j++) {
          const x = right - j;
          const upward = ((right + 1) & 2) === 0;
          const y = upward ? this.size - 1 - vert : vert;
          if (!this.isFunction[y][x] && i < codewords.length * 8) {
            this.modules[y][x] = ((codewords[i >>> 3] >> (7 - (i & 7))) & 1) === 1;
            i++;
          }
        }
      }
    }
  }

  applyMask(mask) {
    for (let y = 0; y < this.size; y++) {
      for (let x = 0; x < this.size; x++) {
        if (!this.isFunction[y][x] && maskBit(mask, x, y)) this.modules[y][x] = !this.modules[y][x];
      }
    }
  }

  clone() {
    const m = new Matrix(this.size);
    for (let y = 0; y < this.size; y++) {
      m.modules[y] = [...this.modules[y]];
      m.isFunction[y] = [...this.isFunction[y]];
    }
    return m;
  }

  /**
   * 掩码惩罚分（N1 同色连跑 / N2 2×2 同色块 / N4 黑白失衡）。
   * 规范里的 N3（类定位图案）未实现：它只影响选掩码的偏好、不影响码的正确性，
   * 省下的复杂度换更小的文件体积；本用途（终端展示的短 URL）实测不影响识别。
   */
  penalty() {
    let score = 0;
    const { size } = this;
    for (let y = 0; y < size; y++) {
      let run = 1;
      for (let x = 1; x < size; x++) {
        if (this.modules[y][x] === this.modules[y][x - 1]) run++;
        else { if (run >= 5) score += 3 + (run - 5); run = 1; }
      }
      if (run >= 5) score += 3 + (run - 5);
    }
    for (let x = 0; x < size; x++) {
      let run = 1;
      for (let y = 1; y < size; y++) {
        if (this.modules[y][x] === this.modules[y - 1][x]) run++;
        else { if (run >= 5) score += 3 + (run - 5); run = 1; }
      }
      if (run >= 5) score += 3 + (run - 5);
    }
    for (let y = 0; y < size - 1; y++) {
      for (let x = 0; x < size - 1; x++) {
        const c = this.modules[y][x];
        if (c === this.modules[y][x + 1] && c === this.modules[y + 1][x] && c === this.modules[y + 1][x + 1]) score += 3;
      }
    }
    let dark = 0;
    for (let y = 0; y < size; y++) for (let x = 0; x < size; x++) if (this.modules[y][x]) dark++;
    const total = size * size;
    score += (Math.ceil(Math.abs(dark * 20 - total * 10) / total) - 1) * 10;
    return score;
  }
}

/** 文本 → 二维码矩阵；过长或任何异常返回 undefined（调用方退回打印 URL）。 */
export function encodeQr(text) {
  try {
    const bytes = [...Buffer.from(String(text), "utf8")];
    const version = pickQrVersion(bytes.length);
    if (version === undefined) return undefined;
    const codewords = buildQrCodewords(bytes, version);
    const base = new Matrix(version * 4 + 17);
    base.drawFunctionPatterns(version);
    base.drawCodewords(codewords);
    let best;
    let bestScore = Infinity;
    for (let mask = 0; mask < 8; mask++) {
      const candidate = base.clone();
      candidate.applyMask(mask);
      candidate.drawFormatBits(mask);
      const score = candidate.penalty();
      if (score < bestScore) { bestScore = score; best = candidate; }
    }
    return best;
  } catch {
    return undefined;
  }
}

/**
 * 矩阵 → 终端字符画（半块字符，1 字符宽 / 2 模块高），含 2 模块静区。
 * 用 ▀▄█ 而非双宽全块：同样的可扫性下把宽度砍半，窄终端也放得下。
 */
export function renderTerminal(matrix, { quiet = 2 } = {}) {
  if (!matrix?.modules?.length) return undefined;
  const size = matrix.size;
  const n = size + quiet * 2;
  const dark = (x, y) => {
    const mx = x - quiet;
    const my = y - quiet;
    return mx >= 0 && mx < size && my >= 0 && my < size ? Boolean(matrix.modules[my][mx]) : false;
  };
  const lines = [];
  for (let y = 0; y < n; y += 2) {
    let line = "";
    for (let x = 0; x < n; x++) {
      const top = dark(x, y);
      const bottom = y + 1 < n ? dark(x, y + 1) : false;
      line += top && bottom ? "█" : top ? "▀" : bottom ? "▄" : " ";
    }
    lines.push(line);
  }
  return lines.join("\n");
}
