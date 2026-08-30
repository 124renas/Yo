// Small shared helpers: byte wrangling, hex formatting, events, timing.

export const hex = (n, width = 2) =>
  n.toString(16).toUpperCase().padStart(width, '0');

export const hexBytes = (bytes, sep = ' ') =>
  Array.from(bytes, (b) => hex(b)).join(sep);

export function parseHex(text) {
  const cleaned = text.replace(/0x/gi, '').replace(/[^0-9a-f]/gi, '');
  if (cleaned.length % 2 !== 0) throw new Error('Hex string has an odd number of digits');
  const out = new Uint8Array(cleaned.length / 2);
  for (let i = 0; i < out.length; i++) out[i] = parseInt(cleaned.substr(i * 2, 2), 16);
  return out;
}

export const u16le = (bytes, off = 0) => bytes[off] | (bytes[off + 1] << 8);
export const i16le = (bytes, off = 0) => (u16le(bytes, off) << 16) >> 16;
export const u32le = (bytes, off = 0) =>
  (bytes[off] | (bytes[off + 1] << 8) | (bytes[off + 2] << 16) | (bytes[off + 3] << 24)) >>> 0;

export function packU16le(value) {
  return new Uint8Array([value & 0xff, (value >> 8) & 0xff]);
}

export function concatBytes(...chunks) {
  const total = chunks.reduce((n, c) => n + c.length, 0);
  const out = new Uint8Array(total);
  let off = 0;
  for (const c of chunks) {
    out.set(c, off);
    off += c.length;
  }
  return out;
}

export const bytesEqual = (a, b) =>
  a.length === b.length && a.every((v, i) => v === b[i]);

export const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

export function withTimeout(promise, ms, message = 'Timed out') {
  let timer;
  const timeout = new Promise((_, reject) => {
    timer = setTimeout(() => reject(new Error(message)), ms);
  });
  return Promise.race([promise, timeout]).finally(() => clearTimeout(timer));
}

/** Minimal typed event emitter — every module talks to the UI through one of these. */
export class Emitter {
  #listeners = new Map();

  on(event, handler) {
    if (!this.#listeners.has(event)) this.#listeners.set(event, new Set());
    this.#listeners.get(event).add(handler);
    return () => this.off(event, handler);
  }

  off(event, handler) {
    this.#listeners.get(event)?.delete(handler);
  }

  emit(event, payload) {
    for (const handler of this.#listeners.get(event) ?? []) {
      try {
        handler(payload);
      } catch (err) {
        console.error(`listener for "${event}" threw`, err);
      }
    }
  }
}
