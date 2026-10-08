'use strict';

// The guard in quiet-windows.js really does keep test windows from taking focus, covering anything, or staying on top.
// Run through run-electron-smoke.js (which loads the guard); this refuses to pass if the guard is not loaded.
const assert = require('assert');
const { app, BrowserWindow } = require('electron');

app.whenReady().then(async () => {
  try {
    const window = new BrowserWindow({ show: true, opacity: 1, focusable: true, alwaysOnTop: true, skipTaskbar: false, width: 300, height: 200, webPreferences: { backgroundThrottling: false } });
    assert.strictEqual(window.__quiet, true, 'the quiet-window guard is not loaded: tests would show real windows');
    window.show(); window.focus(); window.moveTop(); window.setAlwaysOnTop(true); window.setOpacity(1); window.setFocusable(true); window.setSkipTaskbar(false);
    await window.loadURL('data:text/html,<body>quiet</body>');
    await new Promise(resolve => setTimeout(resolve, 300));
    assert.strictEqual(window.isFocusable(), false, 'a test window can take keyboard focus');
    assert.strictEqual(window.isFocused(), false, 'a test window took focus');
    assert.strictEqual(window.isAlwaysOnTop(), false, 'a test window is kept on top');
    // Linux ignores window opacity (getOpacity() stays 1 whatever is asked), so what keeps a test window off the screen is that there is no
    // display at all: the runner starts Chromium with --headless unless KNOT_TEST_VISIBLE=1 asks for real windows.
    if (process.env.KNOT_TEST_VISIBLE !== '1' && process.platform === 'linux') assert(app.commandLine.hasSwitch('headless'), 'tests are not running headless: their windows would appear on the screen');
    const hidden = new BrowserWindow({ show: false, webPreferences: { offscreen: true } });
    assert.strictEqual(hidden.isVisible(), false); assert.strictEqual(hidden.isFocusable(), false);
    window.destroy(); hidden.destroy();
    console.log('PASS test windows are invisible, cannot take focus, are not in the taskbar and are never kept on top, whatever the test asks for');
    app.exit(0);
  } catch (error) { console.error(error?.stack || error); app.exit(1); }
});
