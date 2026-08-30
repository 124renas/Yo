// UI controller. Wires the DOM in index.html to the core modules.

import { hex, hexBytes } from '../util.js';
import { BleTransport, MockTransport } from '../ble/transport.js';
import { Scooter } from '../core/scooter.js';
import { Discovery } from '../core/discovery.js';
import { Tuner, PROFILES, MODE_KEYS, customProfile } from '../core/tuning.js';
import { Confidence, DEVICE_NAMES } from '../proto/registers.js';
import { Addr } from '../proto/frame.js';
import { IncompleteProfileError } from '../proto/session.js';

const $ = (id) => document.getElementById(id);
const el = (tag, className, text) => {
  const node = document.createElement(tag);
  if (className) node.className = className;
  if (text !== undefined) node.textContent = text;
  return node;
};

const PROFILE_FILES = ['profiles/mi4lite-gen2.json', 'profiles/m365.json'];
const DERIVED_STORAGE_KEY = 'scoot-unlock:derived';

const state = {
  profiles: [],
  profile: null,
  scooter: null,
  discovery: null,
  tuner: null,
  sweepResults: [],
  currentLimits: new Map(), // key -> value as last read from the scooter
  edited: new Map(),        // key -> value typed into the per-mode editor
  snapshots: { A: null, B: null },
  expertMode: false,
};

// ---------------------------------------------------------------- bootstrap ---

async function init() {
  state.profiles = await Promise.all(
    PROFILE_FILES.map((path) => fetch(path).then((r) => r.json()))
  );

  const select = $('profileSelect');
  for (const p of state.profiles) select.append(new Option(p.label, p.id));
  select.addEventListener('change', () => selectProfile(select.value));
  selectProfile(state.profiles[0].id);

  setupTabs();
  setupConnect();
  setupSpeed();
  setupDiscovery();
  setupConsole();
  renderTuningProfiles();

  if (!BleTransport.available) {
    $('connectHint').textContent =
      'This browser has no Web Bluetooth, so only the simulator will work here. Use Chrome or Edge (Android, ' +
      'Windows, macOS, Linux, ChromeOS), or Bluefy on iOS.';
    $('connectBtn').disabled = true;
  }
}

function selectProfile(id) {
  state.profile = structuredClone(state.profiles.find((p) => p.id === id));
  state.profile.registers ??= {};
  state.profile.registers.derived = loadDerived(id);

  $('profileLabel').textContent = state.profile.label;
  const derivedCount = state.profile.registers.derived.length;
  $('profileNote').textContent = derivedCount
    ? `${derivedCount} register${derivedCount === 1 ? '' : 's'} confirmed on this scooter and remembered.`
    : (state.profile.notes ?? 'No registers confirmed yet — run Discovery before writing anything.');
}

function setupTabs() {
  for (const tab of document.querySelectorAll('.tab')) {
    tab.addEventListener('click', () => {
      document.querySelectorAll('.tab').forEach((t) => t.classList.toggle('is-active', t === tab));
      document.querySelectorAll('.panel').forEach((p) =>
        p.classList.toggle('is-active', p.id === `panel-${tab.dataset.panel}`)
      );
    });
  }
}

// ------------------------------------------------------------------ connect ---

function setupConnect() {
  $('connectBtn').addEventListener('click', () => connect({ simulated: false }));
  $('simulatorBtn').addEventListener('click', () => connect({ simulated: true }));
  $('disconnectBtn').addEventListener('click', disconnect);
  $('readIdentityBtn').addEventListener('click', readIdentity);
}

