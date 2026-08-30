// Session layer: everything that sits between a protocol frame and the BLE pipe.
//
// M365-generation scooters talk in the clear, so frames go straight out. The
// Mi 3 / Mi 4 generation (including the 4 Lite 2nd gen) negotiates an AES
// session key first and encrypts every frame after that.
//
// The exact handshake constants differ per firmware and are NOT hardcoded here,
// because guessing them produces a link that silently corrupts writes. Instead
// the handshake is expressed as a small script in a device profile (see
// profiles/*.json), and this module is the interpreter for that script. Fill in
// a profile once and every model using that scheme works.

import { Aes } from './aes.js';
import { concatBytes, hexBytes, parseHex, withTimeout, Emitter } from '../util.js';

/** Bytes available to a handshake script, by name. */
class ScriptScope {
  constructor(initial = {}) {
    this.values = new Map(Object.entries(initial));
  }

  set(name, bytes) {
    this.values.set(name, Uint8Array.from(bytes));
  }

  get(name) {
    const v = this.values.get(name);
    if (!v) throw new Error(`Handshake script referenced unknown value "${name}"`);
    return v;
  }

  /**
   * Resolve one part of a recipe. Supported forms:
   *   "hex:0102ff"   literal bytes
   *   "random:16"    fresh random bytes, also stored under the part's name
   *   "$appRandom"   a previously stored value
   */
  resolve(part) {
    if (part.startsWith('hex:')) return parseHex(part.slice(4));
    if (part.startsWith('random:')) return crypto.getRandomValues(new Uint8Array(Number(part.slice(7))));
    if (part.startsWith('$')) return this.get(part.slice(1));
    throw new Error(`Unsupported recipe part "${part}"`);
  }

  /** Concatenate a list of parts into one buffer. */
  build(parts) {
    return concatBytes(...parts.map((p) => this.resolve(p)));
  }
}

/** No encryption — the frame bytes are the wire bytes. */
export class PlaintextSession extends Emitter {
  constructor() {
    super();
    this.name = 'plaintext';
    this.ready = true;
  }

  async open() {
    this.emit('status', { state: 'ready', detail: 'Plaintext link, no handshake required' });
  }

  encode(frame) {
    return frame;
  }

  decode(chunk) {
    return chunk;
  }
}

/**
 * AES session, driven by a profile. The profile supplies:
 *   session.mode        'ecb' | 'cbc' | 'ctr'
 *   session.keyRecipe   parts concatenated (and truncated/padded to 16) as key
 *   session.ivRecipe    optional, for cbc/ctr
 *   session.handshake   [{op:'send'|'await'|'derive', ...}, ...]
 */
export class NbAesSession extends Emitter {
  #aes = null;
  #iv = null;
  #scope;
  #pending = [];

