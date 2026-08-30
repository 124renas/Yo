// Register map.
//
// READ THIS BEFORE TRUSTING AN ADDRESS.
//
// Every entry carries a `confidence`:
//
//   'documented'  Reproduced across multiple independent open-source tools for
//                 the M365/Pro/Essential generation. Very likely correct there.
//                 Still NOT guaranteed on a 2024 Mi 4 Lite (2nd gen) — Ninebot
//                 renumbered several blocks between generations.
//   'candidate'   Plausible, reported for adjacent models, unconfirmed here.
//                 The UI refuses to write these unless Expert mode is on.
//   'derived'     Discovered on YOUR scooter by the snapshot-diff workflow and
//                 saved locally. These are the ones to trust for your device.
//
// There is no 'verified' tier for the 4 Lite 2nd gen yet because nothing here
// has been confirmed against that hardware. The Discovery panel exists to move
// the addresses you care about from 'candidate' to 'derived'. See
// docs/NEEDED-INFO.md.

import { Addr } from './frame.js';

export const Confidence = Object.freeze({
  DOCUMENTED: 'documented',
  CANDIDATE: 'candidate',
  DERIVED: 'derived',
});

/** Value decoders, kept separate so the Discovery panel can reuse them. */
export const Codec = Object.freeze({
  u16: {
    decode: (b) => b[0] | (b[1] << 8),
    encode: (v) => new Uint8Array([v & 0xff, (v >> 8) & 0xff]),
    size: 2,
  },
  u16x10: {
    // Fixed point, one decimal place — how speeds and voltages are usually sent.
    decode: (b) => (b[0] | (b[1] << 8)) / 10,
    encode: (v) => Codec.u16.encode(Math.round(v * 10)),
    size: 2,
  },
  u16x100: {
    decode: (b) => (b[0] | (b[1] << 8)) / 100,
    encode: (v) => Codec.u16.encode(Math.round(v * 100)),
    size: 2,
  },
  u16x1000: {
    // NB-protocol speed is reported in thousandths of a km/h.
    decode: (b) => (b[0] | (b[1] << 8)) / 1000,
    encode: (v) => Codec.u16.encode(Math.round(v * 1000)),
    size: 2,
  },
  i16: {
    decode: (b) => (((b[0] | (b[1] << 8)) << 16) >> 16),
    encode: (v) => Codec.u16.encode(v & 0xffff),
    size: 2,
  },
  ascii: {
    decode: (b) => new TextDecoder().decode(b).replace(/\0+$/, ''),
    encode: (v) => new TextEncoder().encode(v),
    size: 14,
  },
  version: {
    // 0x0143 -> "1.4.3"
    decode: (b) => {
      const v = b[0] | (b[1] << 8);
      return `${(v >> 8) & 0xf}.${(v >> 4) & 0xf}.${v & 0xf}`;
    },
    encode: () => {
      throw new Error('Firmware version is read-only');
    },
    size: 2,
  },
  raw: {
    decode: (b) => Array.from(b, (x) => x.toString(16).padStart(2, '0')).join(' '),
    encode: (v) => v,
    size: 2,
  },
});

/**
 * @typedef {object} RegisterDef
 * @property {string} key
 * @property {string} label
 * @property {number} addr        register address (the `arg` byte on the wire)
 * @property {number} device      Addr.ESC | Addr.BLE | Addr.BMS
 * @property {number} size        bytes to read
 * @property {object} codec       one of Codec.*
 * @property {boolean} writable
 * @property {string} confidence  Confidence.*
 * @property {string} [unit]
 * @property {[number, number]} [range]  accepted write range, inclusive
 * @property {string} [note]
 */

