// High-level scooter API: one in-flight request at a time, correlated replies,
// retries, and a change log that makes every write reversible.

import { Emitter, hexBytes, withTimeout, sleep } from '../util.js';
import { FrameParser, encodeRead, encodeWrite, Addr, Protocol } from '../proto/frame.js';
import { createSession } from '../proto/session.js';
import { Codec, Confidence, mergeDerived, DEVICE_NAMES } from '../proto/registers.js';

const REQUEST_TIMEOUT_MS = 1200;
const MAX_ATTEMPTS = 3;

export class Scooter extends Emitter {
  #parser;
  #session;
  #waiters = [];
  #queue = Promise.resolve();

  constructor(transport, profile) {
    super();
    this.transport = transport;
    this.profile = profile;
    this.protocol = profile.protocol ?? Protocol.NB;
    this.registers = mergeDerived(profile.registers?.derived ?? []);
    this.changeLog = [];

    this.#parser = new FrameParser(this.protocol);
    this.#session = createSession(profile);

    this.#session.on('status', (s) => this.emit('status', s));
    this.#session.on('handshake-tx', (b) => this.emit('traffic', { dir: 'tx', bytes: b, phase: 'handshake' }));
    this.#session.on('handshake-rx', (b) => this.emit('traffic', { dir: 'rx', bytes: b, phase: 'handshake' }));

    transport.on('rx', (chunk) => this.#onChunk(chunk));
    transport.on('tx', (bytes) => this.emit('traffic', { dir: 'tx', bytes, phase: 'frame' }));
    transport.on('disconnected', () => this.emit('disconnected'));
  }

  get sessionReady() {
    return this.#session.ready;
  }

  async open() {
    await this.#session.open(this.transport);
  }

  #onChunk(chunk) {
    this.emit('traffic', { dir: 'rx', bytes: chunk, phase: this.#session.ready ? 'frame' : 'handshake' });
    const plain = this.#session.decode(chunk);
    if (plain.length === 0) return;

    for (const frame of this.#parser.push(plain)) {
      this.emit('frame', frame);
      if (!frame.checksumOk) {
        this.emit('warning', { message: `Dropped a frame with a bad checksum: ${hexBytes(frame.raw)}` });
        continue;
      }
      const waiter = this.#waiters.find((w) => w.matches(frame));
      if (waiter) {
        this.#waiters.splice(this.#waiters.indexOf(waiter), 1);
        waiter.resolve(frame);
      }
    }
  }

  /** Serialise requests — these controllers do not cope with overlapping ones. */
  #enqueue(task) {
    const run = this.#queue.then(task, task);
    this.#queue = run.catch(() => {});
    return run;
  }

  #awaitReply(match) {
    return new Promise((resolve, reject) => {
      const waiter = { matches: match, resolve, reject };
      this.#waiters.push(waiter);
      setTimeout(() => {
        const i = this.#waiters.indexOf(waiter);
        if (i >= 0) {
          this.#waiters.splice(i, 1);
          reject(new Error('No reply'));
        }
      }, REQUEST_TIMEOUT_MS + 50);
    });
  }

  /**
   * Read `length` raw bytes from a register. Returns null when the controller
   * stays silent — Discovery treats that as "address not present" rather than
   * an error, so this deliberately does not throw on timeout.
   */
  async readRaw(addr, length = 2, device = Addr.ESC, { attempts = MAX_ATTEMPTS } = {}) {
    return this.#enqueue(async () => {
      for (let attempt = 1; attempt <= attempts; attempt++) {
        const frame = encodeRead({ protocol: this.protocol, dst: device, arg: addr, length });
        const reply = this.#awaitReply((f) => f.arg === addr && (this.protocol !== Protocol.NB || f.src === device));

        await this.transport.write(this.#session.encode(frame));
        try {
          const got = await withTimeout(reply, REQUEST_TIMEOUT_MS, 'No reply');
          return got.payload.slice(0, length);
        } catch {
          if (attempt < attempts) await sleep(60 * attempt);
        }
      }
      return null;
    });
  }

  /** Read and decode a register definition. */
  async read(def) {
    const raw = await this.readRaw(def.addr, def.size, def.device);
    if (!raw) return { def, raw: null, value: null };
    return { def, raw, value: def.codec.decode(raw) };
  }

  /**
   * Write a decoded value to a register. Reads the current value first so the
   * change can be undone, and verifies the write landed by reading it back.
   */
  async write(def, value, { verify = true, reason = '' } = {}) {
    if (!def.writable) throw new Error(`${def.label} is read-only`);
    if (def.range) {
      const [min, max] = def.range;
      if (value < min || value > max) {
        throw new Error(`${def.label}: ${value} is outside the accepted range ${min}–${max}`);
      }
    }

    const before = await this.read(def);
    const bytes = def.codec.encode(value);

    await this.#enqueue(async () => {
      const frame = encodeWrite({ protocol: this.protocol, dst: def.device, arg: def.addr, value: bytes });
      await this.transport.write(this.#session.encode(frame));
    });
    await sleep(80); // controllers need a beat before the new value reads back

    const entry = {
      at: new Date().toISOString(),
      key: def.key,
      label: def.label,
      device: DEVICE_NAMES[def.device] ?? def.device,
      addr: def.addr,
      from: before.value,
      to: value,
      reason,
      confidence: def.confidence,
      verified: null,
    };

    if (verify) {
      const after = await this.read(def);
      entry.verified = after.value === value;
      entry.readBack = after.value;
      if (!entry.verified) {
        this.emit('warning', {
          message:
            `${def.label} read back as ${after.value ?? 'no reply'} after writing ${value}. ` +
            `The controller either rejected the value or this address is not what we think it is.`,
        });
      }
    }

    this.changeLog.push(entry);
    this.emit('write', entry);
    return entry;
  }

  /** Put every logged change back the way it was, newest first. */
  async revertAll() {
    const restored = [];
    for (const entry of [...this.changeLog].reverse()) {
      if (entry.from === null || entry.from === undefined) continue;
      const def = this.registers.find((r) => r.key === entry.key);
      if (!def) continue;
      await this.write(def, entry.from, { reason: 'revert' });
      restored.push(entry.label);
    }
    this.changeLog = [];
    this.emit('reverted', restored);
    return restored;
  }

  /** Read a named set of registers, skipping any the controller ignores. */
  async readMany(defs) {
    const results = [];
    for (const def of defs) {
      results.push(await this.read(def));
    }
    return results;
  }

  registersFor(group) {
    return this.registers.filter((r) => (group ? r.group === group : true));
  }

  /** Adopt addresses proven out by Discovery. */
  adoptDerived(defs) {
    this.registers = mergeDerived([...(this.profile.registers?.derived ?? []), ...defs]);
    this.emit('registers-updated', this.registers);
  }
}

export { Codec, Confidence, Addr };