async function connect({ simulated }) {
  try {
    setLink('busy', simulated ? 'Starting simulator' : 'Pairing');

    const transport = simulated
      ? new MockTransport(state.profile.protocol)
      : new BleTransport();

    // The simulator stands in for the controller, not for the radio link, so it
    // speaks the selected protocol with the session layer switched off. That
    // keeps the whole app testable on a model whose handshake is not known yet.
    const profile = simulated
      ? { ...state.profile, session: { type: 'plaintext' } }
      : state.profile;

    if (!simulated) {
      await transport.requestDevice();
      await transport.connect(state.profile.transport?.preferService);
    } else {
      await transport.connect();
    }

    const scooter = new Scooter(transport, profile);
    wireScooter(scooter);
    state.scooter = scooter;
    state.discovery = new Discovery(scooter);
    state.tuner = new Tuner(scooter, { expertMode: state.expertMode });

    await scooter.open(); // runs the handshake for encrypted profiles

    setLink('connected', transport.deviceName ?? 'Connected');
    $('disconnectBtn').hidden = false;
    $('identityCard').hidden = false;
    $('snapABtn').disabled = false;
    toast('ok', `Connected to ${transport.deviceName ?? 'scooter'}`);

    await readIdentity();
    await refreshLimits();
  } catch (err) {
    setLink('error', 'Failed');
    if (err instanceof IncompleteProfileError || err.actionable) {
      // The BLE link is up; only the encrypted session could not be negotiated.
      setLink('busy', 'Link up, session incomplete');
      showModal({
        title: 'Encrypted session not configured',
        body: [
          err.message,
          'The Bluetooth link itself is working — the scooter simply will not accept frames until the session ' +
            'key is negotiated. The handshake constants for this firmware are not public, so they have to be ' +
            'captured once from your own scooter.',
          'docs/NEEDED-INFO.md walks through capturing them with an Android HCI snoop log.',
        ],
        confirmText: 'Got it',
        onConfirm: () => {},
      });
    } else if (err.name !== 'NotFoundError') {
      // NotFoundError just means the chooser was dismissed.
      toast('err', err.message);
    } else {
      setLink('offline', 'Not connected');
    }
  }
}

function wireScooter(scooter) {
  scooter.on('traffic', ({ dir, bytes, phase }) => logTraffic(dir, bytes, phase));
  scooter.on('warning', ({ message }) => toast('warn', message));
  scooter.on('write', renderChangeLog);
  scooter.on('reverted', () => {
    renderChangeLog();
    refreshLimits();
  });
  scooter.on('status', ({ detail }) => logTraffic('info', detail));
  scooter.on('disconnected', () => {
    state.edited.clear();
    setLink('offline', 'Disconnected');
    toast('warn', 'The scooter dropped the connection.');
    $('disconnectBtn').hidden = true;
  });
  scooter.on('registers-updated', () => {
    refreshLimits();
    renderTuningProfiles();
  });
}

async function disconnect() {
  await state.scooter?.transport.disconnect();
  state.scooter = null;
  setLink('offline', 'Not connected');
  $('disconnectBtn').hidden = true;
}

async function readIdentity() {
  if (!state.scooter) return;
  const list = $('identityList');
  list.replaceChildren();

  const defs = state.scooter.registers.filter((r) => !r.writable && !r.group && r.size >= 2);
  for (const def of defs.slice(0, 8)) {
    const { value } = await state.scooter.read(def);
    const dt = el('dt', null, def.label);
    const dd = el('dd', null, value === null ? '—' : `${value}${def.unit ? ` ${def.unit}` : ''}`);
    list.append(dt, dd);
  }
  if (!list.children.length) list.append(el('dd', 'hint', 'No identity registers answered.'));
}

// -------------------------------------------------------------------- speed ---

function setupSpeed() {
  $('refreshLimitsBtn').addEventListener('click', refreshLimits);
  $('applyCustomBtn').addEventListener('click', applyCustomLimits);
  $('resetCustomBtn').addEventListener('click', () => {
    state.edited.clear();
    renderModeEditor();
  });
  $('revertBtn').addEventListener('click', revertAll);
  $('exportChangesBtn').addEventListener('click', () =>
    download('scoot-unlock-changes.json', JSON.stringify(state.scooter?.changeLog ?? [], null, 2))
  );
  $('expertToggle').addEventListener('change', (e) => {
    state.expertMode = e.target.checked;
    if (state.tuner) state.tuner.expertMode = state.expertMode;
    if (state.expertMode) {
      toast('warn', 'Expert mode on — unconfirmed addresses can now be written.');
    }
    renderTuningProfiles();
  });
}

