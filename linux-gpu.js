const fs = require('fs');
const path = require('path');

function readText(file) {
  try { return fs.readFileSync(file, 'utf8').trim().toLowerCase(); } catch { return ''; }
}

function realPath(file) {
  try { return fs.realpathSync(file); } catch { return ''; }
}

function linuxGpuCandidates(sysfsRoot = '/sys/class/drm', devRoot = '/dev/dri') {
  let names = [];
  try { names = fs.readdirSync(sysfsRoot); } catch { return []; }
  const cards = names.filter(name => /^card\d+$/.test(name));
  return names.filter(name => /^renderD\d+$/.test(name)).flatMap(render => {
    const devicePath = realPath(path.join(sysfsRoot, render, 'device'));
    if (!devicePath) return [];
    const card = cards.find(name => realPath(path.join(sysfsRoot, name, 'device')) === devicePath) || '';
    const vendor = readText(path.join(devicePath, 'vendor'));
    const pciAddress = readText(path.join(devicePath, 'uevent')).match(/^pci_slot_name=(.+)$/m)?.[1] || '';
    const bootVga = readText(path.join(devicePath, 'boot_vga')) === '1';
    const pcieLinkWidth = Number.parseInt(readText(path.join(devicePath, 'current_link_width')), 10) || 0;
    const pcieMaxLinkWidth = Number.parseInt(readText(path.join(devicePath, 'max_link_width')), 10) || 0;
    const connected = names.some(name =>
      name.startsWith(`${card}-`) && readText(path.join(sysfsRoot, name, 'status')) === 'connected'
    );
    // Intel/AMD integrated graphics has no normal external PCIe link. A sleeping
    // discrete card can report current_link_width=0 (notably AMD runtime D3), so
    // retain it when sysfs exposes a real 1..32 lane maximum. Integrated devices
    // commonly omit this value or report the 255 sentinel.
    const integratedVendor = vendor === '0x8086' || vendor === '0x1002';
    const externalPcieLink = pcieLinkWidth > 0 || (pcieMaxLinkWidth >= 1 && pcieMaxLinkWidth <= 32);
    const integrated = integratedVendor && !externalPcieLink;
    return [{ card, vendor, pciAddress, bootVga, connected, integrated, pcieLinkWidth, pcieMaxLinkWidth, renderNode: path.join(devRoot, render) }];
  });
}

function linuxMainGpu(options = {}) {
  if ((options.platform || process.platform) !== 'linux') return null;
  const candidates = linuxGpuCandidates(options.sysfsRoot, options.devRoot);
  if (!candidates.length) return null;
  // Prefer a discrete adapter when present, but an integrated-only machine must
  // still use its real compositor/video GPU. Falling all the way back to CPU
  // raster and software video on those systems is slower and less efficient.
  return candidates.sort((a, b) =>
    Number(a.integrated) - Number(b.integrated) ||
    Number(b.bootVga) - Number(a.bootVga) ||
    Number(b.connected) - Number(a.connected) ||
    Math.max(b.pcieLinkWidth, b.pcieMaxLinkWidth) - Math.max(a.pcieLinkWidth, a.pcieMaxLinkWidth) ||
    a.renderNode.localeCompare(b.renderNode)
  )[0];
}

function primePciSelector(pciAddress) {
  if (!/^\d{4}:[0-9a-f]{2}:[0-9a-f]{2}\.[0-7]$/i.test(pciAddress || '')) return '';
  return `pci-${pciAddress.replaceAll(':', '_').replace('.', '_')}!`;
}

// NVIDIA decodes video for Chromium through nvidia-vaapi-driver. Knot's Linux
// packages carry their own build in resources/nvidia-vaapi
// (scripts/build-nvidia-vaapi.sh) because 0.0.18, the newest release, smears
// NVENC's AV1 after every key frame. It is tried first; a system copy is the
// fallback (an -git package can carry the same fix). Being found only makes GPU
// decode eligible: the renderer compares a GPU decode with a CPU decode at
// startup, and a failed check rules that driver build out.
const LIBVA_DRIVER_DIRS = ['/usr/lib/x86_64-linux-gnu/dri', '/usr/lib64/dri', '/usr/lib/dri', '/usr/local/lib/x86_64-linux-gnu/dri', '/usr/local/lib/dri', '/usr/lib/aarch64-linux-gnu/dri'];
const NVIDIA_VAAPI_VERDICT_LIMIT = 8;
// LIBVA_DRIVERS_PATH as the user launched Knot. A relaunch inherits the value
// Knot set for its bundled driver, which may point at a stale AppImage mount.
function userLibvaDriversPath(env = process.env) {
  return 'KNOT_USER_LIBVA_DRIVERS_PATH' in env ? env.KNOT_USER_LIBVA_DRIVERS_PATH || '' : env.LIBVA_DRIVERS_PATH || '';
}
function nvidiaVaapiDrivers(env = process.env, fileSystem = fs, { bundledDirs = [] } = {}) {
  const candidates = [
    ...bundledDirs.filter(Boolean).map(dir => ({ dir, bundled: true })),
    ...[...userLibvaDriversPath(env).split(':').filter(Boolean), ...LIBVA_DRIVER_DIRS].map(dir => ({ dir, bundled: false })),
  ];
  // The NVIDIA driver version is part of each build's identity, so updating
  // NVIDIA's driver checks a previously failed build again.
  let nvidia = '';
  try { nvidia = String(fileSystem.readFileSync('/sys/module/nvidia/version', 'utf8')).trim().replace(/[^\w.-]/g, '').slice(0, 32); } catch {}
  const seen = new Set(), drivers = [];
  for (const { dir, bundled } of candidates) {
    const file = path.join(dir, 'nvidia_drv_video.so');
    try {
      const stat = fileSystem.statSync(file);
      if (!stat.isFile()) continue;
      let real = file;
      try { real = fileSystem.realpathSync ? fileSystem.realpathSync(file) : file; } catch {}
      if (seen.has(real)) continue;
      seen.add(real);
      // An AppImage mounts at a new path every launch, so a bundled build is
      // known by its size and timestamp alone; with the path in it, a failed
      // check would never match again and Knot would retry it forever.
      const identity = `${stat.size}:${Math.round(stat.mtimeMs)}${nvidia ? `:nvidia-${nvidia}` : ''}`;
      drivers.push({ path: file, dir, bundled, fingerprint: bundled ? `bundled:${identity}` : `${file}:${identity}` });
    } catch {}
  }
  return drivers;
}
function nvidiaVaapiDriver(env = process.env, fileSystem = fs, options = {}) {
  return nvidiaVaapiDrivers(env, fileSystem, options)[0] || null;
}

