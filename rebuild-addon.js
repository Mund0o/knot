const { spawnSync } = require('child_process');
const path = require('path');

if (process.platform !== 'win32') {
  console.error('The pair-capture addon is Windows-only. Rebuild it from a Windows developer shell.');
  process.exit(1);
}

const electronVersion = require('./node_modules/electron/package.json').version;
const npx = process.platform === 'win32' ? 'npx.cmd' : 'npx';
const result = spawnSync(npx, [
  'node-gyp', 'rebuild', '--directory', path.join(__dirname, 'addon'),
  `--target=${electronVersion}`, '--arch=x64', '--dist-url=https://electronjs.org/headers'
], { cwd: __dirname, stdio: 'inherit' });

if (result.status !== 0) {
  console.error('Addon build failed with code', result.status ?? 'unknown');
  process.exit(result.status || 1);
}
console.log(`Windows capture addon rebuilt for Electron ${electronVersion}.`);
