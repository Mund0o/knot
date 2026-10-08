'use strict';

// Loaded ahead of every Electron test script and every app the e2e rig starts (NODE_OPTIONS=--require, set by run-electron-smoke.js and
// tests/e2e/rig.js; the real app never loads it). Tests need real windows, but a person using the computer must never notice them:
// whatever a test asks for, its windows are invisible, cannot take keyboard focus, are not in the taskbar and are never raised or kept on
// top of what the person is doing. A video playing full screen in another window keeps playing and keeps its focus.
const Module = require('module');

const originalLoad = Module._load;
let quiet = null;

function makeQuiet(electron) {
  const Real = electron.BrowserWindow;
  class QuietBrowserWindow extends Real {
    constructor(options = {}) {
      const { alwaysOnTop, ...rest } = options || {};
      const visible = rest.show !== false;
      super({ ...rest, focusable: false, skipTaskbar: true, alwaysOnTop: false, ...(visible ? { opacity: 0 } : {}) });
      this.__quiet = true;
    }
    show() { return super.showInactive(); }
    focus() {}
    moveTop() {}
    setAlwaysOnTop() {}
    setFocusable() {}
    setOpacity(value) { return super.setOpacity(this.isVisible() ? 0 : value); }
    setSkipTaskbar() {}
  }
  return QuietBrowserWindow;
}

Module._load = function load(request) {
  const exported = originalLoad.apply(this, arguments);
  if (request !== 'electron' || !exported || typeof exported !== 'object' || !exported.BrowserWindow) return exported;
  if (!quiet) quiet = { Quiet: makeQuiet(exported) };
  return new Proxy(exported, { get: (target, key) => (key === 'BrowserWindow' ? quiet.Quiet : target[key]) });
};
