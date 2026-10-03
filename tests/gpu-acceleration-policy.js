const assert = require('assert');
const { gpuAccelerationPolicy, acceleratedFeature, applyWebRtcIcePolicy, WEBRTC_ICE_DISABLE_FEATURES } = require('../gpu-acceleration');

const nvidia = { vendor: '0x10de', renderNode: '/dev/dri/renderD128', integrated: false };
const linux = gpuAccelerationPolicy({ platform: 'linux', gpu: nvidia, wayland: true });
assert(linux);
for (const name of ['force-high-performance-gpu', 'enable-gpu-rasterization', 'enable-zero-copy', 'disable-software-rasterizer', 'ignore-gpu-blocklist']) {
  assert(linux.switches.has(name), `missing ${name}`);
}
assert(!linux.switches.has('hardware-video-device-path'), 'NVIDIA VA-API pinning paints received video white');
assert.strictEqual(linux.switches.get('use-webgpu-adapter'), 'opengles');
for (const name of ['CanvasOopRasterization', 'AcceleratedVideoDecoder', 'AcceleratedVideoEncoder', 'AcceleratedVideoDecodeLinuxGL', 'AcceleratedVideoDecodeLinuxZeroCopyGL', 'WebRTCPipeWireCapturer']) {
  assert(linux.enableFeatures.includes(name), `missing ${name}`);
}
assert(!linux.enableFeatures.includes('VaapiOnNvidiaGPUs'));
// A verified nvidia-vaapi-driver build (0.0.18+) decodes on the GPU.
const verifiedNvidia = gpuAccelerationPolicy({ platform: 'linux', gpu: nvidia, wayland: false, nvidiaVaapi: true });
assert.strictEqual(verifiedNvidia.switches.get('hardware-video-device-path'), nvidia.renderNode);
assert(verifiedNvidia.enableFeatures.includes('VaapiOnNvidiaGPUs') && verifiedNvidia.enableFeatures.includes('AcceleratedVideoDecodeLinuxGL'));
assert(verifiedNvidia.switches.has('ignore-gpu-blocklist'));
assert(linux.disableFeatures.includes('Vulkan'));
assert(linux.disableFeatures.includes('WebRtcHideLocalIpsWithMdns'));
assert(WEBRTC_ICE_DISABLE_FEATURES.includes('WebRtcHideLocalIpsWithMdns'));
const amd = { vendor: '0x1002', renderNode: '/dev/dri/renderD130', integrated: false };
const amdLinux = gpuAccelerationPolicy({ platform: 'linux', gpu: amd, wayland: true });
assert(amdLinux);
assert.strictEqual(amdLinux.switches.get('hardware-video-device-path'), amd.renderNode);
assert.strictEqual(amdLinux.switches.get('use-webgpu-adapter'), 'opengles');
assert(!amdLinux.enableFeatures.includes('VaapiOnNvidiaGPUs'));
assert(!gpuAccelerationPolicy({ platform: 'linux', gpu: amd, wayland: false, nvidiaVaapi: true }).enableFeatures.includes('VaapiOnNvidiaGPUs'), 'the NVIDIA VA-API switch never applies to AMD');
for (const name of ['AcceleratedVideoDecoder', 'AcceleratedVideoEncoder', 'AcceleratedVideoDecodeLinuxGL', 'AcceleratedVideoDecodeLinuxZeroCopyGL']) {
  assert(amdLinux.enableFeatures.includes(name), `AMD policy missing ${name}`);
}
const integratedLinux=gpuAccelerationPolicy({platform:'linux',gpu:{vendor:'0x8086',renderNode:'/dev/dri/renderD129',integrated:true},wayland:true});
assert(integratedLinux);assert.strictEqual(integratedLinux.switches.get('hardware-video-device-path'),'/dev/dri/renderD129');assert(integratedLinux.enableFeatures.includes('AcceleratedVideoDecoder'));

const windows = gpuAccelerationPolicy({ platform: 'win32' });
assert(windows.switches.has('force-high-performance-gpu'));
assert(windows.switches.has('enable-gpu-rasterization'));
assert(windows.enableFeatures.includes('CanvasOopRasterization'));
assert(windows.disableFeatures.includes('WebRtcHideLocalIpsWithMdns'));
assert(!windows.enableFeatures.includes('WebRTCPipeWireCapturer'));
const iceSwitches = [];
assert(applyWebRtcIcePolicy({ commandLine: { appendSwitch: (name, value) => iceSwitches.push([name, value]) } }));
assert.deepStrictEqual(iceSwitches, [['disable-features', 'WebRtcHideLocalIpsWithMdns']]);
assert(acceleratedFeature('enabled'));
assert(acceleratedFeature('enabled_force'));
assert(!acceleratedFeature('disabled_software'));
console.log('PASS full GPU acceleration policy');
