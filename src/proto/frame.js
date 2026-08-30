// Wire framing for the two serial protocols Xiaomi/Ninebot scooters speak.
//
// Both are the same idea: a 2-byte magic header, a length, routing bytes, a
// command, and a 16-bit little-endian trailer checksum. They differ in what the
// length counts and whether there is a separate source byte.
//
//   M365 family    55 AA <len> <dst> <cmd> <arg> <payload...> <ck_lo> <ck_hi>
//                  len = payload.length + 2   (covers cmd + arg)
//
//   Ninebot / NB   5A A5 <len> <src> <dst> <cmd> <arg> <payload...> <ck_lo> <ck_hi>
//                  len = payload.length
//
// Checksum in both cases is 0xFFFF minus the sum of every byte from <len> up to
// the end of the payload, i.e. the header magic is excluded.
//
// The Mi 4 series (including the 4 Lite) uses NB framing; the frames are then
// wrapped by the encrypted session layer in ../proto/session.js.

import { concatBytes } from '../util.js';

export const Protocol = Object.freeze({
  M365: 'm365',
  NB: 'nb',
});

export const Addr = Object.freeze({
  ESC: 0x20, // motor controller — the interesting one
  BLE: 0x21, // bluetooth module
  BMS: 0x22, // internal battery
  EXT_BMS: 0x23, // external battery, if fitted
  APP: 0x3e, // us
  APP_ALT: 0x3d, // some firmwares expect this as the source
});

export const Cmd = Object.freeze({
  READ: 0x01,
  WRITE: 0x03, // write, no acknowledgement frame
  WRITE_ACK: 0x04, // write, controller replies (not on every firmware)
});

const MAGIC = {
  [Protocol.M365]: [0x55, 0xaa],
  [Protocol.NB]: [0x5a, 0xa5],
};

/** 0xFFFF - sum(bytes), little endian. Shared by both protocols. */
export function checksum(bytes) {
  let sum = 0;
  for (const b of bytes) sum += b;
  const ck = (0xffff - sum) & 0xffff;
  return new Uint8Array([ck & 0xff, (ck >> 8) & 0xff]);
}

/**
 * Build a request frame.
 * @param {object} opts
 * @param {string} opts.protocol      Protocol.M365 | Protocol.NB
 * @param {number} opts.dst           destination address (Addr.*)
 * @param {number} [opts.src]         source address, NB only
 * @param {number} opts.cmd           Cmd.*
 * @param {number} opts.arg           register address
 * @param {Uint8Array} [opts.payload] register value for writes, or a single
 *                                    length byte for reads
 */
export function encode({ protocol, dst, src = Addr.APP, cmd, arg, payload = new Uint8Array(0) }) {
  const magic = MAGIC[protocol];
  if (!magic) throw new Error(`Unknown protocol: ${protocol}`);

  const routing =
    protocol === Protocol.NB ? [payload.length, src, dst, cmd, arg] : [payload.length + 2, dst, cmd, arg];

  const body = concatBytes(new Uint8Array(routing), payload);
  return concatBytes(new Uint8Array(magic), body, checksum(body));
}

/** A read request: payload is the number of bytes we want back. */
export function encodeRead({ protocol, dst = Addr.ESC, src, arg, length }) {
  return encode({ protocol, dst, src, cmd: Cmd.READ, arg, payload: new Uint8Array([length]) });
}

/** A write request: payload is the raw value, usually 2 bytes little-endian. */
export function encodeWrite({ protocol, dst = Addr.ESC, src, arg, value, ack = false }) {
  return encode({
    protocol,
    dst,
    src,
    cmd: ack ? Cmd.WRITE_ACK : Cmd.WRITE,
    arg,
    payload: value,
  });
}

/**
 * Incremental frame parser. BLE hands us 20-byte notification chunks that do
 * not line up with frame boundaries, so we buffer and resync on the magic.
 */
export class FrameParser {
  #buffer = new Uint8Array(0);

  constructor(protocol) {
    this.protocol = protocol;
    this.magic = MAGIC[protocol];
    if (!this.magic) throw new Error(`Unknown protocol: ${protocol}`);
  }

  reset() {
    this.#buffer = new Uint8Array(0);
  }

  /** Feed a chunk, get back zero or more complete frames. */
  push(chunk) {
    this.#buffer = concatBytes(this.#buffer, chunk);
    const frames = [];

    for (;;) {
      const start = this.#findMagic();
      if (start < 0) {
        // Keep one byte in case the buffer ends mid-magic.
        this.#buffer = this.#buffer.slice(Math.max(0, this.#buffer.length - 1));
        break;
      }
      if (start > 0) this.#buffer = this.#buffer.slice(start);

      const frame = this.#tryTake();
      if (!frame) break; // incomplete — wait for more bytes
      frames.push(frame);
    }
    return frames;
  }

  #findMagic() {
    for (let i = 0; i + 1 < this.#buffer.length; i++) {
      if (this.#buffer[i] === this.magic[0] && this.#buffer[i + 1] === this.magic[1]) return i;
    }
    return -1;
  }

  /** Pull one frame off the front of the buffer, or return null if truncated. */
  #tryTake() {
    const buf = this.#buffer;
    if (buf.length < 3) return null;

    const len = buf[2];
    // header(2) + len(1) + routing + payload + checksum(2)
    const routingLen = this.protocol === Protocol.NB ? 4 : 3;
    const payloadLen = this.protocol === Protocol.NB ? len : Math.max(0, len - 2);
    const total = 3 + routingLen + payloadLen + 2;

    if (buf.length < total) return null;

    const body = buf.slice(2, total - 2);
    const expected = checksum(body);
    const actual = buf.slice(total - 2, total);
    const valid = expected[0] === actual[0] && expected[1] === actual[1];

    const frame = decode(this.protocol, buf.slice(0, total), valid);
    this.#buffer = buf.slice(total);
    return frame;
  }
}

/** Turn a complete frame into a structured object. */
export function decode(protocol, raw, checksumOk = true) {
  const isNb = protocol === Protocol.NB;
  return {
    protocol,
    raw,
    checksumOk,
    len: raw[2],
    src: isNb ? raw[3] : Addr.ESC,
    dst: isNb ? raw[4] : raw[3],
    cmd: isNb ? raw[5] : raw[4],
    arg: isNb ? raw[6] : raw[5],
    payload: raw.slice(isNb ? 7 : 6, raw.length - 2),
  };
}
