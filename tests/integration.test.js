// End-to-end exercise of the app's core against the simulated controller:
// read -> safety gate -> apply -> verify -> revert -> discover.
import assert from 'node:assert/strict';
import { MockTransport } from '../src/ble/transport.js';
import { Scooter } from '../src/core/scooter.js';
import { Tuner, PROFILES, customProfile } from '../src/core/tuning.js';
import { Discovery } from '../src/core/discovery.js';
import { Confidence } from '../src/proto/registers.js';

const profile = {
  id: 'test',
  protocol: 'nb',
  session: { type: 'plaintext' },
  limits: { stockKmh: 25, hardCeilingKmh: 32 },
};

const transport = new MockTransport('nb');
const scooter = new Scooter(transport, profile);
await scooter.open();

// --- reads ------------------------------------------------------------------
const sport = scooter.registers.find((r) => r.key === 'limitSport');
const initial = await scooter.read(sport);
assert.equal(initial.value, 25, 'reads the simulator\'s stock 25 km/h Sport limit');

// --- the safety gate --------------------------------------------------------
const tuner = new Tuner(scooter, { expertMode: false });
const derestricted = PROFILES.find((p) => p.id === 'derestricted');
const gated = tuner.validate(derestricted);
assert.equal(gated.ok, false, 'unconfirmed addresses are blocked by default');
assert.match(gated.blockers[0], /has not been confirmed on your/, 'and the block says why');
await assert.rejects(() => tuner.apply(derestricted), /confirmed/, 'apply refuses while blocked');

// The ceiling holds even in expert mode.
const expert = new Tuner(scooter, { expertMode: true });
const tooFast = { id: 'x', label: 'x', limits: { limitSport: 45 } };
assert.match(expert.validate(tooFast).blockers.join(), /above this app's 32 km\/h ceiling/, 'ceiling is enforced');

// --- applying and verifying -------------------------------------------------
const applied = await expert.apply(derestricted);
assert.equal(applied.length, 3, 'all three limits written');
assert.ok(applied.every((e) => e.verified), 'every write was read back and matched');
assert.equal((await scooter.read(sport)).value, 30, 'Sport is now 30 km/h');

// --- revert -----------------------------------------------------------------
await scooter.revertAll();
assert.equal((await scooter.read(sport)).value, 25, 'revert restored the stock limit');
assert.equal(scooter.changeLog.length, 0, 'change log cleared after revert');

// --- discovery: sweep, snapshot, diff, promote ------------------------------
const discovery = new Discovery(scooter);
const found = await discovery.sweep({ from: 0x70, to: 0x7f });
const present = found.filter((f) => f.present).map((f) => f.addr);
assert.ok(present.includes(0x74), 'sweep finds the populated Sport-limit address');
assert.ok(!present.includes(0x75), 'and does not report filler addresses as present');

const before = await discovery.snapshot(present, { label: 'before' });
await scooter.write(sport, 27, { reason: 'test: simulate a mode change' }); // stand-in for the official app
const after = await discovery.snapshot(present, { label: 'after' });

const changes = Discovery.diff(before, after);
assert.equal(changes.length, 1, 'exactly one address moved');
assert.equal(changes[0].addr, 0x74, 'and it is the one we changed');

const promoted = Discovery.promote(changes[0], { key: 'limitSport', label: 'Speed limit — Sport' });
assert.equal(promoted.confidence, Confidence.DERIVED, 'promoted registers are marked as observed');

scooter.adoptDerived([promoted]);
const nowDerived = scooter.registers.find((r) => r.key === 'limitSport');
assert.equal(nowDerived.confidence, Confidence.DERIVED, 'the scooter now uses the observed address');

// With a derived address, the plain (non-expert) tuner stops blocking.
const afterDiscovery = new Tuner(scooter, { expertMode: false }).validate({
  id: 'y',
  label: 'y',
  limits: { limitSport: 30 },
});
assert.equal(afterDiscovery.ok, true, 'confirmed addresses no longer need expert mode');

// --- per-mode custom limits -------------------------------------------------
// A profile that allows up to 40, to exercise the raised ceiling.
const fastProfile = { ...profile, limits: { stockKmh: 25, warnAboveKmh: 32, hardCeilingKmh: 40 } };
const fastScooter = new Scooter(new MockTransport('nb'), fastProfile);
await fastScooter.open();
const fastTuner = new Tuner(fastScooter, { expertMode: true });

// Different limits per mode in a single write — the point of the editor.
const mixed = customProfile({ limitDrive: 25, limitSport: 40 });
const mixedCheck = fastTuner.validate(mixed);
assert.equal(mixedCheck.ok, true, 'Drive 25 / Sport 40 is accepted under a 40 km/h ceiling');
assert.match(
  mixedCheck.warnings.join(' '),
  /motor is the limit rather than the setting/,
  'and warns that past ~32 the motor decides, not the setting'
);

await fastTuner.apply(mixed);
const fastDrive = fastScooter.registers.find((r) => r.key === 'limitDrive');
const fastSport = fastScooter.registers.find((r) => r.key === 'limitSport');
assert.equal((await fastScooter.read(fastDrive)).value, 25, 'Drive written independently');
assert.equal((await fastScooter.read(fastSport)).value, 40, 'Sport written independently');

// The ceiling still bites, one above it.
assert.match(
  fastTuner.validate(customProfile({ limitSport: 41 })).blockers.join(),
  /above this app's 40 km\/h ceiling/,
  '41 km/h is refused'
);

// Modes set out of order are allowed but called out.
assert.match(
  fastTuner.validate(customProfile({ limitDrive: 35, limitSport: 20 })).warnings.join(' '),
  /higher than Sport/,
  'a Drive limit above Sport is flagged'
);

// A global cap below the requested mode limit would silently clamp it.
assert.match(
  fastTuner.validate(customProfile({ limitSport: 40 }), new Map([['limitGlobal', 25]])).warnings.join(' '),
  /global cap is currently 25/,
  'a lower global cap is called out'
);

console.log('integration.test.js: all assertions pass');