/** @type {RegisterDef[]} */
export const REGISTERS = [
  // ---- Identity, read-only, safe to poke at ----------------------------------
  {
    key: 'serial',
    label: 'Serial number',
    addr: 0x10,
    device: Addr.ESC,
    size: 14,
    codec: Codec.ascii,
    writable: false,
    confidence: Confidence.DOCUMENTED,
    note: 'Also mirrored at 0x1A on some firmwares.',
  },
  {
    key: 'escFirmware',
    label: 'ESC firmware',
    addr: 0x1a,
    device: Addr.ESC,
    size: 2,
    codec: Codec.version,
    writable: false,
    confidence: Confidence.CANDIDATE,
  },
  {
    key: 'bleFirmware',
    label: 'BLE firmware',
    addr: 0x1a,
    device: Addr.BLE,
    size: 2,
    codec: Codec.version,
    writable: false,
    confidence: Confidence.CANDIDATE,
  },
  {
    key: 'bmsFirmware',
    label: 'BMS firmware',
    addr: 0x17,
    device: Addr.BMS,
    size: 2,
    codec: Codec.version,
    writable: false,
    confidence: Confidence.CANDIDATE,
  },

  // ---- Live telemetry, read-only --------------------------------------------
  {
    key: 'speed',
    label: 'Speed',
    addr: 0xb5,
    device: Addr.ESC,
    size: 2,
    codec: Codec.u16x1000,
    writable: false,
    confidence: Confidence.CANDIDATE,
    unit: 'km/h',
  },
  {
    key: 'battery',
    label: 'Battery',
    addr: 0x32,
    device: Addr.BMS,
    size: 2,
    codec: Codec.u16,
    writable: false,
    confidence: Confidence.CANDIDATE,
    unit: '%',
  },
  {
    key: 'voltage',
    label: 'Pack voltage',
    addr: 0x34,
    device: Addr.BMS,
    size: 2,
    codec: Codec.u16x100,
    writable: false,
    confidence: Confidence.CANDIDATE,
    unit: 'V',
  },
  {
    key: 'current',
    label: 'Pack current',
    addr: 0x33,
    device: Addr.BMS,
    size: 2,
    codec: Codec.i16,
    writable: false,
    confidence: Confidence.CANDIDATE,
    unit: 'A',
  },
  {
    key: 'temperature',
    label: 'Controller temp',
    addr: 0xb0,
    device: Addr.ESC,
    size: 2,
    codec: Codec.u16x10,
    writable: false,
    confidence: Confidence.CANDIDATE,
    unit: '°C',
  },
  {
    key: 'odometer',
    label: 'Odometer',
    addr: 0x29,
    device: Addr.ESC,
    size: 4,
    codec: { decode: (b) => ((b[0] | (b[1] << 8) | (b[2] << 16) | (b[3] << 24)) >>> 0) / 1000, size: 4 },
    writable: false,
    confidence: Confidence.CANDIDATE,
    unit: 'km',
  },

  // ---- Settings: low risk, reversible ---------------------------------------
  {
    key: 'cruise',
    label: 'Cruise control',
    addr: 0x7c,
    device: Addr.ESC,
    size: 2,
    codec: Codec.u16,
    writable: true,
    confidence: Confidence.DOCUMENTED,
    range: [0, 1],
    note: '0 = off, 1 = on. Harmless place to confirm writes are landing.',
  },
  {
    key: 'tailLight',
    label: 'Tail light always on',
    addr: 0x7d,
    device: Addr.ESC,
    size: 2,
    codec: Codec.u16,
    writable: true,
    confidence: Confidence.DOCUMENTED,
    range: [0, 2],
    note: '0 = off, 2 = on. The other safe write target for a smoke test.',
  },
  {
    key: 'kers',
    label: 'Regen braking strength',
    addr: 0x7b,
    device: Addr.ESC,
    size: 2,
    codec: Codec.u16,
    writable: true,
    confidence: Confidence.DOCUMENTED,
    range: [0, 2],
    note: '0 = weak, 1 = medium, 2 = strong.',
  },

  // ---- Speed limits: the actual point of this app ----------------------------
  // These are the addresses the M365-generation tooling uses. On a 4 Lite 2nd
  // gen they are UNCONFIRMED. Run Discovery -> snapshot diff to find the real
  // ones before writing anything here.
  {
    key: 'limitEco',
    label: 'Speed limit — Eco',
    addr: 0x72,
    device: Addr.ESC,
    size: 2,
    codec: Codec.u16,
    writable: true,
    confidence: Confidence.CANDIDATE,
    unit: 'km/h',
    range: [1, 40],
    group: 'speed',
  },
  {
    key: 'limitDrive',
    label: 'Speed limit — Drive',
    addr: 0x73,
    device: Addr.ESC,
    size: 2,
    codec: Codec.u16,
    writable: true,
    confidence: Confidence.CANDIDATE,
    unit: 'km/h',
    range: [1, 40],
    group: 'speed',
  },
  {
    key: 'limitSport',
    label: 'Speed limit — Sport',
    addr: 0x74,
    device: Addr.ESC,
    size: 2,
    codec: Codec.u16,
    writable: true,
    confidence: Confidence.CANDIDATE,
    unit: 'km/h',
    range: [1, 40],
    group: 'speed',
  },
  {
    key: 'limitGlobal',
    label: 'Global speed cap',
    addr: 0x71,
    device: Addr.ESC,
    size: 2,
    codec: Codec.u16,
    writable: true,
    confidence: Confidence.CANDIDATE,
    unit: 'km/h',
    range: [1, 40],
    group: 'speed',
    note: 'Region cap applied on top of the per-mode limits on some firmwares.',
  },
  {
    key: 'regionCode',
    label: 'Region / market code',
    addr: 0x76,
    device: Addr.ESC,
    size: 2,
    codec: Codec.u16,
    writable: true,
    confidence: Confidence.CANDIDATE,
    group: 'speed',
    note: 'Changing the market code is how some firmwares switch the 20/25 km/h cap.',
  },
];

export const byKey = (key) => REGISTERS.find((r) => r.key === key);

export const speedRegisters = () => REGISTERS.filter((r) => r.group === 'speed');

export const DEVICE_NAMES = {
  [Addr.ESC]: 'ESC',
  [Addr.BLE]: 'BLE',
  [Addr.BMS]: 'BMS',
  [Addr.EXT_BMS]: 'ExtBMS',
};

/**
 * Registers discovered on the user's own scooter get merged in at runtime and
 * outrank the built-ins, since they were observed rather than guessed.
 */
export function mergeDerived(derived = []) {
  const map = new Map(REGISTERS.map((r) => [`${r.device}:${r.addr}`, r]));
  for (const d of derived) {
    map.set(`${d.device}:${d.addr}`, { ...d, confidence: Confidence.DERIVED });
  }
  return Array.from(map.values());
}
