// Challenge/response auth for the Brightway MCU bootloader.
//
// A faithful port of bw-flasher's keygen.py (ScooterTeam, CC BY-NC-SA 4.0). The
// bootloader sends a 16-byte random challenge; we answer with sign_rand(), which
// expands the chip UID into a 176-byte key schedule using two lookup tables read
// out of the firmware image, then runs ten mixing rounds over the challenge.
//
// This proves to the MCU that we hold a genuine firmware image for it. It is NOT
// the Xiaomi OTA signature — that is a separate, unbroken check on the BLE path.
// This auth is what lets the *wired* bootloader accept a flash at all; it does
// not let a modified image through the BLE module.
//
// Verified byte-for-byte against the Python original in tests/flash.test.js.

const toChar = (b) => (b < 128 ? b : b - 256); // interpret as signed int8
const sign = (b) => b >> 7; // 1 if the signed value is negative, else 0

function genKey(uid, table0, table1) {
  const dst = new Uint8Array(176);
  dst.set(uid.subarray(0, 16));
  const local = new Uint8Array(4);

  for (let j = 16; j < 176; j += 4) {
    // Carry the first 4 bytes of the previous 16-byte block forward.
    dst.copyWithin(j, j - 16, j - 12);

    if (j % 16 !== 0) {
      local.set(dst.subarray(j - 4, j));
    } else {
      // Every 16 bytes, fold in the substitution tables.
      local[0] = table0[dst[j - 3]] ^ table1[j >> 4];
      local[1] = table0[dst[j - 2]];
      local[2] = table0[dst[j - 1]];
      local[3] = table0[dst[j - 4]];
    }
    for (let i = 0; i < 4; i++) dst[j + i] ^= local[i];
  }
  return dst;
}

function xorByteBlocks(dst, src, blockIndex) {
  for (let j = blockIndex * 16; j < (blockIndex + 1) * 16; j++) dst[j % 16] ^= src[j];
}

function manipulateBytes(dst, c = -0x1b) {
  const local = new Uint8Array(5);
  for (let offset = 0; offset < 16; offset += 4) {
    local[0] = dst[offset] ^ dst[offset + 1];
    local[1] = dst[offset + 1] ^ dst[offset + 2];
    local[2] = dst[offset + 2] ^ dst[offset + 3];
    local[3] = dst[offset + 3] ^ dst[offset + 0];
    local[4] = local[0] ^ local[2];

    for (let i = 0; i < 4; i++) {
      dst[offset + i] ^= (local[i] << 1) & 0xff;
      dst[offset + i] ^= (sign(toChar(local[i])) * c) & 0xff;
      dst[offset + i] ^= local[4];
    }
  }
}

function rollBytes(arr, indices) {
  const values = indices.map((i) => arr[i]);
  const rolled = [...values.slice(1), values[0]];
  indices.forEach((index, i) => (arr[index] = rolled[i]));
}

function signRandWithKey(dst, key, table0) {
  for (let block = 0; block < 10; block++) {
    if (block > 0) manipulateBytes(dst);
    xorByteBlocks(dst, key, block);

    for (let outer = 0; outer < 16; outer += 4) {
      for (let inner = 0; inner < 4; inner++) {
        dst[inner + outer] = table0[dst[inner + outer]];
      }
    }
    rollBytes(dst, [1, 5, 9, 13]);
    rollBytes(dst, [2, 10]);
    rollBytes(dst, [3, 15, 11, 7]);
    rollBytes(dst, [6, 14]);
  }
  xorByteBlocks(dst, key, 10);
}

/**
 * Sign a 16-byte challenge.
 * @param {Uint8Array} uid    chip UID (16 bytes)
 * @param {Uint8Array} rand   challenge (16 bytes)
 * @param {Uint8Array} table0 256-byte substitution table (firmware[off0 .. off0+256])
 * @param {Uint8Array} table1 tables for the key schedule (firmware[off1 .. off1+0x20])
 * @returns {Uint8Array} 16-byte response
 */
export function signRand(uid, rand, table0, table1) {
  const key = genKey(uid, table0, table1);
  const dst = Uint8Array.from(rand.subarray(0, 16));
  signRandWithKey(dst, key, table0);
  return dst;
}
