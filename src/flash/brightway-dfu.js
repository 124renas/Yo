// Brightway MCU firmware-update (DFU) protocol.
//
// A faithful port of ScooterTeam's bw-flasher (CC BY-NC-SA 4.0), restructured to
// be transport-agnostic: it drives an async { write(bytes), readUntil(...) }
// link, so the same state machine runs over a Web Serial port on real hardware
// or over the in-memory simulator in ./mock-mcu.js.
//
// The flow, once connected to the bootloader over the wired UART:
//   UID       fetch the chip UID (seeds the auth)
//   VER_INIT  read the running MCU version
//   INIT      rd_info handshake
//   BLE_RAND  send our challenge, check the MCU's answer proves it is genuine
//   MCU_RAND  receive the MCU's challenge
//   MCU_KEY   answer it (signRand) — this authorises the flash
//   then per 2 KB packet: nvm_write -> stream 16x128-byte chunks (CRC16 each)
//     -> wr_info (running CRC32)
//   DFU_VERIFY / DFU_ACTIVE  commit and boot the new image
//
// This authenticates to the *wired* bootloader. It is not, and cannot be, the
// Xiaomi OTA signature that gates the Bluetooth path — that check is unbroken,
// which is exactly why flashing a modified image has to go over the wire.

import { crc16, crc32 } from './crc.js';
import { signRand } from './keygen.js';

export class FlasherError extends Error {
  constructor(message) {
    super(message);
    this.name = 'FlasherError';
  }
}

export const DFUState = Object.freeze({
  UID: 'UID', VER_INIT: 'VER_INIT', INIT: 'INIT', BLE_RAND: 'BLE_RAND',
  MCU_RAND: 'MCU_RAND', MCU_KEY: 'MCU_KEY', NVM_WRITE: 'NVM_WRITE', SEND_FW: 'SEND_FW',
  WR_INFO: 'WR_INFO', DFU_VERIFY: 'DFU_VERIFY', DFU_ACTIVE: 'DFU_ACTIVE',
  VER_DONE: 'VER_DONE', DONE: 'DONE',
});

const PACKET_SIZE = 0x800;
const CHUNK_SIZE = 0x80;
const CHUNKS_PER_PACKET = PACKET_SIZE / CHUNK_SIZE;
const MAX_REPEATS = 20;

const enc = (s) => new TextEncoder().encode(s);
const concat = (...parts) => {
  const total = parts.reduce((n, p) => n + p.length, 0);
  const out = new Uint8Array(total);
  let o = 0;
  for (const p of parts) { out.set(p, o); o += p.length; }
  return out;
};
const startsWith = (buf, s) => {
  const b = enc(s);
  return b.every((v, i) => buf[i] === v);
};
const includesByte = (buf, byte) => buf.includes(byte);
const indexOfByte = (buf, byte) => buf.indexOf(byte);

/** Search a byte pattern (given as a hex string) in a buffer, returning all offsets. */
function findPatternOffsets(hexPattern, data, start = 0) {
  const pat = Uint8Array.from(hexPattern.match(/../g), (b) => parseInt(b, 16));
  const offsets = [];
  for (let i = start; i <= data.length - pat.length; i++) {
    let match = true;
    for (let j = 0; j < pat.length; j++) if (data[i + j] !== pat[j]) { match = false; break; }
    if (match) offsets.push(i);
  }
  return offsets;
}

/** Recognise a Brightway image and locate its two auth lookup tables. */
export function inspectFirmware(fw) {
  const info = { type: 'unknown', size: fw.length, offsets: null, model: null };

  if (fw.length > 0x808) {
    const sig = fw.subarray(0x800, 0x808);
    if (enc('DEPRD5C\x00').every((v, i) => sig[i] === v)) info.type = 'brightway';
  }

  const o637c = findPatternOffsets('637c', fw);
  if (info.type !== 'brightway' && o637c.length === 1 && o637c[0] > 0x1000) info.type = 'brightway';

  // The model id is ASCII near the header on most images; purely informational.
  for (const at of [0x100, 0x400]) {
    const raw = fw.subarray(at, at + 14);
    if (raw.every((b) => b >= 0x20 && b < 0x7f)) { info.model = new TextDecoder().decode(raw).trim(); break; }
  }

  if (o637c.length === 1) {
    const o0102 = findPatternOffsets('0102', fw, o637c[0]);
    if (o0102.length === 1) info.offsets = [o637c[0], o0102[0] - 1];
  }
  return info;
}

