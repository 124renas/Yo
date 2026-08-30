// Verifies the JS ports of the Brightway CRC and auth against reference vectors
// generated from the original ScooterTeam Python (tests/fixtures/flash-vectors.json).
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { crc16, crc32 } from '../src/flash/crc.js';
import { signRand } from '../src/flash/keygen.js';

const V = JSON.parse(fs.readFileSync(new URL('./fixtures/flash-vectors.json', import.meta.url)));
const hexToBytes = (h) => Uint8Array.from(h.match(/../g) ?? [], (b) => parseInt(b, 16));

for (const { data, crc } of V.crc16) {
  assert.equal(crc16(hexToBytes(data)), crc, `crc16(${data || '<empty>'})`);
}
for (const { data, crc } of V.crc32) {
  assert.equal(crc32(hexToBytes(data)), crc >>> 0, `crc32(${data || '<empty>'})`);
}

const s = V.sign_rand;
const got = signRand(hexToBytes(s.uid), hexToBytes(s.rand), hexToBytes(s.table0), hexToBytes(s.table1));
assert.equal(
  Array.from(got, (b) => b.toString(16).padStart(2, '0')).join(''),
  s.expected,
  'signRand matches the Python reference'
);

console.log('flash.test.js: CRC16, CRC32 and signRand match the ScooterTeam reference');