async function refreshLimits() {
  const container = $('currentLimits');
  if (!state.scooter) {
    container.replaceChildren(el('p', 'hint', 'Connect to read the scooter\'s limits.'));
    state.currentLimits.clear();
    renderModeEditor();
    return;
  }

  container.replaceChildren(el('p', 'hint', 'Reading…'));
  const results = await state.tuner.readCurrent();
  container.replaceChildren();

  state.currentLimits = new Map(results.filter((r) => r.value !== null).map((r) => [r.def.key, r.value]));

  for (const { def, value } of results) {
    const card = el('div', 'limit');
    card.append(el('div', 'name', def.label.replace('Speed limit — ', '')));

    const valueEl = el('div', 'value');
    valueEl.textContent = value === null ? '—' : String(value);
    if (value !== null && def.unit) valueEl.append(el('small', null, def.unit));
    card.append(valueEl);

    card.append(el('div', 'addr', `${DEVICE_NAMES[def.device] ?? def.device} 0x${hex(def.addr)}`));
    const badge = el('span', 'badge', def.confidence);
    badge.dataset.c = def.confidence;
    card.append(badge);
    container.append(card);
  }

  if (!results.length) container.append(el('p', 'hint', 'No speed registers mapped for this profile.'));

  renderModeEditor();
}

// ------------------------------------------------------------ mode editor ---

/**
 * One slider + number box per drive mode. Values start at whatever the scooter
 * reports and stay editable independently, so Drive 25 / Sport 40 is just two
 * boxes rather than a preset someone has to have thought of in advance.
 */
function renderModeEditor() {
  const container = $('modeEditor');
  container.replaceChildren();

  if (!state.scooter) {
    container.append(el('p', 'hint', 'Connect to edit the limits.'));
    $('applyCustomBtn').disabled = true;
    return;
  }

  const ceiling = state.tuner.hardCeiling;
  const warnAbove = state.tuner.warnAbove;
  const defs = MODE_KEYS.map((key) => state.scooter.registers.find((r) => r.key === key)).filter(Boolean);

  if (!defs.length) {
    container.append(el('p', 'hint', 'No per-mode speed registers are mapped for this profile.'));
    $('applyCustomBtn').disabled = true;
    return;
  }

  for (const def of defs) {
    const current = state.currentLimits.get(def.key) ?? null;
    const value = state.edited.get(def.key) ?? current ?? 20;

    const row = el('div', 'mode-row');
    row.dataset.key = def.key;

    const head = el('div', 'mode-head');
    head.append(el('span', 'mode-name', def.label.replace('Speed limit — ', '')));
    head.append(el('span', 'mode-current', current === null ? 'not read' : `now ${current} km/h`));
    row.append(head);

    const controls = el('div', 'mode-controls');
    const slider = Object.assign(document.createElement('input'), {
      type: 'range', min: 1, max: ceiling, step: 1, value,
    });
    const box = Object.assign(document.createElement('input'), {
      type: 'number', min: 1, max: ceiling, step: 1, value,
    });
    slider.setAttribute('aria-label', `${def.label} slider`);
    box.setAttribute('aria-label', def.label);

    controls.append(slider, box, el('span', 'unit', 'km/h'));
    row.append(controls);

    const note = el('p', 'mode-note');
    note.hidden = true;
    row.append(note);

    // Painting is separate from recording an edit, so simply rendering the row
    // does not count as the user having asked for a change.
    const paint = (raw) => {
      const clamped = Math.min(ceiling, Math.max(1, Math.round(Number(raw) || 1)));
      slider.value = clamped;
      box.value = clamped;

      row.classList.toggle('dirty', current !== null && clamped !== current);
      row.classList.toggle('over', clamped > warnAbove);
      note.hidden = clamped <= warnAbove;
      note.textContent = clamped > warnAbove
        ? `Past ~${warnAbove} km/h the motor, not this setting, decides the top speed.`
        : '';
      return clamped;
    };

    const edit = (raw) => {
      const clamped = paint(raw);
      state.edited.set(def.key, clamped);
      $('applyCustomBtn').disabled = !hasPendingChange();
    };

    slider.addEventListener('input', () => edit(slider.value));
    box.addEventListener('change', () => edit(box.value));
    paint(value);

    container.append(row);
  }

  $('applyCustomBtn').disabled = !hasPendingChange();
}

