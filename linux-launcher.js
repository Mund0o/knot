// Register packaged Linux builds with the desktop environment after their first
// graphical launch. This makes a portable tarball or AppImage appear in the
// Applications menu, so subsequent launches never require a terminal.
const fs = require('fs');
const path = require('path');
const { app } = require('electron');

function desktopExec(value) {
  // Desktop Entry's Exec value treats backslash, quote, and percent specially.
  return `"${String(value).replace(/\\/g, '\\\\').replace(/"/g, '\\"').replace(/%/g, '%%')}"`;
}

function installLinuxLauncher() {
  if (process.platform !== 'linux' || !app.isPackaged) return;
  try {
    const dataHome = process.env.XDG_DATA_HOME || path.join(app.getPath('home'), '.local', 'share');
    const applications = path.join(dataHome, 'applications');
    const desktopFile = path.join(applications, 'pair.desktop');
    const executable = path.resolve(process.execPath);
    const content = `[Desktop Entry]\nVersion=1.0\nType=Application\nName=Pair\nComment=Private two-person P2P chat\nExec=${desktopExec(executable)}\nTryExec=${desktopExec(executable)}\nTerminal=false\nCategories=Network;Chat;\nStartupWMClass=com.pair.p2p\nStartupNotify=true\n`;
    fs.mkdirSync(applications, { recursive: true, mode: 0o755 });
    // Always refresh this entry: AppImage auto-updates preserve their path, and
    // a moved portable install is corrected the next time it is opened.
    fs.writeFileSync(desktopFile, content, { encoding: 'utf8', mode: 0o644 });
    fs.chmodSync(desktopFile, 0o644);
  } catch (error) {
    // A read-only home directory should never prevent Pair from opening.
    console.log('[linux launcher] could not create desktop entry:', error.message);
  }
}

module.exports = { installLinuxLauncher, desktopExec };
