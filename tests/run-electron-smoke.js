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
// shows real windows under XWayland instead, for the few checks that need the real GPU and compositor.
const flags = process.platform === 'linux'
  ? process.env.KNOT_TEST_VISIBLE === '1' ? (process.env.XDG_SESSION_TYPE === 'wayland' && process.env.DISPLAY ? ['--ozone-platform=x11'] : []) : ['--headless']
  : [];
const environment = { ...process.env };
delete environment.ELECTRON_RUN_AS_NODE;
if(flags.length)environment.KNOT_ELECTRON_SMOKE_X11='1';
// Test windows must never take focus from, or appear over, what the person at the keyboard is doing (see tests/quiet-windows.js).
const guard = path.join(__dirname, 'quiet-windows.js');
environment.NODE_OPTIONS = `${environment.NODE_OPTIONS ? environment.NODE_OPTIONS + ' ' : ''}--require ${JSON.stringify(guard)}`;      // quoted: the project path has a space
const result = spawnSync(electron, [...flags, script, ...process.argv.slice(3)], {
  cwd: root,
  env: environment,
  stdio: 'inherit',
});
if (result.error) throw result.error;
if (result.signal) {
  console.error(`${path.basename(script)} exited with signal ${result.signal}`);
  process.exitCode = 1;
} else {
  process.exitCode = result.status ?? 1;
}