/** True when at least one edited value differs from what the scooter reports. */
function hasPendingChange() {
  return MODE_KEYS.some((k) => state.edited.has(k) && state.edited.get(k) !== state.currentLimits.get(k));
}

async function applyCustomLimits() {
  if (!state.scooter) return toast('warn', 'Connect to a scooter first.');

  const limits = Object.fromEntries(
    MODE_KEYS.filter((k) => state.edited.has(k)).map((k) => [k, state.edited.get(k)])
  );
  const changed = Object.entries(limits).filter(([k, v]) => state.currentLimits.get(k) !== v);

  if (!changed.length) return toast('warn', 'These are already the scooter\'s current limits.');

  await runProfile(customProfile(Object.fromEntries(changed)));
}

function renderTuningProfiles() {
  const list = $('profileList');
  list.replaceChildren();

  for (const profile of PROFILES) {
    const row = el('div', 'profile-row');
    const meta = el('div', 'meta');
    meta.append(el('div', 'title', profile.label));
    meta.append(el('div', 'desc', profile.description));
    row.append(meta);

    const btn = el('button', 'btn', 'Apply');
    btn.addEventListener('click', () => applyProfile(profile));
    row.append(btn);
    list.append(row);
  }
}

async function applyProfile(profile) {
  if (!state.scooter) return toast('warn', 'Connect to a scooter first.');
  await runProfile(profile);
}

/** Confirm a set of limits, then write them. Shared by presets and the editor. */
async function runProfile(profile) {
  const { blockers, warnings, ok } = state.tuner.validate(profile, state.currentLimits);
  const summary = Object.entries(profile.limits).map(([key, v]) => {
    const def = state.scooter.registers.find((r) => r.key === key);
    const from = state.currentLimits.get(key);
    return `${def?.label ?? key}: ${from ?? '?'} → ${v} km/h`;
  });

  showModal({
    title: ok ? `Apply “${profile.label}”?` : 'Cannot apply these limits',
    body: summary,
    blockers,
    warnings,
    confirmText: ok ? 'Write to scooter' : null,
    onConfirm: async () => {
      try {
        setLink('busy', 'Writing');
        await state.tuner.apply(profile, state.currentLimits);
        state.edited.clear();
        toast('ok', `${profile.label} applied and verified.`);
      } catch (err) {
        toast('err', err.message);
      } finally {
        setLink('connected', state.scooter.transport.deviceName ?? 'Connected');
        await refreshLimits();
        renderChangeLog();
      }
    },
  });
}

async function revertAll() {
  if (!state.scooter?.changeLog.length) return;
  showModal({
    title: 'Revert every change?',
    body: [`${state.scooter.changeLog.length} register write(s) will be put back to their previous values.`],
    confirmText: 'Revert',
    onConfirm: async () => {
      const restored = await state.scooter.revertAll();
      toast('ok', restored.length ? `Restored: ${restored.join(', ')}` : 'Nothing to restore.');
    },
  });
}

function renderChangeLog() {
  const container = $('changeLog');
  const log = state.scooter?.changeLog ?? [];
  $('revertBtn').disabled = log.length === 0;

  if (!log.length) {
    container.replaceChildren(el('p', 'hint', 'No changes yet.'));
    return;
  }

  container.replaceChildren();
  for (const entry of [...log].reverse()) {
    const div = el('div', `log-entry ${entry.verified === false ? 'bad' : 'ok'}`);
    div.append(el('strong', null, entry.label));
    div.append(document.createTextNode(` ${entry.from ?? '?'} → ${entry.to}`));
    const detail = entry.verified === false ? ` · read back ${entry.readBack ?? 'nothing'}` : ' · verified';
    div.append(el('div', 'mono', `${entry.device} 0x${hex(entry.addr)}${detail}`));
    container.append(div);
  }
}

// ---------------------------------------------------------------- discovery ---

