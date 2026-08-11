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
    // Intel/AMD integrated graphics has no external PCIe link. This also keeps
    // Intel Arc and AMD discrete cards eligible without maintaining device-ID
    // lists that become stale as new GPUs ship.
    const integratedVendor = vendor === '0x8086' || vendor === '0x1002';
    const integrated = integratedVendor && pcieLinkWidth === 0;
    return [{ card, vendor, pciAddress, bootVga, integrated, pcieLinkWidth, renderNode: path.join(devRoot, render) }];
  });
}

function linuxMainGpu(options = {}) {
  if ((options.platform || process.platform) !== 'linux') return null;
  const candidates = linuxGpuCandidates(options.sysfsRoot, options.devRoot);
  if (!candidates.length) return null;
  // Never select an integrated device while a discrete render node exists.
  // boot_vga then identifies the user's main/display card when there are
  // multiple discrete GPUs.
  return candidates.sort((a, b) =>
    Number(a.integrated) - Number(b.integrated) ||
    Number(b.bootVga) - Number(a.bootVga) ||
    a.renderNode.localeCompare(b.renderNode)
  )[0];
}

module.exports = { linuxGpuCandidates, linuxMainGpu };
