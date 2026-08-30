// FIPS-197 known-answer tests for the bundled AES core.
import { Aes } from '../src/proto/aes.js';
import assert from 'node:assert/strict';

const fromHex = (s) => Uint8Array.from(s.match(/../g).map((b) => parseInt(b, 16)));
const toHex = (b) => Array.from(b, (x) => x.toString(16).padStart(2, '0')).join('');

const vectors = [
  // FIPS-197 Appendix C.1 / C.2 / C.3
  ['000102030405060708090a0b0c0d0e0f', '00112233445566778899aabbccddeeff', '69c4e0d86a7b0430d8cdb78070b4c55a'],
  ['000102030405060708090a0b0c0d0e0f1011121314151617', '00112233445566778899aabbccddeeff', 'dda97ca4864cdfe06eaf70a0ec0d7191'],
  ['000102030405060708090a0b0c0d0e0f101112131415161718191a1b1c1d1e1f', '00112233445566778899aabbccddeeff', '8ea2b7ca516745bfeafc49904b496089'],
];

for (const [key, plain, cipher] of vectors) {
  const aes = new Aes(fromHex(key));
  const enc = aes.ecbEncrypt(fromHex(plain));
  assert.equal(toHex(enc), cipher, `AES-${key.length * 4} ECB encrypt`);
  assert.equal(toHex(aes.ecbDecrypt(enc)), plain, `AES-${key.length * 4} ECB decrypt`);
}

// CBC and CTR must round-trip over multiple blocks.
const aes = new Aes(fromHex('000102030405060708090a0b0c0d0e0f'));
const iv = fromHex('0f0e0d0c0b0a09080706050403020100');
const message = fromHex('00112233445566778899aabbccddeeff' + 'ffeeddccbbaa99887766554433221100');

assert.equal(toHex(aes.cbcDecrypt(aes.cbcEncrypt(message, iv), iv)), toHex(message), 'CBC round-trip');
assert.equal(toHex(aes.ctrCrypt(aes.ctrCrypt(message, iv), iv)), toHex(message), 'CTR round-trip');
assert.notEqual(toHex(aes.cbcEncrypt(message, iv)), toHex(aes.ecbEncrypt(message)), 'CBC must chain');

console.log('aes.test.js: all vectors pass');
