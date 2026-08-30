// Web Serial transport for the Brightway flasher.
//
// Talks to a USB-to-TTL adapter (CP2102 / CH340 / FTDI) wired to the controller's
// UART at 19200 8N1 — the same physical link bw-flasher uses over /dev/ttyUSB0.
// Chrome and Edge on desktop expose navigator.serial; nothing else does yet.

export class WebSerialLink {
  #port = null;
  #reader = null;
  #writer = null;
  #buffer = [];

  static get available() {
    return typeof navigator !== 'undefined' && 'serial' in navigator;
  }

  /** Prompt for a port and open it. Must be called from a user gesture. */
  async open({ baudRate = 19200 } = {}) {
    if (!WebSerialLink.available) {
      throw new Error('This browser has no Web Serial. Use Chrome or Edge on a desktop OS.');
    }
    this.#port = await navigator.serial.requestPort();
    await this.#port.open({ baudRate, dataBits: 8, stopBits: 1, parity: 'none' });
    this.#writer = this.#port.writable.getWriter();
    this.#reader = this.#port.readable.getReader();
    this.#pump();
    return this.portLabel;
  }

  get portLabel() {
    const info = this.#port?.getInfo?.() ?? {};
    return info.usbVendorId
      ? `USB ${info.usbVendorId.toString(16).padStart(4, '0')}:${(info.usbProductId ?? 0).toString(16).padStart(4, '0')}`
      : 'Serial port';
  }

  /** Continuously drain the reader into a byte buffer. */
  async #pump() {
    try {
      for (;;) {
        const { value, done } = await this.#reader.read();
        if (done) break;
        if (value) for (const b of value) this.#buffer.push(b);
      }
    } catch {
      /* closed */
    }
  }

  async write(bytes) {
    await this.#writer.write(Uint8Array.from(bytes));
  }

  /** Read until `endByte` (or timeout), then return the last `maxBytes` bytes. */
  async readUntil(endByte, maxBytes, timeoutMs = 2000) {
    const deadline = Date.now() + timeoutMs;
    for (;;) {
      const idx = this.#buffer.indexOf(endByte);
      if (idx >= 0) {
        const slice = this.#buffer.splice(0, idx + 1);
        return Uint8Array.from(slice.slice(Math.max(0, slice.length - maxBytes)));
      }
      if (Date.now() > deadline) {
        // Return whatever arrived; the state machine treats a short read as "retry".
        const slice = this.#buffer.splice(0, this.#buffer.length);
        return Uint8Array.from(slice.slice(Math.max(0, slice.length - maxBytes)));
      }
      await new Promise((r) => setTimeout(r, 10));
    }
  }

  async close() {
    try { await this.#reader?.cancel(); } catch { /* */ }
    try { this.#writer?.releaseLock(); } catch { /* */ }
    try { this.#reader?.releaseLock(); } catch { /* */ }
    try { await this.#port?.close(); } catch { /* */ }
    this.#port = null;
  }
}