// Startup check results, newest last, keyed by driver build. 1.1.121 stored a
// single { driver, verdict }.
function nvidiaDecodeVerdicts(saved) {
  let value = saved;
  if (typeof value === 'string') { try { value = JSON.parse(value); } catch { value = null; } }
  if (value?.drivers && typeof value.drivers === 'object') {
    return Object.fromEntries(Object.entries(value.drivers).filter(([driver, verdict]) => typeof driver === 'string' && typeof verdict === 'string'));
  }
  if (typeof value?.driver === 'string' && typeof value.verdict === 'string') return { [value.driver]: value.verdict };
  return {};
}
function recordNvidiaDecodeVerdict(saved, driver, verdict) {
  const drivers = nvidiaDecodeVerdicts(saved);
  delete drivers[driver];
  drivers[driver] = verdict;
  const entries = Object.entries(drivers).slice(-NVIDIA_VAAPI_VERDICT_LIMIT);
  return { drivers: Object.fromEntries(entries) };
}
// A recorded failure for this exact driver build keeps it on CPU decode.
function nvidiaVaapiEligible(driver, verdicts) {
  if (!driver) return false;
  const known = verdicts && 'driver' in verdicts ? nvidiaDecodeVerdicts(verdicts) : verdicts || {};
  return (known[driver.fingerprint] ?? 'ok') === 'ok';
}
function selectNvidiaVaapiDriver(drivers, verdicts) {
  const driver = drivers.find(candidate => nvidiaVaapiEligible(candidate, verdicts)) || null;
  return { driver, state: driver ? 'on' : drivers.length ? 'failed' : 'missing' };
}

function applyLinuxMainGpuEnvironment(gpu, env = process.env, { nvidiaVaapi = false, nvidiaVaapiDir = '' } = {}) {
  if (!gpu) return false;
  // Start from the user's own driver path; only a selected driver changes it.
  if ('KNOT_USER_LIBVA_DRIVERS_PATH' in env) {
    if (env.KNOT_USER_LIBVA_DRIVERS_PATH) env.LIBVA_DRIVERS_PATH = env.KNOT_USER_LIBVA_DRIVERS_PATH;
    else delete env.LIBVA_DRIVERS_PATH;
    delete env.KNOT_USER_LIBVA_DRIVERS_PATH;
  }
  const selector = primePciSelector(gpu.pciAddress);
  if (selector) env.DRI_PRIME = selector;
  env.KNOT_PRIMARY_GPU_VENDOR = gpu.vendor || '';
  env.KNOT_PRIMARY_GPU_RENDER_NODE = gpu.renderNode || '';
  env.KNOT_PRIMARY_GPU_PCI = gpu.pciAddress || '';
  env.KNOT_PRIMARY_GPU_INTEGRATED = gpu.integrated ? '1' : '0';
  if (gpu.vendor === '0x10de') {
    // NVIDIA's GLVND/PRIME controls cover EGL/GLX and hide non-NVIDIA Vulkan
    // devices. DRI_PRIME supplies the exact PCI device for Mesa consumers.
    env.__NV_PRIME_RENDER_OFFLOAD = '1';
    env.__GLX_VENDOR_LIBRARY_NAME = 'nvidia';
    env.__VK_LAYER_NV_optimus = 'NVIDIA_only';
    if (nvidiaVaapi) {
      // Pin libva to NVIDIA's NVDEC bridge on its direct backend, the one
      // that produces Chromium-importable pictures.
      env.LIBVA_DRIVER_NAME = 'nvidia';
      env.NVD_BACKEND = 'direct';
      // libva loads nvidia_drv_video.so from the selected driver's folder,
      // which for the bundled build is inside Knot's resources.
      if (nvidiaVaapiDir) {
        env.KNOT_USER_LIBVA_DRIVERS_PATH = env.LIBVA_DRIVERS_PATH || '';
        env.LIBVA_DRIVERS_PATH = nvidiaVaapiDir;
      }
    } else {
      // Without a verified driver Chromium's VA-API-on-NVIDIA path renders
      // received video white, so any inherited override is cleared.
      delete env.LIBVA_DRIVER_NAME;
      delete env.NVD_BACKEND;
    }
  } else {
    delete env.__NV_PRIME_RENDER_OFFLOAD;
    delete env.__GLX_VENDOR_LIBRARY_NAME;
    delete env.__VK_LAYER_NV_optimus;
    delete env.LIBVA_DRIVER_NAME;
    delete env.NVD_BACKEND;
  }
  return true;
}

module.exports = { linuxGpuCandidates, linuxMainGpu, primePciSelector, applyLinuxMainGpuEnvironment, nvidiaVaapiDrivers, nvidiaVaapiDriver, nvidiaVaapiEligible, nvidiaDecodeVerdicts, recordNvidiaDecodeVerdict, selectNvidiaVaapiDriver, userLibvaDriversPath };
