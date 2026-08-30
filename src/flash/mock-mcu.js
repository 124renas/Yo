// In-memory Brightway bootloader, for exercising the flasher without hardware.
//
// It implements the *device* side of the same protocol: parses each command,
// validates chunk CRC16s, runs the challenge/response auth against the firmware
// tables (so a wrong port of signRand fails here too), and reassembles the image
// it receives. The test in tests/flash-e2e.test.js flashes through it and checks
// the bytes that arrive equal the bytes sent.

import { crc16 } from './crc.js';
import { signRand } from './keygen.js';
import { inspectFirmware } from './brightway-dfu.js';

const enc = (s) => new TextEncoder().encode(s);
const dec = (b) => new TextDecoder().decode(b);
const concat = (...ps) => { const o = new Uint8Array(ps.reduce((n, p) => n + p.length, 0)); let k = 0; for (const p of ps) { o.set(p, k); k += p.length; } return o; };

export class MockMcuLink {
  constructor(firmware, { version = '0010', uid = 'MOCKMCU000000000' } = {}) {
    this.fw = firmware;
    this.version = version;
    this.uid = enc(uid).subarray(0, 16);
    const info = inspectFirmware(firmware);
    this.tables = [firmware.subarray(info.offsets[0], info.offsets[0] + 256), firmware.subarray(info.offsets[1], info.offsets[1] + 0x20)];
    this.mcuRand = Uint8Array.from({ length: 16 }, (_, i) => (i * 7 + 3) & 0xff);
    this.out = [];
    this.readPos = 0;
    this.received = [];   // reassembled firmware
    this.activated = false;
  }

  #reply(bytes) { for (const b of bytes) this.out.push(b); }

  async write(bytes) {
    const b = Uint8Array.from(bytes);

    if (b.length === 4 && b[0] === 0x53 && b[1] === 0x2a && b[2] === 0x7d && b[3] === 0xac) {
      this.#reply(concat(Uint8Array.of(0x64, 0x2a, 0x10), this.uid, Uint8Array.of(0x10, 0x9b)));
      return;
    }

    // A single-chunk data frame: 01 N N_ <128 bytes> crc_hi crc_lo
    if (b[0] === 0x01 && b.length === 3 + 0x80 + 2) {
      const data = b.subarray(3, 3 + 0x80);
      const crc = (b[b.length - 2] << 8) | b[b.length - 1];
      if (crc !== crc16(data)) { this.#reply([0x15]); return; }
      this._chunkAccum = concat(this._chunkAccum ?? new Uint8Array(0), data);
      this.#reply([0x06]);
      return;
    }
    if (b.length === 3 && b[0] === 0x04 && b[1] === 0x04 && b[2] === 0x04) { this.#reply([0x06]); return; }

    const text = dec(b);
    if (text.startsWith('down get_ver')) { this.#reply(enc(this.version + '\r')); return; }
    if (text.startsWith('down rd_info')) { this.#reply(enc('ok' + ' '.repeat(23) + '\r')); return; }

    if (text.startsWith('down ble_rand ')) {
      const rand = b.subarray(enc('down ble_rand ').length, enc('down ble_rand ').length + 16);
      const key = signRand(this.uid, rand, this.tables[0], this.tables[1]);
      this.#reply(concat(enc('ok '), key, enc('\r')));
      return;
    }
    if (text.startsWith('down mcu_rand')) { this.#reply(concat(enc('ok '), this.mcuRand, enc('\r'))); return; }
    if (text.startsWith('down mcu_key ')) {
      const key = b.subarray(enc('down mcu_key ').length, enc('down mcu_key ').length + 16);
      const expected = signRand(this.uid, this.mcuRand, this.tables[0], this.tables[1]);
      this.#reply(enc(key.every((v, i) => v === expected[i]) ? 'ok\r' : 'er\r'));
      return;
    }
    if (text.startsWith('down nvm_write')) { this._chunkAccum = new Uint8Array(0); this.#reply(enc('ok\r')); return; }
    if (text.startsWith('down wr_info')) {
      if (this._chunkAccum?.length) { this.received.push(this._chunkAccum); this._chunkAccum = new Uint8Array(0); }
      this.#reply(enc('ok\r'));
      return;
    }
    if (text.startsWith('down dfu_verify')) { this.#reply(enc('ok\r')); return; }
    if (text.startsWith('down dfu_active')) { this.activated = true; this.#reply(enc('ok\r')); return; }
  }

  async readUntil(endByte, maxBytes) {
    // Mirror pyserial's read_until(end)[-n:]: scan to endByte, return the tail.
    let end = -1;
    for (let i = this.readPos; i < this.out.length; i++) if (this.out[i] === endByte) { end = i; break; }
    const stop = end >= 0 ? end + 1 : this.out.length;
    const slice = this.out.slice(this.readPos, stop);
    this.readPos = stop;
    const tail = slice.slice(Math.max(0, slice.length - maxBytes));
    return Uint8Array.from(tail);
  }

  /** The image as the device reassembled it, trimmed to the original length. */
  flashedImage(originalLength) {
    return concat(...this.received).subarray(0, originalLength);
  }
}
