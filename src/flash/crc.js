// The two checksums the Brightway DFU protocol uses.
//
// crc16 is CRC-CCITT (XModem): polynomial 0x1021, initial value 0x0000, no bit
// reflection — the same as Python's binascii.crc_hqx(data, 0). It guards every
// 128-byte chunk on the wire.
//
// crc32 is the standard reflected IEEE/zlib CRC (binascii.crc32), sent once over
// everything written, at wr_info time.

export function crc16(data) {
  let crc = 0x0000;
  for (const byte of data) {
    crc ^= byte << 8;
    for (let i = 0; i < 8; i++) {
      crc = crc & 0x8000 ? ((crc << 1) ^ 0x1021) & 0xffff : (crc << 1) & 0xffff;
    }
  }
  return crc & 0xffff;
}

const CRC32_TABLE = (() => {
  const table = new Uint32Array(256);
  for (let n = 0; n < 256; n++) {
    let c = n;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    table[n] = c >>> 0;
  }
  return table;
})();

export function crc32(data) {
  let crc = 0xffffffff;
  for (const byte of data) crc = CRC32_TABLE[(crc ^ byte) & 0xff] ^ (crc >>> 8);
  return (crc ^ 0xffffffff) >>> 0;
}
