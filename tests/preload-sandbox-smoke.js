'use strict';

// Exercise the production preload under Electron's real sandbox. A VM mock
// cannot detect dependencies that Electron deliberately omits from sandboxed
// preload `require`, which previously left packaged windows without any IPC
// bridges even though renderer-only UI tests passed.
const assert = require('assert');
const path = require('path');
const { app, BrowserWindow, ipcMain } = require('electron');

const EXPECTED_VERSION = 'sandbox-preload-test';
process.env.KNOT_APP_VERSION = EXPECTED_VERSION;

let window;
const timeout = setTimeout(() => {
  console.error('sandboxed preload smoke test timed out');
  app.exit(1);
}, 15000);

app.whenReady().then(async () => {
  let bridgeDocumentId = '';
  ipcMain.on('pair:bridgeReady', (_event, value) => { bridgeDocumentId = value; });
  const preloadErrors = [];
  window = new BrowserWindow({
    show: false,
    webPreferences: {
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
      offscreen: true,
      preload: path.join(__dirname, '..', 'preload.js'),
    },
  });
  window.webContents.on('preload-error', (_event, preloadPath, error) => {
    preloadErrors.push(`${preloadPath}: ${error?.stack || error}`);
  });
  await window.loadURL('data:text/html,<title>preload sandbox smoke</title>');
  const exposed = await window.webContents.executeJavaScript(`({
    version: window.pairEnv?.version,
    platform: window.pairEnv?.platform,
    bridges: [
      'pairSave', 'pairDirectFile', 'pairSettings', 'pairDeepFilter',
      'pairUpdates', 'pairEnv', 'pairCapture', 'pairEmojiCatalog',
      'pairNativeScreen', 'pairLan'
    ].every(name => typeof window[name] === 'object')
  })`);
  assert.deepStrictEqual(preloadErrors, [], preloadErrors.join('\n'));
  assert.strictEqual(exposed.bridges, true, 'production preload did not expose every IPC bridge');
  assert.strictEqual(exposed.version, EXPECTED_VERSION, 'sandboxed preload did not receive the trusted app version');
  assert.strictEqual(exposed.platform, process.platform);
  assert.match(bridgeDocumentId, /^[a-f0-9]{32}$/, 'bridge document nonce was not registered');
  clearTimeout(timeout);
  window.destroy();
  console.log('sandboxed production preload smoke test passed');
  app.quit();
}).catch(error => {
  clearTimeout(timeout);
  console.error(error);
  app.exit(1);
});

app.on('window-all-closed', () => app.quit());
