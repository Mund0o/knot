const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { linuxGpuCandidates, linuxMainGpu } = require('../linux-gpu');

const root = fs.mkdtempSync(path.join(os.tmpdir(), 'knot-gpu-test-'));
const drm = path.join(root, 'sys', 'class', 'drm');
const devices = path.join(root, 'devices');
const dev = path.join(root, 'dev', 'dri');

function gpu({ card, render, device, vendor, pciAddress, bootVga = false, pcieLinkWidth = 0 }) {
  const target = path.join(devices, device);
  fs.mkdirSync(target, { recursive: true });
  fs.writeFileSync(path.join(target, 'vendor'), vendor);
  fs.writeFileSync(path.join(target, 'uevent'), `PCI_SLOT_NAME=${pciAddress}\n`);
  fs.writeFileSync(path.join(target, 'current_link_width'), `${pcieLinkWidth}\n`);
  if (bootVga) fs.writeFileSync(path.join(target, 'boot_vga'), '1\n');
  for (const name of [card, render]) {
    const drmNode = path.join(drm, name);
    fs.mkdirSync(drmNode, { recursive: true });
    fs.symlinkSync(target, path.join(drmNode, 'device'), 'dir');
  }
}

try {
  gpu({ card: 'card0', render: 'renderD129', device: 'intel', vendor: '0x8086', pciAddress: '0000:00:02.0' });
  gpu({ card: 'card1', render: 'renderD128', device: 'nvidia', vendor: '0x10de', pciAddress: '0000:01:00.0', bootVga: true, pcieLinkWidth: 16 });
  gpu({ card: 'card2', render: 'renderD130', device: 'amd-apu', vendor: '0x1002', pciAddress: '0000:05:00.0' });
  gpu({ card: 'card3', render: 'renderD131', device: 'intel-arc', vendor: '0x8086', pciAddress: '0000:06:00.0', pcieLinkWidth: 8 });
  const candidates = linuxGpuCandidates(drm, dev);
  assert.strictEqual(candidates.length, 4);
  assert.strictEqual(candidates.find(item => item.pciAddress === '0000:00:02.0').integrated, true);
  assert.strictEqual(candidates.find(item => item.vendor === '0x1002').integrated, true);
  assert.strictEqual(candidates.find(item => item.pciAddress === '0000:06:00.0').integrated, false);
  assert.deepStrictEqual(linuxMainGpu({ platform: 'linux', sysfsRoot: drm, devRoot: dev }), candidates.find(item => item.vendor === '0x10de'));
  assert.strictEqual(linuxMainGpu({ platform: 'win32', sysfsRoot: drm, devRoot: dev }), null);
  console.log('PASS Linux main GPU selection excludes integrated graphics');
} finally {
  fs.rmSync(root, { recursive: true, force: true });
}
