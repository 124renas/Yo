// Web Bluetooth transport.
//
// Every scooter generation has used a Nordic-UART-shaped service: one
// write-without-response characteristic going down to the scooter, one notify
// characteristic coming back. Rather than hardcode a UUID table that goes stale
// with each model, we enumerate the device's services and pick the first pair
// that has the right shape, preferring a profile's hint if it has one.

import { Emitter, concatBytes } from '../util.js';

/** Services we ask permission for up front — Web Bluetooth hides anything not listed. */
export const KNOWN_SERVICES = [
  '6e400001-b5a3-f393-e0a9-e50e24dcca9e', // Nordic UART, used by every generation so far
  '0000fe95-0000-1000-8000-00805f9b34fb', // Xiaomi
  '0000ffe0-0000-1000-8000-00805f9b34fb', // common BLE-serial bridge
  '0000fee7-0000-1000-8000-00805f9b34fb', // Xiaomi/Ninebot pairing service
  '0000180a-0000-1000-8000-00805f9b34fb', // Device Information
];

/** Name prefixes the scooters advertise with. */
export const NAME_PREFIXES = ['MISc', 'MIScooter', 'Mi Scooter', 'Ninebot', 'NB', 'KickScooter', 'XM'];

export class BleTransport extends Emitter {
  #device = null;
  #server = null;
  #tx = null;
  #rx = null;

  get connected() {
    return Boolean(this.#server?.connected);
  }

  get deviceName() {
    return this.#device?.name ?? null;
  }

  static get available() {
    return typeof navigator !== 'undefined' && Boolean(navigator.bluetooth);
  }

  /** Show the browser's device chooser. Must be called from a user gesture. */
  async requestDevice({ allowAll = false } = {}) {
    if (!BleTransport.available) {
      throw new Error(
        'This browser has no Web Bluetooth. Use Chrome or Edge on Android, Windows, macOS, Linux or ChromeOS — ' +
          'or Bluefy on iOS, since Safari does not implement it.'
      );
    }

    const filters = NAME_PREFIXES.map((namePrefix) => ({ namePrefix }));
    this.#device = await navigator.bluetooth.requestDevice(
      allowAll
        ? { acceptAllDevices: true, optionalServices: KNOWN_SERVICES }
        : { filters, optionalServices: KNOWN_SERVICES }
    );

    this.#device.addEventListener('gattserverdisconnected', () => {
      this.#server = null;
      this.#tx = null;
      this.#rx = null;
      this.emit('disconnected');
    });

    this.emit('device', { name: this.#device.name, id: this.#device.id });
    return this.#device;
  }

  async connect(preferService = null) {
    if (!this.#device) throw new Error('No device selected');
    this.emit('status', { state: 'connecting', detail: `Connecting to ${this.#device.name}` });

    this.#server = await this.#device.gatt.connect();
    const services = await this.#server.getPrimaryServices();
    if (services.length === 0) throw new Error('Device exposed no GATT services');

    const ordered = preferService
      ? [...services].sort((a, b) => (a.uuid === preferService ? -1 : b.uuid === preferService ? 1 : 0))
      : services;

    for (const service of ordered) {
      const chars = await service.getCharacteristics().catch(() => []);
      const tx = chars.find((c) => c.properties.writeWithoutResponse || c.properties.write);
      const rx = chars.find((c) => c.properties.notify || c.properties.indicate);
      if (tx && rx) {
        this.#tx = tx;
        this.#rx = rx;
        this.emit('status', {
          state: 'connected',
          detail: `Service ${short(service.uuid)} · tx ${short(tx.uuid)} · rx ${short(rx.uuid)}`,
        });
        break;
      }
    }

    if (!this.#tx || !this.#rx) {
      throw new Error('Could not find a write + notify characteristic pair — this may not be a scooter.');
    }

    await this.#rx.startNotifications();
    this.#rx.addEventListener('characteristicvaluechanged', (event) => {
      const chunk = new Uint8Array(event.target.value.buffer);
      this.emit('rx', chunk);
    });

    return { service: this.#tx.service.uuid, tx: this.#tx.uuid, rx: this.#rx.uuid };
  }

  /** Write, splitting at the 20-byte default ATT payload so long frames survive. */
  async write(bytes, chunkSize = 20) {
    if (!this.#tx) throw new Error('Not connected');
    for (let off = 0; off < bytes.length; off += chunkSize) {
      const chunk = bytes.slice(off, off + chunkSize);
      if (this.#tx.properties.writeWithoutResponse) {
        await this.#tx.writeValueWithoutResponse(chunk);
      } else {
        await this.#tx.writeValueWithResponse(chunk);
      }
    }
    this.emit('tx', bytes);
  }

  async disconnect() {
    try {
      await this.#rx?.stopNotifications();
    } catch {
      /* the device may already be gone */
    }
    this.#device?.gatt?.disconnect();
    this.#server = null;
  }
}

/**
 * Stand-in transport for working on the app without a scooter in reach. It
 * answers reads from a small in-memory register file so the UI, framing and
 * discovery flows can be exercised end to end.
 */
export class MockTransport extends Emitter {
  #memory = new Map();

  constructor(protocol) {
    super();
    this.protocol = protocol;
    this.connected = true;
    this.deviceName = 'MISc-MOCK (simulator)';
    // A plausible starting state: 25 km/h stock limits.
    this.#memory.set(0x71, 25);
    this.#memory.set(0x72, 6);
    this.#memory.set(0x73, 20);
    this.#memory.set(0x74, 25);
    this.#memory.set(0x76, 1);
    this.#memory.set(0x7b, 1);
    this.#memory.set(0x7c, 0);
    this.#memory.set(0x7d, 0);
  }

  async requestDevice() {
    return { name: this.deviceName };
  }

  async connect() {
    this.emit('status', { state: 'connected', detail: 'Simulator — no radio in use' });
    return { service: 'mock', tx: 'mock', rx: 'mock' };
  }

  async write(bytes) {
    this.emit('tx', bytes);
    const { decodeRequest, buildReply } = await import('./mock-esc.js');
    const req = decodeRequest(this.protocol, bytes);
    if (!req) return;
    const reply = buildReply(this.protocol, req, this.#memory);
    if (reply) setTimeout(() => this.emit('rx', reply), 15);
  }

  async disconnect() {
    this.connected = false;
    this.emit('disconnected');
  }
}

const short = (uuid) => uuid.split('-')[0];