  constructor(profile, { serial = '' } = {}) {
    super();
    this.name = 'nb-aes';
    this.ready = false;
    this.config = profile.session ?? {};
    this.#scope = new ScriptScope({
      serial: new TextEncoder().encode(serial),
    });
  }

  /** Run the handshake script against an open transport. */
  async open(transport) {
    const script = this.config.handshake ?? [];
    if (script.length === 0) {
      throw new IncompleteProfileError(
        'This profile has no handshake script yet, so the encrypted link cannot be opened. ' +
          'Use Discovery → Capture handshake to record one.'
      );
    }

    for (const [i, step] of script.entries()) {
      this.emit('status', { state: 'handshake', detail: `Step ${i + 1}/${script.length}: ${step.op}` });
      await this.#runStep(step, transport);
    }

    this.#deriveKey();
    this.ready = true;
    this.emit('status', { state: 'ready', detail: `Encrypted session established (aes-${this.config.mode})` });
  }

  async #runStep(step, transport) {
    switch (step.op) {
      case 'send': {
        const bytes = this.#scope.build(step.parts);
        if (step.store) this.#scope.set(step.store, bytes);
        await transport.write(bytes);
        this.emit('handshake-tx', bytes);
        return;
      }
      case 'await': {
        const reply = await withTimeout(
          this.#nextChunk(step.match ? parseHex(step.match) : null),
          step.timeout ?? 5000,
          `Scooter did not answer handshake step "${step.store ?? step.op}"`
        );
        this.emit('handshake-rx', reply);
        if (step.store) {
          const from = step.offset ?? 0;
          this.#scope.set(step.store, reply.slice(from, from + (step.length ?? reply.length - from)));
        }
        return;
      }
      case 'derive': {
        const material = this.#scope.build(step.parts);
        const value = step.transform === 'aes-encrypt'
          ? new Aes(fit(this.#scope.get(step.with), 16)).ecbEncrypt(fit(material, 16))
          : material;
        this.#scope.set(step.into, value);
        return;
      }
      default:
        throw new Error(`Unknown handshake op "${step.op}"`);
    }
  }

  /** Resolve with the next inbound chunk, optionally waiting for one with a given prefix. */
  #nextChunk(prefix) {
    return new Promise((resolve) => {
      this.#pending.push({ prefix, resolve });
    });
  }

  #deriveKey() {
    const key = fit(this.#scope.build(this.config.keyRecipe ?? []), 16);
    this.#aes = new Aes(key);
    this.#iv = this.config.ivRecipe ? fit(this.#scope.build(this.config.ivRecipe), 16) : new Uint8Array(16);
    this.emit('key', { key: hexBytes(key) });
  }

  encode(frame) {
    if (!this.ready) throw new Error('Session is not open yet');
    return this.#crypt(pad16(frame), true);
  }

  decode(chunk) {
    // Handshake replies bypass decryption — the key does not exist yet.
    if (!this.ready) {
      const waiter = this.#pending.find((w) => !w.prefix || startsWith(chunk, w.prefix));
      if (waiter) {
        this.#pending.splice(this.#pending.indexOf(waiter), 1);
        waiter.resolve(chunk);
      }
      return new Uint8Array(0);
    }
    if (chunk.length % 16 !== 0) return chunk; // not a ciphertext block; pass through
    return this.#crypt(chunk, false);
  }

  #crypt(data, encrypting) {
    const mode = this.config.mode ?? 'ecb';
    if (mode === 'ecb') return encrypting ? this.#aes.ecbEncrypt(data) : this.#aes.ecbDecrypt(data);
    if (mode === 'cbc') return encrypting ? this.#aes.cbcEncrypt(data, this.#iv) : this.#aes.cbcDecrypt(data, this.#iv);
    if (mode === 'ctr') return this.#aes.ctrCrypt(data, this.#iv);
    throw new Error(`Unsupported AES mode "${mode}"`);
  }
}

/** Thrown when a profile is missing the constants needed to talk to a scooter. */
export class IncompleteProfileError extends Error {
  constructor(message) {
    super(message);
    this.name = 'IncompleteProfileError';
    this.actionable = true;
  }
}

/** Truncate or zero-pad to an exact length. */
function fit(bytes, length) {
  const out = new Uint8Array(length);
  out.set(bytes.slice(0, length));
  return out;
}

/** Zero-pad up to a 16-byte boundary. */
function pad16(bytes) {
  if (bytes.length % 16 === 0) return bytes;
  const out = new Uint8Array(Math.ceil(bytes.length / 16) * 16);
  out.set(bytes);
  return out;
}

const startsWith = (bytes, prefix) => prefix.every((b, i) => bytes[i] === b);

export function createSession(profile, ctx = {}) {
  const type = profile.session?.type ?? 'plaintext';
  if (type === 'plaintext') return new PlaintextSession();
  if (type === 'nb-aes') return new NbAesSession(profile, ctx);
  throw new Error(`Unknown session type "${type}"`);
}