function setupDiscovery() {
  $('sweepBtn').addEventListener('click', runSweep);
  $('cancelSweepBtn').addEventListener('click', () => state.discovery?.cancel());
  $('snapABtn').addEventListener('click', () => takeSnapshot('A'));
  $('snapBBtn').addEventListener('click', () => takeSnapshot('B'));
  $('diffBtn').addEventListener('click', renderDiff);
  $('exportDiscoveryBtn').addEventListener('click', () => {
    if (!state.discovery) return toast('warn', 'Nothing captured yet.');
    download('scoot-unlock-discovery.json', JSON.stringify(state.discovery.export(), null, 2));
  });
}

async function runSweep() {
  if (!state.scooter) return toast('warn', 'Connect to a scooter first.');

  const from = numberFrom($('sweepFrom').value);
  const to = numberFrom($('sweepTo').value);
  const device = Number($('sweepDevice').value);
  if (Number.isNaN(from) || Number.isNaN(to) || from > to) return toast('err', 'Check the address range.');

  const progress = $('sweepProgress');
  progress.hidden = false;
  $('cancelSweepBtn').hidden = false;
  $('sweepBtn').disabled = true;
  $('sweepResults').replaceChildren();

  const onProgress = ({ percent, addr }) => {
    progress.querySelector('.bar').style.setProperty('--pct', `${percent}%`);
    progress.querySelector('span').textContent = `0x${hex(addr)}`;
  };
  state.discovery.on('progress', onProgress);

  try {
    setLink('busy', 'Sweeping');
    state.sweepResults = await state.discovery.sweep({ device, from, to });
    renderSweep(state.sweepResults);
    const present = state.sweepResults.filter((r) => r.present).length;
    toast('ok', `${present} address${present === 1 ? '' : 'es'} returned data.`);
    $('snapABtn').disabled = present === 0;
  } catch (err) {
    toast('err', err.message);
  } finally {
    state.discovery.off('progress', onProgress);
    progress.hidden = true;
    $('cancelSweepBtn').hidden = true;
    $('sweepBtn').disabled = false;
    setLink('connected', state.scooter.transport.deviceName ?? 'Connected');
  }
}

function renderSweep(results) {
  const grid = $('sweepResults');
  grid.replaceChildren();
  for (const r of results) {
    const cell = el('div', `cell${r.present ? ' present' : ''}`);
    cell.append(el('b', null, `0x${hex(r.addr)}`));
    cell.append(document.createTextNode(r.present ? String(r.value) : '·'));
    cell.title = `0x${hex(r.addr)} = ${r.hex ?? 'no reply'}`;
    grid.append(cell);
  }
}

async function takeSnapshot(slot) {
  const addresses = state.sweepResults.filter((r) => r.present).map((r) => r.addr);
  if (!addresses.length) return toast('warn', 'Sweep first — there is nothing to snapshot.');

  setLink('busy', `Snapshot ${slot}`);
  const device = Number($('sweepDevice').value);
  state.snapshots[slot] = await state.discovery.snapshot(addresses, { label: `Snapshot ${slot}`, device });
  setLink('connected', state.scooter.transport.deviceName ?? 'Connected');

  toast('ok', slot === 'A'
    ? 'Snapshot A taken. Now change the speed limit or drive mode in the official app, then take B.'
    : 'Snapshot B taken. Diff them to find the register.');

  $('snapBBtn').disabled = !state.snapshots.A;
  $('diffBtn').disabled = !(state.snapshots.A && state.snapshots.B);
}

