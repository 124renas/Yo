// Browser smoke test: serves the app, drives it in headless Chromium over the
// DevTools protocol, and checks the simulator path works from the UI —
// connect, read limits, apply a profile, revert, sweep, diff.
//
// Uses raw CDP over Node's built-in WebSocket so it needs no npm packages.

import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import { spawn } from 'node:child_process';
import assert from 'node:assert/strict';

const ROOT = path.resolve(import.meta.dirname, '..');
const PORT = 8123;
const CHROME = '/opt/pw-browsers/chromium';

const MIME = {
  '.html': 'text/html', '.css': 'text/css', '.js': 'text/javascript',
  '.json': 'application/json', '.webmanifest': 'application/manifest+json',
};

const server = http.createServer((req, res) => {
  const rel = decodeURIComponent(req.url.split('?')[0]);
  const file = path.join(ROOT, rel === '/' ? 'index.html' : rel);
  if (!file.startsWith(ROOT) || !fs.existsSync(file) || fs.statSync(file).isDirectory()) {
    res.writeHead(404).end('not found');
    return;
  }
  res.writeHead(200, { 'content-type': MIME[path.extname(file)] ?? 'application/octet-stream' });
  fs.createReadStream(file).pipe(res);
});
await new Promise((r) => server.listen(PORT, r));

const chrome = spawn(CHROME, [
  '--headless=new', '--no-sandbox', '--disable-gpu', '--disable-dev-shm-usage',
  '--remote-debugging-port=9222', 'about:blank',
], { stdio: 'ignore' });

// --- minimal CDP client -----------------------------------------------------
const wsUrl = await (async () => {
  for (let i = 0; i < 60; i++) {
    try {
      const res = await fetch('http://127.0.0.1:9222/json/version');
      return (await res.json()).webSocketDebuggerUrl;
    } catch {
      await new Promise((r) => setTimeout(r, 250));
    }
  }
  throw new Error('Chromium did not expose a debugging port');
})();

const ws = new WebSocket(wsUrl);
await new Promise((r) => (ws.onopen = r));

let nextId = 1;
const pending = new Map();
const consoleErrors = [];

ws.onmessage = (event) => {
  const msg = JSON.parse(event.data);
  if (msg.id && pending.has(msg.id)) {
    const { resolve, reject } = pending.get(msg.id);
    pending.delete(msg.id);
    msg.error ? reject(new Error(msg.error.message)) : resolve(msg.result);
  }
  if (msg.method === 'Runtime.exceptionThrown') {
    consoleErrors.push(msg.params.exceptionDetails.exception?.description ?? msg.params.exceptionDetails.text);
  }
};

const send = (method, params = {}, sessionId) =>
  new Promise((resolve, reject) => {
    const id = nextId++;
    pending.set(id, { resolve, reject });
    ws.send(JSON.stringify({ id, method, params, sessionId }));
  });

const { targetId } = await send('Target.createTarget', { url: 'about:blank' });
const { sessionId } = await send('Target.attachToTarget', { targetId, flatten: true });
await send('Runtime.enable', {}, sessionId);
await send('Page.enable', {}, sessionId);

/** Evaluate an expression in the page, awaiting promises, and return its value. */
async function evaluate(expression) {
  const { result, exceptionDetails } = await send(
    'Runtime.evaluate',
    { expression, awaitPromise: true, returnByValue: true },
    sessionId
  );
  if (exceptionDetails) throw new Error(exceptionDetails.exception?.description ?? exceptionDetails.text);
  return result.value;
}

const wait = (expression, label, timeout = 8000) =>
  (async () => {
    const deadline = Date.now() + timeout;
    while (Date.now() < deadline) {
      if (await evaluate(`!!(${expression})`)) return true;
      await new Promise((r) => setTimeout(r, 100));
    }
    throw new Error(`Timed out waiting for: ${label}`);
  })();

