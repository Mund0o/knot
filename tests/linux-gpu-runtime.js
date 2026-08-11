const { app, BrowserWindow } = require('electron');
const { linuxMainGpu, applyLinuxMainGpuEnvironment } = require('../linux-gpu');
const { applyGpuAccelerationPolicy, acceleratedFeature } = require('../gpu-acceleration');

const selected = linuxMainGpu();
if (process.platform !== 'linux' || !selected) {
  console.log('SKIP Linux discrete GPU runtime check (no discrete render node)');
  app.exit(0);
} else {
  applyLinuxMainGpuEnvironment(selected);
  applyGpuAccelerationPolicy(app, { platform: process.platform, gpu: selected, wayland: !!(process.env.XDG_SESSION_TYPE === 'wayland' || process.env.WAYLAND_DISPLAY) });
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
    const status = app.getGPUFeatureStatus();
    for (const feature of ['2d_canvas', 'gpu_compositing', 'rasterization', 'video_decode', 'video_encode', 'webgl', 'webgpu']) {
      if (!acceleratedFeature(status[feature])) return fail(`${feature} is not GPU accelerated`, JSON.stringify(status));
    }
    console.log('[gpu features]', JSON.stringify(status));
    console.log(`PASS Chromium active GPU is discrete vendor ${selected.vendor} at ${selected.pciAddress}`);
    app.exit(0);
  } catch (error) {
    fail(error?.message || error);
  }
});
