const GPU_ACCELERATED_FEATURES = [
  // Chromium normally enables these opportunistically. Make the user's
  // hardware-acceleration choice authoritative for Knot's UI, images, canvas,
  // video surfaces, and WebRTC rendering.
  'CanvasOopRasterization'
];

const LINUX_ACCELERATED_FEATURES = [
  'WebRTCPipeWireCapturer',
  'AcceleratedVideoDecoder',
  'AcceleratedVideoEncoder',
  'AcceleratedVideoDecodeLinuxGL'
];

function gpuAccelerationPolicy({ platform = process.platform, gpu = null, wayland = false } = {}) {
  const switches = new Map([
    ['force-high-performance-gpu', ''],
    ['enable-gpu-rasterization', ''],
    ['enable-zero-copy', ''],
    // Do not silently move 3D/raster work to SwiftShader while acceleration is
    // enabled. A user can turn acceleration off if their driver is unhealthy.
    ['disable-software-rasterizer', '']
  ]);
  const enableFeatures = [...GPU_ACCELERATED_FEATURES];
  const disableFeatures = [];

  if (platform === 'linux') {
    if (!gpu || gpu.integrated) return null;
    switches.set('hardware-video-device-path', gpu.renderNode);
    // Chromium's Linux encoder feature is opt-in. Decode is enabled in builds
    // with VA-API, but keeping it explicit prevents a field trial from moving a
    // supported codec back to the CPU.
    enableFeatures.push(...LINUX_ACCELERATED_FEATURES);
    if (wayland) enableFeatures.push('AcceleratedVideoDecodeLinuxZeroCopyGL');
    if (gpu.vendor === '0x10de') {
      // nvidia-vaapi-driver exposes NVDEC through VA-API. Chromium otherwise
      // rejects NVIDIA VA-API even when the selected card supports the codec.
      enableFeatures.push('VaapiOnNvidiaGPUs');
      // GPU blocklisting is incompatible with the explicit "use my main GPU"
      // setting. Driver bug workarounds remain enabled; only the blanket
      // software downgrade is bypassed.
      switches.set('ignore-gpu-blocklist', '');
    }
    // Native Wayland capture imports compositor-owned DMA-BUFs through GL.
    // Vulkan currently makes that target black on Electron/NVIDIA, so GL is the
    // accelerated path here rather than a CPU fallback.
    if (wayland) {
      disableFeatures.push('Vulkan');
      // Recent Chromium builds initialize native Vulkan for WebGPU-on-Vulkan
      // interop even when the compositor's Vulkan feature is disabled. Wayland
      // cannot present that path reliably on either NVIDIA or AMD. Selecting
      // Dawn's accelerated OpenGL ES adapter disables the interop feature while
      // keeping WebGPU, raster, canvas, WebGL, and video work on the main GPU.
      switches.set('use-webgpu-adapter', 'opengles');
    }
  }

  return { switches, enableFeatures, disableFeatures };
}

function applyGpuAccelerationPolicy(app, options = {}) {
  const policy = gpuAccelerationPolicy(options);
  if (!policy) return false;
  for (const [name, value] of policy.switches) app.commandLine.appendSwitch(name, value);
  if (policy.enableFeatures.length) app.commandLine.appendSwitch('enable-features', [...new Set(policy.enableFeatures)].join(','));
  if (policy.disableFeatures.length) app.commandLine.appendSwitch('disable-features', [...new Set(policy.disableFeatures)].join(','));
  // Chromium can permanently block WebGL for an origin after GPU-process
  // crashes. With Knot's explicit acceleration setting, restart recovery should
  // retry the selected card instead of silently retaining a CPU renderer.
  app.disableDomainBlockingFor3DAPIs?.();
  return true;
}

function acceleratedFeature(value) {
  return typeof value === 'string' && (value === 'enabled' || value === 'enabled_on' || value === 'enabled_force' || value === 'enabled_force_on' || value === 'enabled_readback');
}

module.exports = { gpuAccelerationPolicy, applyGpuAccelerationPolicy, acceleratedFeature };
