'use strict';

const { spawnSync } = require('child_process');
const fs = require('fs');
const path = require('path');
const electron = require('electron');

const root = path.join(__dirname, '..');
const requested = String(process.argv[2] || '');
const script = path.resolve(root, requested);
if (!requested || !script.startsWith(path.resolve(__dirname) + path.sep) || !fs.statSync(script).isFile()) {
  throw new Error('run-electron-smoke requires a test script inside tests/');
}

// Test windows must never appear on the screen of the person using the computer, take its keyboard focus or sit above what they are doing:
// Linux ignores a window's opacity, so a "transparent" window is an ordinary visible one. --headless runs Chromium with no display at all
// (windows exist, render, run animation frames and can be captured, but nothing is shown), so that is how tests run. KNOT_TEST_VISIBLE=1
// shows real windows under XWayland instead, for the few checks that need the real GPU and compositor. (Do not add --ozone-platform=headless: it
// starts when --headless alone hangs, but then no window that is not offscreen can be created: Electron crashes. A start that hangs is what the timeout
// below is for.)
const flags = process.platform === 'linux'
  ? process.env.KNOT_TEST_VISIBLE === '1' ? (process.env.XDG_SESSION_TYPE === 'wayland' && process.env.DISPLAY ? ['--ozone-platform=x11'] : []) : ['--headless']
  : [];
const environment = { ...process.env };
delete environment.ELECTRON_RUN_AS_NODE;
if(flags.length)environment.KNOT_ELECTRON_SMOKE_X11='1';
// Test windows must never take focus from, or appear over, what the person at the keyboard is doing (see tests/quiet-windows.js).
const guard = path.join(__dirname, 'quiet-windows.js');
environment.NODE_OPTIONS = `${environment.NODE_OPTIONS ? environment.NODE_OPTIONS + ' ' : ''}--require ${JSON.stringify(guard)}`;      // quoted: the project path has a space
// Electron on this desktop now and then stalls before it runs anything (seen: 1 run in about 12, and a suite waited 17 minutes on it). A run that does not
// finish in time is killed and tried once more; a test that really hangs hangs twice and fails.
const TIMEOUT_MS = Number(process.env.KNOT_TEST_TIMEOUT_MS) || 240000;
let result = null;
for (let attempt = 1; attempt <= 2; attempt++) {
  result = spawnSync(electron, [...flags, script, ...process.argv.slice(3)], { cwd: root, env: environment, stdio: 'inherit', timeout: TIMEOUT_MS, killSignal: 'SIGKILL' });
  if (result.error?.code !== 'ETIMEDOUT') break;
  console.error(`${path.basename(script)} did not finish in ${Math.round(TIMEOUT_MS / 1000)} s (attempt ${attempt} of 2)`);
}
if (result.error && result.error.code !== 'ETIMEDOUT') throw result.error;
if (result.error) process.exitCode = 1;
else if (result.signal) {
  console.error(`${path.basename(script)} exited with signal ${result.signal}`);
  process.exitCode = 1;
} else {
  process.exitCode = result.status ?? 1;
}
