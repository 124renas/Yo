// Compact AES-128/192/256 block cipher + the modes the scooter link needs.
//
// WebCrypto deliberately omits ECB and forces PKCS#7 padding on CBC, but the
// Ninebot session layer uses raw, unpadded blocks. Rather than bend WebCrypto
// into shape with counter-block tricks that only work one direction, this is a
// self-contained implementation. Verified against the FIPS-197 vectors in
// tests/aes.test.js.

const SBOX = new Uint8Array(256);
const INV_SBOX = new Uint8Array(256);
const RCON = new Uint8Array([0x8d, 0x01, 0x02, 0x04, 0x08, 0x10, 0x20, 0x40, 0x80, 0x1b, 0x36, 0x6c, 0xd8, 0xab, 0x4d]);

(function buildTables() {
  // Multiplicative inverse in GF(2^8) via log/antilog tables over generator 3.
  const log = new Uint8Array(256);
  const alog = new Uint8Array(256);
  let x = 1;
  for (let i = 0; i < 255; i++) {
    alog[i] = x;
    log[x] = i;
    x ^= (x << 1) ^ (x & 0x80 ? 0x11b : 0); // x * 3 in GF(2^8)
    x &= 0xff;
  }
  for (let i = 0; i < 256; i++) {
    const inv = i === 0 ? 0 : alog[(255 - log[i]) % 255]; // the log table cycles mod 255
    let s = inv;
    let acc = inv;
    for (let t = 0; t < 4; t++) {
      acc = ((acc << 1) | (acc >>> 7)) & 0xff;
      s ^= acc;
    }
    s ^= 0x63;
    SBOX[i] = s;
    INV_SBOX[s] = i;
  }
})();

const xtime = (a) => ((a << 1) ^ (a & 0x80 ? 0x1b : 0)) & 0xff;

function mul(a, b) {
  let result = 0;
  while (b) {
    if (b & 1) result ^= a;
    a = xtime(a);
    b >>= 1;
  }
  return result & 0xff;
}

function expandKey(key) {
  const nk = key.length / 4;
  if (![4, 6, 8].includes(nk)) throw new Error('AES key must be 16, 24 or 32 bytes');
  const nr = nk + 6;
  const w = new Uint8Array(16 * (nr + 1));
  w.set(key);

  for (let i = nk; i < 4 * (nr + 1); i++) {
    let t = w.slice((i - 1) * 4, i * 4);
    if (i % nk === 0) {
      t = new Uint8Array([SBOX[t[1]] ^ RCON[i / nk], SBOX[t[2]], SBOX[t[3]], SBOX[t[0]]]);
    } else if (nk > 6 && i % nk === 4) {
      t = new Uint8Array([SBOX[t[0]], SBOX[t[1]], SBOX[t[2]], SBOX[t[3]]]);
    }
    for (let j = 0; j < 4; j++) w[i * 4 + j] = w[(i - nk) * 4 + j] ^ t[j];
  }
  return { w, nr };
}

function addRoundKey(state, w, round) {
  for (let i = 0; i < 16; i++) state[i] ^= w[round * 16 + i];
}

function shiftRows(s, inverse) {
  const out = s.slice();
  for (let r = 1; r < 4; r++) {
    for (let c = 0; c < 4; c++) {
      const from = inverse ? (c - r + 4) % 4 : (c + r) % 4;
      out[c * 4 + r] = s[from * 4 + r];
    }
  }
  s.set(out);
}

function mixColumns(s, inverse) {
  const m = inverse ? [14, 11, 13, 9] : [2, 3, 1, 1];
  for (let c = 0; c < 4; c++) {
    const col = s.slice(c * 4, c * 4 + 4);
    for (let r = 0; r < 4; r++) {
      s[c * 4 + r] =
        mul(col[0], m[(0 - r + 4) % 4]) ^
        mul(col[1], m[(1 - r + 4) % 4]) ^
        mul(col[2], m[(2 - r + 4) % 4]) ^
        mul(col[3], m[(3 - r + 4) % 4]);
    }
  }
}

/** Encrypt exactly one 16-byte block. */
export function encryptBlock(block, schedule) {
  const s = Uint8Array.from(block);
  addRoundKey(s, schedule.w, 0);
  for (let round = 1; round < schedule.nr; round++) {
    for (let i = 0; i < 16; i++) s[i] = SBOX[s[i]];
    shiftRows(s, false);
    mixColumns(s, false);
    addRoundKey(s, schedule.w, round);
  }
  for (let i = 0; i < 16; i++) s[i] = SBOX[s[i]];
  shiftRows(s, false);
  addRoundKey(s, schedule.w, schedule.nr);
  return s;
}

/** Decrypt exactly one 16-byte block. */
export function decryptBlock(block, schedule) {
  const s = Uint8Array.from(block);
  addRoundKey(s, schedule.w, schedule.nr);
  for (let round = schedule.nr - 1; round > 0; round--) {
    shiftRows(s, true);
    for (let i = 0; i < 16; i++) s[i] = INV_SBOX[s[i]];
    addRoundKey(s, schedule.w, round);
    mixColumns(s, true);
  }
  shiftRows(s, true);
  for (let i = 0; i < 16; i++) s[i] = INV_SBOX[s[i]];
  addRoundKey(s, schedule.w, 0);
  return s;
}

export class Aes {
  constructor(key) {
    this.schedule = expandKey(key);
  }

  #eachBlock(data, fn) {
    if (data.length % 16 !== 0) throw new Error('Input must be a multiple of 16 bytes (no padding is applied)');
    const out = new Uint8Array(data.length);
    for (let off = 0; off < data.length; off += 16) {
      out.set(fn(data.subarray(off, off + 16), off), off);
    }
    return out;
  }

  ecbEncrypt(data) {
    return this.#eachBlock(data, (b) => encryptBlock(b, this.schedule));
  }

  ecbDecrypt(data) {
    return this.#eachBlock(data, (b) => decryptBlock(b, this.schedule));
  }

  cbcEncrypt(data, iv) {
    let prev = Uint8Array.from(iv);
    return this.#eachBlock(data, (block) => {
      const x = block.map((v, i) => v ^ prev[i]);
      prev = encryptBlock(x, this.schedule);
      return prev;
    });
  }

  cbcDecrypt(data, iv) {
    let prev = Uint8Array.from(iv);
    return this.#eachBlock(data, (block) => {
      const plain = decryptBlock(block, this.schedule).map((v, i) => v ^ prev[i]);
      prev = Uint8Array.from(block);
      return plain;
    });
  }

  /** CTR is its own inverse; the same call encrypts and decrypts. */
  ctrCrypt(data, nonce) {
    const counter = Uint8Array.from(nonce);
    const out = new Uint8Array(data.length);
    for (let off = 0; off < data.length; off += 16) {
      const stream = encryptBlock(counter, this.schedule);
      for (let i = 0; i < 16 && off + i < data.length; i++) out[off + i] = data[off + i] ^ stream[i];
      for (let i = 15; i >= 0; i--) if (++counter[i] !== 0) break; // big-endian increment
    }
    return out;
  }
}
