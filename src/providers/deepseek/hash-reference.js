// 可读 FIPS 202 参考实现（BigInt）：24 轮 = 标准 SHA3-256，仅测试对拍用。
// 源自 diegosouzapw/OmniRoute（MIT）clean-room NIST FIPS 202 port。
// 运行时求解用 hash.js 的 Uint32 优化版（keccakP1600Uint32）。

const LANE_MASK = (1n << 64n) - 1n;
const SHA3_256_RATE_BYTES = 136;
const SHA3_DOMAIN_SUFFIX = 0x06;
const SHA3_256_OUTPUT_BYTES = 32;

const ROTATION_OFFSETS = [
  0, 1, 62, 28, 27, 36, 44, 6, 55, 20, 3, 10, 43, 25, 39, 41, 45, 15, 21, 8, 18, 2, 61, 56, 14,
];

const ROUND_CONSTANTS = [
  0x0000000000000001n,
  0x0000000000008082n,
  0x800000000000808an,
  0x8000000080008000n,
  0x000000000000808bn,
  0x0000000080000001n,
  0x8000000080008081n,
  0x8000000000008009n,
  0x000000000000008an,
  0x0000000000000088n,
  0x0000000080008009n,
  0x000000008000000an,
  0x000000008000808bn,
  0x800000000000008bn,
  0x8000000000008089n,
  0x8000000000008003n,
  0x8000000000008002n,
  0x8000000000000080n,
  0x000000000000800an,
  0x800000008000000an,
  0x8000000080008081n,
  0x8000000000008080n,
  0x0000000080000001n,
  0x8000000080008008n,
];

function rotateLeft64(value, amount) {
  if (amount === 0) return value;
  const shift = BigInt(amount);
  return ((value << shift) | (value >> (64n - shift))) & LANE_MASK;
}

function keccakP1600Reference(state, roundCount) {
  const columnParity = new Array(5).fill(0n);
  const thetaMix = new Array(5).fill(0n);
  const rhoPiState = new Array(25).fill(0n);
  const firstRound = ROUND_CONSTANTS.length - roundCount;

  for (let round = firstRound; round < ROUND_CONSTANTS.length; round++) {
    for (let x = 0; x < 5; x++) {
      columnParity[x] = state[x] ^ state[x + 5] ^ state[x + 10] ^ state[x + 15] ^ state[x + 20];
    }
    for (let x = 0; x < 5; x++) {
      thetaMix[x] = columnParity[(x + 4) % 5] ^ rotateLeft64(columnParity[(x + 1) % 5], 1);
    }
    for (let y = 0; y < 5; y++) {
      for (let x = 0; x < 5; x++) state[x + 5 * y] ^= thetaMix[x];
    }
    for (let y = 0; y < 5; y++) {
      for (let x = 0; x < 5; x++) {
        const destinationX = y;
        const destinationY = (2 * x + 3 * y) % 5;
        const lane = x + 5 * y;
        rhoPiState[destinationX + 5 * destinationY] = rotateLeft64(state[lane], ROTATION_OFFSETS[lane]);
      }
    }
    for (let y = 0; y < 5; y++) {
      const row = 5 * y;
      for (let x = 0; x < 5; x++) {
        state[x + row] = rhoPiState[x + row] ^ (~rhoPiState[((x + 1) % 5) + row] & LANE_MASK & rhoPiState[((x + 2) % 5) + row]);
      }
    }
    state[0] ^= ROUND_CONSTANTS[round];
  }
}

function absorbReferenceBlock(state, block, roundCount) {
  for (let index = 0; index < SHA3_256_RATE_BYTES; index++) {
    const lane = Math.floor(index / 8);
    const shift = BigInt((index % 8) * 8);
    state[lane] ^= BigInt(block[index]) << shift;
  }
  keccakP1600Reference(state, roundCount);
}

function sha3_256ReferenceWithRoundCount(input, roundCount) {
  const bytes = new TextEncoder().encode(input);
  const state = new Array(25).fill(0n);
  let offset = 0;

  while (offset + SHA3_256_RATE_BYTES <= bytes.length) {
    absorbReferenceBlock(state, bytes.subarray(offset, offset + SHA3_256_RATE_BYTES), roundCount);
    offset += SHA3_256_RATE_BYTES;
  }

  const finalBlock = new Uint8Array(SHA3_256_RATE_BYTES);
  finalBlock.set(bytes.subarray(offset));
  finalBlock[bytes.length - offset] ^= SHA3_DOMAIN_SUFFIX;
  finalBlock[SHA3_256_RATE_BYTES - 1] ^= 0x80;
  absorbReferenceBlock(state, finalBlock, roundCount);

  const output = new Uint8Array(SHA3_256_OUTPUT_BYTES);
  for (let index = 0; index < output.length; index++) {
    const lane = Math.floor(index / 8);
    const shift = BigInt((index % 8) * 8);
    output[index] = Number((state[lane] >> shift) & 0xffn);
  }
  return Array.from(output, (byte) => byte.toString(16).padStart(2, "0")).join("");
}

export function sha3_256Fips202Reference(input) {
  return sha3_256ReferenceWithRoundCount(input, 24);
}