// --- the actual test --------------------------------------------------------
let failure = null;
try {
  await send('Page.navigate', { url: `http://127.0.0.1:${PORT}/index.html` }, sessionId);
  await wait('document.getElementById("profileSelect").options.length > 0', 'app to boot and load profiles');

  assert.equal(
    await evaluate('document.getElementById("profileSelect").options.length'),
    2,
    'both device profiles load'
  );

  // Connect to the simulator.
  await evaluate('document.getElementById("simulatorBtn").click()');
  await wait('document.getElementById("linkState").dataset.state === "connected"', 'simulator connection');

  // Speed panel should show the stock limits read back from the simulated ESC.
  await evaluate('document.querySelector(\'[data-panel="speed"]\').click()');
  await wait('document.querySelectorAll("#currentLimits .limit").length >= 3', 'limits to render');

  const limits = await evaluate(`
    Array.from(document.querySelectorAll('#currentLimits .limit'))
      .map(c => c.querySelector('.name').textContent + '=' + c.querySelector('.value').textContent.replace(/[^0-9]/g,''))
  `);
  assert.ok(limits.includes('Sport=25'), `Sport reads 25 km/h from the simulator (got ${limits})`);

  // Applying while the address is unconfirmed must be refused, with a reason.
  await evaluate(`Array.from(document.querySelectorAll('.profile-row')).find(r => r.textContent.includes('Derestricted')).querySelector('.btn').click()`);
  await wait('!document.getElementById("modalBackdrop").hidden', 'confirmation dialog');
  const blocked = await evaluate('document.getElementById("modalBody").textContent');
  assert.match(blocked, /has not been confirmed on your scooter/, 'the dialog explains the block');
  assert.equal(await evaluate('document.getElementById("modalConfirm").hidden'), true, 'no confirm button while blocked');
  await evaluate('document.getElementById("modalCancel").click()');

  // Turn on expert mode and apply for real.
  await evaluate('document.getElementById("expertToggle").click()');
  await evaluate(`Array.from(document.querySelectorAll('.profile-row')).find(r => r.textContent.includes('Derestricted')).querySelector('.btn').click()`);
  await wait('!document.getElementById("modalBackdrop").hidden', 'apply dialog');
  assert.equal(await evaluate('document.getElementById("modalConfirm").hidden'), false, 'confirm is offered in expert mode');
  await evaluate('document.getElementById("modalConfirm").click()');

  await wait(
    `Array.from(document.querySelectorAll('#currentLimits .limit')).some(c => c.textContent.includes('Sport') && c.querySelector('.value').textContent.includes('30'))`,
    'Sport limit to reach 30'
  );
  assert.match(await evaluate('document.getElementById("changeLog").textContent'), /verified/, 'writes are logged as verified');

  // Revert puts it back.
  await evaluate('document.getElementById("revertBtn").click()');
  await wait('!document.getElementById("modalBackdrop").hidden', 'revert dialog');
  await evaluate('document.getElementById("modalConfirm").click()');
  await wait(
    `Array.from(document.querySelectorAll('#currentLimits .limit')).some(c => c.textContent.includes('Sport') && c.querySelector('.value').textContent.includes('25'))`,
    'Sport limit back to 25'
  );

  // Per-mode editor: set Drive and Sport independently and write them together.
  await wait('document.querySelectorAll("#modeEditor .mode-row").length === 3', 'mode editor to render');
  assert.equal(await evaluate('document.getElementById("applyCustomBtn").disabled'), true,
    'nothing to write until something is actually changed');

  const setMode = (key, value) => evaluate(`
    (() => {
      const row = document.querySelector('.mode-row[data-key="${key}"]');
      const box = row.querySelector('input[type=number]');
      box.value = ${value};
      box.dispatchEvent(new Event('change'));
      return row.querySelector('input[type=range]').value;
    })()
  `);

  assert.equal(await setMode('limitDrive', 25), '25', 'slider follows the number box');
  assert.equal(await setMode('limitSport', 40), '40', 'Sport accepts 40');
  assert.equal(await evaluate('document.getElementById("applyCustomBtn").disabled'), false,
    'editing enables the write button');
  assert.equal(
    await evaluate(`document.querySelector('.mode-row[data-key="limitSport"]').classList.contains('over')`),
    true, 'Sport at 40 is flagged as past the motor limit');

  // Values above the ceiling are clamped rather than sent.
  assert.equal(await setMode('limitSport', 99), '40', 'input above the ceiling clamps to 40');

  await evaluate('document.getElementById("applyCustomBtn").click()');
  await wait('!document.getElementById("modalBackdrop").hidden', 'custom apply dialog');
  const customBody = await evaluate('document.getElementById("modalBody").textContent');
  assert.match(customBody, /Sport: 25 → 40 km\/h/, 'the dialog shows the per-mode change');
  assert.match(customBody, /motor is the limit rather than the setting/, 'and the motor-limit warning');
  await evaluate('document.getElementById("modalConfirm").click()');

  await wait(
    `Array.from(document.querySelectorAll('#currentLimits .limit')).some(c => c.textContent.includes('Sport') && c.querySelector('.value').textContent.includes('40'))`,
    'Sport limit to reach 40'
  );
  const afterCustom = await evaluate(`
    Array.from(document.querySelectorAll('#currentLimits .limit'))
      .map(c => c.querySelector('.name').textContent + '=' + c.querySelector('.value').textContent.replace(/[^0-9]/g,''))
  `);
  assert.ok(afterCustom.includes('Drive=25'), `Drive is 25 (got ${afterCustom})`);
  assert.ok(afterCustom.includes('Sport=40'), `Sport is 40 (got ${afterCustom})`);

  // Discovery sweep renders the address map.
  await evaluate('document.querySelector(\'[data-panel="discovery"]\').click()');
  await evaluate('document.getElementById("sweepFrom").value = "0x70"; document.getElementById("sweepTo").value = "0x7F";');
  await evaluate('document.getElementById("sweepBtn").click()');
  await wait('document.querySelectorAll("#sweepResults .cell").length === 16', 'sweep to finish', 20000);
  assert.ok(
    await evaluate('document.querySelectorAll("#sweepResults .cell.present").length >= 5'),
    'the sweep marks populated addresses as present'
  );

  // Traffic log recorded real frames.
  await evaluate('document.querySelector(\'[data-panel="console"]\').click()');
  assert.match(await evaluate('document.getElementById("trafficLog").textContent'), /5A A5/, 'NB frames appear in the traffic log');

  assert.deepEqual(consoleErrors, [], 'no uncaught exceptions in the page');
  console.log('ui.smoke.mjs: UI drives the full flow in Chromium — connect, read, gate, apply, revert, sweep');
} catch (err) {
  failure = err;
  console.error('ui.smoke.mjs FAILED:', err.message);
  if (consoleErrors.length) console.error('page errors:\n  ' + consoleErrors.join('\n  '));
} finally {
  ws.close();
  chrome.kill();
  server.close();
}

process.exit(failure ? 1 : 0);
