const { spawnSync } = require('child_process');
const { linuxMainGpu } = require('../linux-gpu');
const { nativeScreenInfo } = require('../native-screen');

function run(script) {
  const env = { ...process.env };
  delete env.ELECTRON_RUN_AS_NODE;
  const result = spawnSync(process.platform === 'win32' ? 'npm.cmd' : 'npm', ['run', script], { stdio: 'inherit', env });
  if (result.error) throw result.error;
  if (result.status !== 0) process.exit(result.status || 1);
}

const gpu = linuxMainGpu();
const native = gpu ? nativeScreenInfo(gpu.vendor, gpu.card) : { supported: false };
if (native.supported) {
  console.log(`Testing production ${native.encoder} route on ${native.cardPath}`);
  run('test:screen:native');
  // Screen-share responsiveness must be measured inside two complete Knot
  // renderers with voice, messages, friends, servers, and a constrained uplink.
  run('test:screen:full');
} else {
  console.log('Native GPU AV1 route unavailable; testing Chromium codec fallbacks');
  run('test:screen:h264');
  run('test:screen:av1');
}
