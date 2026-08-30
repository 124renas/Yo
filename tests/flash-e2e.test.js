// End-to-end flash against the in-memory bootloader: the whole DFU state machine
// runs, auth passes, every chunk CRC is validated by the mock, and the image the
// device reassembles must equal the image we sent.
import assert from 'node:assert/strict';
import { BrightwayDFU, inspectFirmware } from '../src/flash/brightway-dfu.js';
import { MockMcuLink } from '../src/flash/mock-mcu.js';

// Build a minimal but valid-looking Brightway image: DEPRD5C signature at 0x800,
// a single 637C marker with an 0102 after it (so the auth-table offsets resolve),
// and a couple of packets' worth of data.
function makeFirmware() {
  const fw = new Uint8Array(0x1200).map((_, i) => (i * 31 + 5) & 0xff);
  fw.set(new TextEncoder().encode('DEPRD5C\x00'), 0x800);
  // exactly one 63 7C, followed by exactly one 01 02 after it
  // clear any accidental occurrences first
  for (let i = 0; i < fw.length - 1; i++) {
    if (fw[i] === 0x63 && fw[i + 1] === 0x7c) fw[i + 1] = 0x00;
    if (fw[i] === 0x01 && fw[i + 1] === 0x02) fw[i + 1] = 0x00;
  }
  fw[0x300] = 0x63; fw[0x301] = 0x7c;           // table0 base at 0x300
  fw[0x420] = 0x01; fw[0x421] = 0x02;           // table1 base near 0x41f
  return fw;
}

const fw = makeFirmware();
const info = inspectFirmware(fw);
assert.equal(info.type, 'brightway', 'firmware recognised as Brightway');
assert.ok(info.offsets, 'auth table offsets resolved');

const mock = new MockMcuLink(fw);
const states = [];
const dfu = new BrightwayDFU(mock, fw, { onState: (s) => states.push(s) });

await dfu.testConnection();
await dfu.run();

assert.ok(mock.activated, 'the device was told to activate the new firmware');
assert.equal(dfu.state, 'DONE', 'flasher reached DONE');

// The image the bootloader reassembled must match what we flashed (padded to the
// 2 KB packet boundary with 0xFF, exactly as the protocol specifies).
const flashed = mock.flashedImage(fw.length);
assert.equal(flashed.length, fw.length, 'flashed length matches');
assert.ok(flashed.every((b, i) => b === fw[i]), 'every flashed byte matches the source image');

// The auth actually ran (not skipped): both challenge states were visited.
assert.ok(states.includes('BLE_RAND') && states.includes('MCU_KEY'), 'challenge/response auth was exercised');

// A corrupted image must be rejected before any flashing starts.
const notFw = new Uint8Array(0x1200);
assert.throws(() => new BrightwayDFU(new MockMcuLink(fw), notFw), /Brightway/, 'refuses a non-Brightway image');

console.log('flash-e2e.test.js: full DFU flash round-trips through the simulated bootloader');
