const assert = require('assert');
const { gpuAccelerationPolicy, acceleratedFeature } = require('../gpu-acceleration');

const nvidia = { vendor: '0x10de', renderNode: '/dev/dri/renderD128', integrated: false };
const linux = gpuAccelerationPolicy({ platform: 'linux', gpu: nvidia, wayland: true });
assert(linux);
for (const name of ['force-high-performance-gpu', 'enable-gpu-rasterization', 'enable-zero-copy', 'disable-software-rasterizer', 'ignore-gpu-blocklist']) {
  assert(linux.switches.has(name), `missing ${name}`);
}
assert.strictEqual(linux.switches.get('hardware-video-device-path'), nvidia.renderNode);
assert.strictEqual(linux.switches.get('use-webgpu-adapter'), 'opengles');
for (const name of ['CanvasOopRasterization', 'AcceleratedVideoDecoder', 'AcceleratedVideoEncoder', 'AcceleratedVideoDecodeLinuxGL', 'AcceleratedVideoDecodeLinuxZeroCopyGL', 'VaapiOnNvidiaGPUs', 'WebRTCPipeWireCapturer']) {
  assert(linux.enableFeatures.includes(name), `missing ${name}`);
}
assert(linux.disableFeatures.includes('Vulkan'));
const amd = { vendor: '0x1002', renderNode: '/dev/dri/renderD130', integrated: false };
const amdLinux = gpuAccelerationPolicy({ platform: 'linux', gpu: amd, wayland: true });
assert(amdLinux);
assert.strictEqual(amdLinux.switches.get('hardware-video-device-path'), amd.renderNode);
assert.strictEqual(amdLinux.switches.get('use-webgpu-adapter'), 'opengles');
assert(!amdLinux.enableFeatures.includes('VaapiOnNvidiaGPUs'));
for (const name of ['AcceleratedVideoDecoder', 'AcceleratedVideoEncoder', 'AcceleratedVideoDecodeLinuxGL', 'AcceleratedVideoDecodeLinuxZeroCopyGL']) {
  assert(amdLinux.enableFeatures.includes(name), `AMD policy missing ${name}`);
}
assert.strictEqual(gpuAccelerationPolicy({ platform: 'linux', gpu: { integrated: true } }), null);

const windows = gpuAccelerationPolicy({ platform: 'win32' });
assert(windows.switches.has('force-high-performance-gpu'));
assert(windows.switches.has('enable-gpu-rasterization'));
assert(windows.enableFeatures.includes('CanvasOopRasterization'));
assert(windows.enableFeatures.includes('D3D12VideoEncodeAccelerator'));
assert(!windows.enableFeatures.includes('WebRTCPipeWireCapturer'));
assert(acceleratedFeature('enabled'));
assert(acceleratedFeature('enabled_force'));
assert(!acceleratedFeature('disabled_software'));
console.log('PASS full GPU acceleration policy');