function renderDiff() {
  const { A, B } = state.snapshots;
  const container = $('diffResults');
  const changes = Discovery.diff(A, B);

  container.replaceChildren();
  if (!changes.length) {
    container.append(
      el('p', 'hint',
        'Nothing changed between the snapshots. Either the setting you altered lives outside the swept range, ' +
        'or the change had not been written to the controller yet — try a wider sweep, or power-cycle between snapshots.')
    );
    return;
  }

  const table = el('table', 'diff');
  const head = el('tr');
  for (const h of ['Addr', 'Before', 'After', 'Δ', '']) head.append(el('th', null, h));
  table.append(head);

  for (const change of changes) {
    const tr = el('tr');
    tr.append(el('td', null, `0x${hex(change.addr)}`));
    tr.append(el('td', null, `${change.before} (${change.beforeValue})`));
    tr.append(el('td', null, `${change.after} (${change.afterValue})`));
    tr.append(el('td', null, change.delta > 0 ? `+${change.delta}` : String(change.delta)));

    const cell = el('td');
    const btn = el('button', 'btn', 'This is it');
    btn.addEventListener('click', () => promoteChange(change));
    cell.append(btn);
    tr.append(cell);
    table.append(tr);
  }

  container.append(table);
  container.append(
    el('p', 'hint',
      'Pick the row whose value matches the limit you set — if you moved Sport from 25 to 20, look for exactly ' +
      'that. Promoting it teaches the app your scooter\'s real address, and lifts the write block for it.')
  );

  // Highlight the changed addresses back on the sweep map.
  const changed = new Set(changes.map((c) => c.addr));
  for (const cell of $('sweepResults').children) {
    const addr = parseInt(cell.textContent.slice(2, 4), 16);
    cell.classList.toggle('changed', changed.has(addr));
  }
}

function promoteChange(change) {
  const speedKeys = [
    ['limitSport', 'Speed limit — Sport'],
    ['limitDrive', 'Speed limit — Drive'],
    ['limitEco', 'Speed limit — Eco'],
    ['limitGlobal', 'Global speed cap'],
  ];

  const body = el('div');
  body.append(el('p', 'hint', `Address 0x${hex(change.addr)} moved ${change.beforeValue} → ${change.afterValue}. Which setting is it?`));
  const select = el('select');
  for (const [key, label] of speedKeys) select.append(new Option(label, key));
  body.append(select);

  showModal({
    title: 'Confirm this register',
    bodyNode: body,
    confirmText: 'Remember it',
    onConfirm: () => {
      const key = select.value;
      const label = speedKeys.find(([k]) => k === key)[1];
      const def = Discovery.promote(change, { key, label });

      state.scooter.adoptDerived([def]);
      const stored = [...loadDerived(state.profile.id).filter((d) => d.key !== key), serialiseDef(def)];
      saveDerived(state.profile.id, stored);
      state.profile.registers.derived = stored;

      toast('ok', `${label} is now mapped to 0x${hex(change.addr)} and remembered for next time.`);
      selectProfile(state.profile.id);
    },
  });
}

// Derived registers persist between sessions; codecs are re-attached on load.
const serialiseDef = (def) => ({ ...def, codec: undefined, codecName: 'u16' });

function loadDerived(profileId) {
  try {
    const raw = JSON.parse(localStorage.getItem(`${DERIVED_STORAGE_KEY}:${profileId}`) ?? '[]');
    return raw.map((d) => ({ ...d, codec: { decode: (b) => b[0] | (b[1] << 8), encode: (v) => new Uint8Array([v & 0xff, (v >> 8) & 0xff]), size: 2 } }));
  } catch {
    return [];
  }
}

function saveDerived(profileId, defs) {
  localStorage.setItem(`${DERIVED_STORAGE_KEY}:${profileId}`, JSON.stringify(defs));
}

// ------------------------------------------------------------------ console ---

function setupConsole() {
  $('manualReadBtn').addEventListener('click', manualRead);
  $('manualWriteBtn').addEventListener('click', manualWrite);
  $('clearLogBtn').addEventListener('click', () => ($('trafficLog').textContent = ''));
  $('exportLogBtn').addEventListener('click', () => download('scoot-unlock-traffic.log', $('trafficLog').textContent));
}

async function manualRead() {
  if (!state.scooter) return toast('warn', 'Connect first.');
  const addr = numberFrom($('manualAddr').value);
  const len = Number($('manualLen').value) || 2;
  const raw = await state.scooter.readRaw(addr, len, Addr.ESC);
  $('manualResult').textContent = raw
    ? `0x${hex(addr)} = ${hexBytes(raw)}  (${raw[0] | (raw[1] << 8)} as u16le)`
    : `0x${hex(addr)} did not answer.`;
}

