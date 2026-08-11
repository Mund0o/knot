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
    const connected = names.some(name =>
      name.startsWith(`${card}-`) && readText(path.join(sysfsRoot, name, 'status')) === 'connected'
    );
    // Intel/AMD integrated graphics has no external PCIe link. This also keeps
    // Intel Arc and AMD discrete cards eligible without maintaining device-ID
    // lists that become stale as new GPUs ship.
    const integratedVendor = vendor === '0x8086' || vendor === '0x1002';
    const integrated = integratedVendor && pcieLinkWidth === 0;
    return [{ card, vendor, pciAddress, bootVga, connected, integrated, pcieLinkWidth, renderNode: path.join(devRoot, render) }];
  });
}

function linuxMainGpu(options = {}) {
  if ((options.platform || process.platform) !== 'linux') return null;
  const candidates = linuxGpuCandidates(options.sysfsRoot, options.devRoot).filter(candidate => !candidate.integrated);
  if (!candidates.length) return null;
  // Integrated devices are deliberately ineligible. boot_vga identifies the
  // user's primary display card; a connected output is the next-best signal
  // on systems whose firmware does not expose boot_vga.
  return candidates.sort((a, b) =>
    Number(b.bootVga) - Number(a.bootVga) ||
    Number(b.connected) - Number(a.connected) ||
    b.pcieLinkWidth - a.pcieLinkWidth ||
    a.renderNode.localeCompare(b.renderNode)
  )[0];
}

function primePciSelector(pciAddress) {
  if (!/^\d{4}:[0-9a-f]{2}:[0-9a-f]{2}\.[0-7]$/i.test(pciAddress || '')) return '';
  return `pci-${pciAddress.replaceAll(':', '_').replace('.', '_')}!`;
}

function applyLinuxMainGpuEnvironment(gpu, env = process.env) {
  if (!gpu || gpu.integrated) return false;
  const selector = primePciSelector(gpu.pciAddress);
  if (selector) env.DRI_PRIME = selector;
  env.KNOT_PRIMARY_GPU_VENDOR = gpu.vendor || '';
  env.KNOT_PRIMARY_GPU_RENDER_NODE = gpu.renderNode || '';
  env.KNOT_PRIMARY_GPU_PCI = gpu.pciAddress || '';
  if (gpu.vendor === '0x10de') {
    // NVIDIA's GLVND/PRIME controls cover EGL/GLX and hide non-NVIDIA Vulkan
    // devices. DRI_PRIME supplies the exact PCI device for Mesa consumers.
    env.__NV_PRIME_RENDER_OFFLOAD = '1';
    env.__GLX_VENDOR_LIBRARY_NAME = 'nvidia';
    env.__VK_LAYER_NV_optimus = 'NVIDIA_only';
    // Chromium video acceleration uses VA-API on Linux. Pin libva to NVIDIA's
    // NVDEC bridge so decoding cannot drift to an integrated render node.
    env.LIBVA_DRIVER_NAME = 'nvidia';
    env.NVD_BACKEND = 'direct';
  } else {
    delete env.__NV_PRIME_RENDER_OFFLOAD;
    delete env.__GLX_VENDOR_LIBRARY_NAME;
    delete env.__VK_LAYER_NV_optimus;
    delete env.LIBVA_DRIVER_NAME;
    delete env.NVD_BACKEND;
  }
  return true;
}

module.exports = { linuxGpuCandidates, linuxMainGpu, primePciSelector, applyLinuxMainGpuEnvironment };