export class BrightwayDFU {
  /**
   * @param {object} link            { write(bytes), readUntil(byte, maxBytes, timeoutMs) }
   * @param {Uint8Array} firmware    the (patched) image to flash
   * @param {object} [handlers]      { onState, onProgress, onLog }
   */
  constructor(link, firmware, { onState, onProgress, onLog } = {}) {
    this.link = link;
    this.fw = firmware;
    this.onState = onState ?? (() => {});
    this.onProgress = onProgress ?? (() => {});
    this.onLog = onLog ?? (() => {});

    const info = inspectFirmware(firmware);
    if (info.type !== 'brightway') {
      throw new FlasherError('This does not look like a Brightway MCU image — refusing to flash it.');
    }
    if (!info.offsets) throw new FlasherError('Could not locate the auth tables in this firmware.');
    this.info = info;
    this.fwOffsets = info.offsets;

    this.state = DFUState.UID;
    this.prevState = null;
    this.uid = null;
    this.mcuRand = null;
    this.bleRand = Uint8Array.from({ length: 16 }, (_, i) => i + 1);
    this.packet = null;
    this.dataSent = new Uint8Array(0);
    this.nPacketsSent = 0;
    this.totalPackets = Math.ceil(firmware.length / PACKET_SIZE);
  }

  #log(...m) { this.onLog(m.join(' ')); }
  #table(which) {
    const [o0, o1] = this.fwOffsets;
    return which === 0 ? this.fw.subarray(o0, o0 + 256) : this.fw.subarray(o1, o1 + 0x20);
  }
  #sign(rand) { return signRand(this.uid, rand, this.#table(0), this.#table(1)); }

  #emitState(text) {
    if (this.prevState !== this.state) this.onState(this.state, text);
    this.prevState = this.state;
  }
  #emitProgress() {
    this.onProgress(Math.min(100, Math.round((this.nPacketsSent / this.totalPackets) * 100)));
  }

  /** Run to completion. Rejects (without committing) on any protocol error. */
  async run() {
    while (this.state !== DFUState.DONE) {
      switch (this.state) {
        case DFUState.UID: this.#emitState('Fetching UID'); await this.#getUid(); break;
        case DFUState.VER_INIT: this.#emitState('Reading version'); await this.#getVer(); break;
        case DFUState.INIT: this.#emitState('rd_info'); await this.#rdInfo(); break;
        case DFUState.BLE_RAND: this.#emitState('Auth: sending challenge'); await this.#bleRand(); break;
        case DFUState.MCU_RAND: this.#emitState('Auth: receiving challenge'); await this.#reqMcuRand(); break;
        case DFUState.MCU_KEY: this.#emitState('Auth: answering'); await this.#mcuKey(); break;
        case DFUState.NVM_WRITE: this.#emitState('Erasing / addressing'); await this.#nvmWrite(); break;
        case DFUState.SEND_FW: this.#emitState('Writing firmware'); await this.#sendFwPacket(); break;
        case DFUState.WR_INFO: this.#emitState('Confirming block'); await this.#wrInfo(); break;
        case DFUState.DFU_VERIFY: this.#emitState('Verifying'); await this.#verify(); break;
        case DFUState.DFU_ACTIVE: this.#emitState('Activating'); await this.#activate(); break;
        case DFUState.VER_DONE: this.#emitState('Re-reading version'); await this.#getVer(); break;
        default: throw new FlasherError(`Unknown state ${this.state}`);
      }
      this.#emitProgress();
    }
    this.#emitState('Done');
  }

  /** Confirm the bootloader is actually answering before committing to a flash. */
  async testConnection() {
    let retries = 0;
    while (this.state !== DFUState.INIT) {
      if (this.state !== this.prevState) retries = 0;
      if (retries >= MAX_REPEATS) throw new FlasherError('No response from the controller. Check wiring and that it is powered on.');
      if (this.state === DFUState.UID) { this.#emitState('Fetching UID'); await this.#getUid(); }
      else if (this.state === DFUState.VER_INIT) { this.#emitState('Reading version'); await this.#getVer(); }
      retries++;
    }
    this.#log('Connected to bootloader.');
    return true;
  }

  async #send(bytes) { await this.link.write(bytes); }
  async #recv(n, endByte = 0x0d) { return this.link.readUntil(endByte, n); }

  async #getUid() {
    await this.#send(Uint8Array.from([0x53, 0x2a, 0x7d, 0xac]));
    const res = await this.#recv(21, 0x9b);
    const start = indexOfByte(res, 0x64), end = indexOfByte(res, 0x9b);
    if (start >= 0 && end >= 0) {
      const body = res.subarray(start, end);
      if (body[1] === 0x2a && body[2] === 0x10) {
        this.uid = body.subarray(3, 3 + 0x10);
        this.#log('UID:', new TextDecoder().decode(this.uid).replace(/[^\x20-\x7e]/g, '.'));
        this.state = DFUState.VER_INIT;
      }
    }
  }

  async #getVer() {
    await this.#send(enc('down get_ver\r'));
    const res = await this.#recv(5);
    if (includesByte(res.subarray(-2), 0x0d)) {
      const ver = new TextDecoder().decode(res).split('\r')[0];
      if (this.state === DFUState.VER_INIT) { this.#log('MCU version (before):', ver); this.state = DFUState.INIT; }
      else if (this.state === DFUState.VER_DONE) { this.#log('MCU version (after):', ver); this.state = DFUState.DONE; }
    }
  }

  async #rdInfo() {
    await this.#send(concat(enc('down rd_info\r'), Uint8Array.of(0, 0, 0)));
    const res = await this.#recv(26);
    if (startsWith(res, 'ok')) this.state = DFUState.BLE_RAND;
  }

  async #bleRand() {
    const expected = this.#sign(this.bleRand);
    await this.#send(concat(enc('down ble_rand '), this.bleRand, enc('\r')));
    const res = await this.#recv(20);
    if (startsWith(res, 'ok')) {
      const bleKey = res.subarray(3, 19);
      if (!bleKey.every((v, i) => v === expected[i])) {
        throw new FlasherError('Auth mismatch (BLE_KEY). Wrong firmware for this controller, or a bad UID read.');
      }
      this.state = DFUState.MCU_RAND;
    }
  }

  async #reqMcuRand() {
    await this.#send(enc('down mcu_rand\r'));
    const res = await this.#recv(20);
    if (startsWith(res, 'ok')) { this.mcuRand = Uint8Array.from(res.subarray(3, 19)); this.state = DFUState.MCU_KEY; }
  }

  async #mcuKey() {
    const key = this.#sign(this.mcuRand);
    await this.#send(concat(enc('down mcu_key '), key, enc('\r')));
    const res = await this.#recv(3);
    if (new TextDecoder().decode(res) === 'ok\r') this.state = DFUState.NVM_WRITE;
  }

  async #nvmWrite() {
    const start = this.nPacketsSent * PACKET_SIZE;
    this.packet = this.fw.subarray(start, start + PACKET_SIZE);
    const loc = (this.nPacketsSent * PACKET_SIZE).toString(16).toUpperCase().padStart(8, '0');
    await this.#send(concat(enc(`down nvm_write ${loc}`), enc('\r')));
    const res = await this.#recv(3);
    if (includesByte(res, 0x6b) && includesByte(res, 0x0d)) this.state = DFUState.SEND_FW; // 'k\r'
  }

  async #sendFwPacket() {
    if (this.packet && this.packet.length) {
      let packet = this.packet;
      if (packet.length < PACKET_SIZE) packet = concat(packet, new Uint8Array(PACKET_SIZE - packet.length).fill(0xff));

      for (let n = 0; n < CHUNKS_PER_PACKET; n++) {
        const chunk = packet.subarray(n * CHUNK_SIZE, (n + 1) * CHUNK_SIZE);
        const N = (n + 1) & 0xff;
        const crc = crc16(chunk);
        const frame = concat(Uint8Array.of(0x01, N, (0xff - N) & 0xff), chunk, Uint8Array.of((crc >> 8) & 0xff, crc & 0xff));

        let acked = false;
        for (let repeat = 0; repeat < MAX_REPEATS; repeat++) {
          await this.#send(frame);
          const res = await this.#recv(1, 0x06);
          if (res.length && res[res.length - 1] === 0x06) { acked = true; break; }
          if (res.length && res[res.length - 1] === 0x15) throw new FlasherError(`CRC rejected on chunk ${n + 1}. Aborting before any commit.`);
        }
        if (!acked) throw new FlasherError(`No ACK after ${MAX_REPEATS} tries. Check the adapter and that the right firmware is selected.`);
      }
      this.packet = packet;
    }

    await this.#send(Uint8Array.of(0x04, 0x04, 0x04));
    await this.#recv(3, 0x06);

    this.nPacketsSent++;
    this.dataSent = concat(this.dataSent, this.packet ?? new Uint8Array(0));
    this.state = DFUState.WR_INFO;
  }

  async #wrInfo() {
    const crc = crc32(this.dataSent).toString(16).padStart(8, '0');
    const cmd = `down wr_info ${this.nPacketsSent} ${crc} ${this.nPacketsSent * PACKET_SIZE}\r`;
    await this.#send(enc(cmd));
    const res = await this.#recv(3);
    if (includesByte(res, 0x6b) && includesByte(res, 0x0d)) {
      const more = this.nPacketsSent * PACKET_SIZE < this.fw.length;
      this.state = more ? DFUState.NVM_WRITE : DFUState.DFU_VERIFY;
    }
  }

  async #verify() {
    await this.#send(enc('down dfu_verify\r'));
    const res = await this.#recv(3);
    if (includesByte(res, 0x6b) && includesByte(res, 0x0d)) this.state = DFUState.DFU_ACTIVE;
    else if (includesByte(res, 0x72) && includesByte(res, 0x0d)) throw new FlasherError('Verify failed — the controller did not accept the image. It keeps the old firmware.');
  }

  async #activate() {
    await this.#send(enc('down dfu_active\r'));
    const res = await this.#recv(3);
    if (includesByte(res, 0x6b) && includesByte(res, 0x0d)) { this.#log('Firmware update completed.'); this.state = DFUState.VER_DONE; }
    else if (includesByte(res, 0x72) && includesByte(res, 0x0d)) throw new FlasherError('Activate failed.');
  }
}

export { PACKET_SIZE, CHUNK_SIZE, CHUNKS_PER_PACKET };
