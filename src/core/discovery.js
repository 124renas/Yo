// Finding the registers that actually matter on YOUR scooter.
//
// The built-in addresses in src/proto/registers.js are inherited from the older
// M365 generation and are not confirmed on a 2024 4 Lite. Rather than write to
// a guess, this module derives the real ones empirically:
//
//   1. Sweep the address space and record everything that answers.
//   2. Take a snapshot.
//   3. Switch drive mode (or change the speed limit) in the official Xiaomi Home
//      app, or on the scooter's own display.
//   4. Take a second snapshot and diff.
//
// An address whose value tracks the mode you changed IS the speed limit
// register on your firmware, with no guessing involved. Promote it and the app
// starts treating it as 'derived'.

import { Emitter, hexBytes, u16le } from '../util.js';
import { Addr } from '../proto/frame.js';
import { Codec, Confidence } from '../proto/registers.js';

/** An unmapped address usually answers with all-0xFF or all-0x00, or not at all. */
const isFiller = (raw) => !raw || raw.every((b) => b === 0xff) || raw.every((b) => b === 0x00);

export class Discovery extends Emitter {
  #cancelled = false;

  constructor(scooter) {
    super();
    this.scooter = scooter;
    this.snapshots = [];
  }

  cancel() {
    this.#cancelled = true;
  }

  /**
   * Read every address in a range. Slow by nature — each address is a round
   * trip — so it reports progress and can be cancelled.
   */
  async sweep({ device = Addr.ESC, from = 0x00, to = 0xff, size = 2 } = {}) {
    this.#cancelled = false;
    const found = [];
    const total = to - from + 1;

    for (let addr = from; addr <= to; addr++) {
      if (this.#cancelled) {
        this.emit('cancelled', { at: addr });
        break;
      }
      // One attempt only: a silent address is a result, not a failure to retry.
      const raw = await this.scooter.readRaw(addr, size, device, { attempts: 1 });
      const entry = {
        addr,
        device,
        raw,
        hex: raw ? hexBytes(raw) : null,
        value: raw ? u16le(raw) : null,
        present: Boolean(raw) && !isFiller(raw),
      };
      if (raw) found.push(entry);

      this.emit('progress', {
        done: addr - from + 1,
        total,
        addr,
        entry,
        percent: Math.round(((addr - from + 1) / total) * 100),
      });
    }

    this.emit('sweep-complete', found);
    return found;
  }

  /** Capture the current value of every address that answered during a sweep. */
  async snapshot(addresses, { label = '', device = Addr.ESC, size = 2 } = {}) {
    const values = new Map();
    for (const addr of addresses) {
      if (this.#cancelled) break;
      const raw = await this.scooter.readRaw(addr, size, device, { attempts: 1 });
      if (raw) values.set(addr, raw);
      this.emit('snapshot-progress', { addr, done: values.size, total: addresses.length });
    }
    const snap = { label: label || `snapshot ${this.snapshots.length + 1}`, at: new Date().toISOString(), device, values };
    this.snapshots.push(snap);
    this.emit('snapshot', snap);
    return snap;
  }

  /**
   * Compare two snapshots. Addresses that changed are candidates for whatever
   * setting you altered in between.
   */
  static diff(a, b) {
    const changes = [];
    for (const [addr, before] of a.values) {
      const after = b.values.get(addr);
      if (!after) continue;
      if (before.length === after.length && before.every((v, i) => v === after[i])) continue;
      changes.push({
        addr,
        device: b.device,
        before: hexBytes(before),
        after: hexBytes(after),
        beforeValue: u16le(before),
        afterValue: u16le(after),
        delta: u16le(after) - u16le(before),
      });
    }
    return changes.sort((x, y) => x.addr - y.addr);
  }

  /**
   * Turn a diff row into a real register definition the rest of the app can use.
   * This is the moment an address graduates from guess to observed fact.
   */
  static promote(change, { key, label, unit = 'km/h', writable = true, range = [1, 40], group = 'speed' }) {
    return {
      key,
      label,
      addr: change.addr,
      device: change.device,
      size: 2,
      codec: Codec.u16,
      writable,
      confidence: Confidence.DERIVED,
      unit,
      range,
      group,
      note: `Observed changing from ${change.before} to ${change.after} on this scooter.`,
    };
  }

  /** Everything needed to reproduce or review a discovery session, as JSON. */
  export() {
    return {
      exportedAt: new Date().toISOString(),
      profile: this.scooter.profile.id,
      protocol: this.scooter.protocol,
      device: this.scooter.transport.deviceName ?? null,
      snapshots: this.snapshots.map((s) => ({
        label: s.label,
        at: s.at,
        device: s.device,
        values: Object.fromEntries(Array.from(s.values, ([addr, raw]) => [`0x${addr.toString(16).padStart(2, '0')}`, hexBytes(raw)])),
      })),
      diffs:
        this.snapshots.length >= 2
          ? Discovery.diff(this.snapshots.at(-2), this.snapshots.at(-1))
          : [],
    };
  }
}
