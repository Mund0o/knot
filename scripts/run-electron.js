'use strict';

const { spawnSync } = require('child_process');
const electron = require('electron');

// Chromium chooses its Ozone backend before Knot's main script executes. On
// affected Wayland compositor/driver combinations Electron 42/43 can stall
// before `app.ready`; select the accelerated XWayland path at process launch.
// Screen capture and native AV1 encoding are separate GPU-native services.
const flags = process.platform === 'linux'
  && process.env.XDG_SESSION_TYPE === 'wayland'
  && process.env.DISPLAY
  ? ['--ozone-platform=x11']
  : [];
const environment = { ...process.env };
delete environment.ELECTRON_RUN_AS_NODE;
const result = spawnSync(electron, [...flags, '.', ...process.argv.slice(2)], {
  cwd: require('path').join(__dirname, '..'),
  env: environment,
  stdio: 'inherit'
});
if (result.error) throw result.error;
if (result.signal) {
  console.error(`Electron exited with signal ${result.signal}`);
  process.exitCode = 1;
} else {
  process.exitCode = result.status ?? 1;
}
