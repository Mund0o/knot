const { app, BrowserWindow } = require('electron');
const { linuxMainGpu, applyLinuxMainGpuEnvironment } = require('../linux-gpu');

const selected = linuxMainGpu();
if (process.platform !== 'linux' || !selected) {
  console.log('SKIP Linux discrete GPU runtime check (no discrete render node)');
  app.exit(0);
} else {
  applyLinuxMainGpuEnvironment(selected);
  app.commandLine.appendSwitch('hardware-video-device-path', selected.renderNode);
  app.commandLine.appendSwitch('force-high-performance-gpu');
  if (process.env.XDG_SESSION_TYPE === 'wayland' || process.env.WAYLAND_DISPLAY) {
    app.commandLine.appendSwitch('disable-features', 'Vulkan');
    app.commandLine.appendSwitch('use-vulkan', 'disabled');
  }
}

function fail(message, detail) {
  console.error('Linux GPU runtime check failed:', message, detail || '');
  app.exit(1);
}

app.whenReady().then(async () => {
  const window = new BrowserWindow({
    show: false,
    webPreferences: { offscreen: true, contextIsolation: true, sandbox: true }
  });
  try {
    await window.loadURL('data:text/html,<canvas id="gpu"></canvas><script>gpu.getContext("webgl",{powerPreference:"high-performance"})</script>');
    await new Promise(resolve => setTimeout(resolve, 1000));
    const info = await app.getGPUInfo('basic');
    const active = info.gpuDevice?.find(device => device.active);
    const expectedVendor = Number.parseInt(selected.vendor, 16);
    if (!active) return fail('Chromium did not report an active GPU', JSON.stringify(info.gpuDevice));
    if (active.vendorId !== expectedVendor) {
      return fail(`expected vendor ${selected.vendor}, got 0x${active.vendorId.toString(16)}`, JSON.stringify(info.gpuDevice));
    }
    console.log(`PASS Chromium active GPU is discrete vendor ${selected.vendor} at ${selected.pciAddress}`);
    app.exit(0);
  } catch (error) {
    fail(error?.message || error);
  }
});