async function manualWrite() {
  if (!state.scooter) return toast('warn', 'Connect first.');
  const addr = numberFrom($('manualAddr').value);
  const value = Number($('manualValue').value);
  if (Number.isNaN(value)) return toast('err', 'Enter a decimal value to write.');

  showModal({
    title: `Write ${value} to 0x${hex(addr)}?`,
    body: [
      'This is a raw write with no range check and no idea what lives at that address.',
      'The previous value is captured first, so it appears in the change log and can be reverted.',
    ],
    warnings: ['Only do this on an address you have confirmed by diffing snapshots.'],
    confirmText: 'Write',
    onConfirm: async () => {
      const def = {
        key: `manual_${hex(addr)}`,
        label: `Manual 0x${hex(addr)}`,
        addr,
        device: Addr.ESC,
        size: 2,
        codec: { decode: (b) => b[0] | (b[1] << 8), encode: (v) => new Uint8Array([v & 0xff, (v >> 8) & 0xff]), size: 2 },
        writable: true,
        confidence: Confidence.CANDIDATE,
      };
      const entry = await state.scooter.write(def, value, { reason: 'manual write' });
      $('manualResult').textContent = entry.verified
        ? `Wrote ${value}, read back ${entry.readBack}.`
        : `Wrote ${value} but read back ${entry.readBack ?? 'nothing'}.`;
      renderChangeLog();
    },
  });
}

function logTraffic(dir, payload, phase = '') {
  const pre = $('trafficLog');
  const stamp = new Date().toISOString().slice(11, 23);
  const cls = dir === 'tx' ? 'tx' : dir === 'rx' ? 'rx' : dir === 'info' ? 'hs' : 'err';
  const label = phase === 'handshake' ? `${dir.toUpperCase()}*` : dir.toUpperCase();
  const text = typeof payload === 'string' ? payload : hexBytes(payload);

  const line = el('span', cls, `${stamp}  ${label.padEnd(5)} ${text}\n`);
  pre.append(line);
  while (pre.children.length > 800) pre.firstChild.remove();
  if ($('autoscroll').checked) pre.scrollTop = pre.scrollHeight;
}

// ----------------------------------------------------------------- chrome ---

function setLink(stateName, text) {
  $('linkState').dataset.state = stateName;
  $('linkText').textContent = text;
}

function showModal({ title, body = [], bodyNode, blockers = [], warnings = [], confirmText, onConfirm }) {
  const backdrop = $('modalBackdrop');
  $('modalTitle').textContent = title;

  const container = $('modalBody');
  container.replaceChildren();
  if (bodyNode) container.append(bodyNode);
  if (body.length) {
    const ul = el('ul');
    for (const line of body) ul.append(el('li', null, line));
    container.append(ul);
  }
  for (const [items, cls, heading] of [[blockers, 'blocker', 'Blocked because'], [warnings, 'warning', 'Be aware']]) {
    if (!items.length) continue;
    container.append(el('p', cls, heading));
    const ul = el('ul', cls);
    for (const line of items) ul.append(el('li', null, line));
    container.append(ul);
  }

  const confirm = $('modalConfirm');
  confirm.hidden = !confirmText;
  confirm.textContent = confirmText ?? '';

  const close = () => {
    backdrop.hidden = true;
    confirm.onclick = null;
  };

  confirm.onclick = async () => {
    close();
    await onConfirm?.();
  };
  $('modalCancel').onclick = close;
  backdrop.hidden = false;
}

function toast(kind, message) {
  const node = el('div', `toast ${kind}`, message);
  $('toasts').append(node);
  setTimeout(() => node.remove(), kind === 'err' ? 9000 : 5000);
}

function download(filename, contents) {
  const url = URL.createObjectURL(new Blob([contents], { type: 'application/json' }));
  const a = Object.assign(document.createElement('a'), { href: url, download: filename });
  a.click();
  URL.revokeObjectURL(url);
}

const numberFrom = (text) => (String(text).trim().toLowerCase().startsWith('0x') ? parseInt(text, 16) : Number(text));

if ('serviceWorker' in navigator) {
  navigator.serviceWorker.register('sw.js').catch(() => {
    /* offline caching is a nicety; the app works without it */
  });
}

init().catch((err) => {
  console.error(err);
  document.body.prepend(el('div', 'toast err', `Startup failed: ${err.message}`));
});
