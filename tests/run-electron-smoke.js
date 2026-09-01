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

// Chromium can choose Wayland before an Electron main script gets a chance to
// append command-line switches. Never-shown sandboxed/offscreen windows can
// then stall before app.whenReady on some compositors. Select XWayland at
// process launch when available. GPU assertions still inspect Chromium's real
// hardware status, while screen tests exercise Knot's separate native capture
// and encoder service rather than Chromium's Ozone compositor.
const flags = process.platform === 'linux'
  && process.env.XDG_SESSION_TYPE === 'wayland'
  && process.env.DISPLAY
  ? ['--ozone-platform=x11']
  : [];
const environment = { ...process.env };
delete environment.ELECTRON_RUN_AS_NODE;
if(flags.length)environment.KNOT_ELECTRON_SMOKE_X11='1';
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
