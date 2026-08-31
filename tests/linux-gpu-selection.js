const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { linuxGpuCandidates, linuxMainGpu, primePciSelector, applyLinuxMainGpuEnvironment } = require('../linux-gpu');

const root = fs.mkdtempSync(path.join(os.tmpdir(), 'knot-gpu-test-'));
const drm = path.join(root, 'sys', 'class', 'drm');
const devices = path.join(root, 'devices');
const dev = path.join(root, 'dev', 'dri');

function gpu({ card, render, device, vendor, pciAddress, bootVga = false, connected = false, pcieLinkWidth = 0, pcieMaxLinkWidth = pcieLinkWidth }) {
  const target = path.join(devices, device);
  fs.mkdirSync(target, { recursive: true });
  fs.writeFileSync(path.join(target, 'vendor'), vendor);
  fs.writeFileSync(path.join(target, 'uevent'), `PCI_SLOT_NAME=${pciAddress}\n`);
  fs.writeFileSync(path.join(target, 'current_link_width'), `${pcieLinkWidth}\n`);
  fs.writeFileSync(path.join(target, 'max_link_width'), `${pcieMaxLinkWidth}\n`);
  if (bootVga) fs.writeFileSync(path.join(target, 'boot_vga'), '1\n');
  for (const name of [card, render]) {
    const drmNode = path.join(drm, name);
    fs.mkdirSync(drmNode, { recursive: true });
    fs.symlinkSync(target, path.join(drmNode, 'device'), 'dir');
  }
  if (connected) {
    const connector = path.join(drm, `${card}-DP-1`);
    fs.mkdirSync(connector, { recursive: true });
    fs.writeFileSync(path.join(connector, 'status'), 'connected\n');
  }
}

try {
  gpu({ card: 'card0', render: 'renderD129', device: 'intel', vendor: '0x8086', pciAddress: '0000:00:02.0' });
  gpu({ card: 'card1', render: 'renderD128', device: 'nvidia', vendor: '0x10de', pciAddress: '0000:01:00.0', bootVga: true, connected: true, pcieLinkWidth: 16 });
  gpu({ card: 'card2', render: 'renderD130', device: 'amd-apu', vendor: '0x1002', pciAddress: '0000:05:00.0' });
  gpu({ card: 'card3', render: 'renderD131', device: 'intel-arc', vendor: '0x8086', pciAddress: '0000:06:00.0', pcieLinkWidth: 8 });
  gpu({ card: 'card4', render: 'renderD132', device: 'amd-discrete', vendor: '0x1002', pciAddress: '0000:07:00.0', pcieLinkWidth: 16 });
  gpu({ card: 'card5', render: 'renderD133', device: 'amd-sleeping-discrete', vendor: '0x1002', pciAddress: '0000:08:00.0', pcieLinkWidth: 0, pcieMaxLinkWidth: 16 });
  const candidates = linuxGpuCandidates(drm, dev);
  assert.strictEqual(candidates.length, 6);
  assert.strictEqual(candidates.find(item => item.pciAddress === '0000:00:02.0').integrated, true);
  assert.strictEqual(candidates.find(item => item.vendor === '0x1002').integrated, true);
  assert.strictEqual(candidates.find(item => item.pciAddress === '0000:06:00.0').integrated, false);
  assert.strictEqual(candidates.find(item => item.pciAddress === '0000:07:00.0').integrated, false);
  assert.strictEqual(candidates.find(item => item.pciAddress === '0000:08:00.0').integrated, false);
  assert.strictEqual(candidates.find(item => item.pciAddress === '0000:08:00.0').pcieMaxLinkWidth, 16);
  assert.strictEqual(candidates.find(item => item.vendor === '0x10de').connected, true);
  assert.deepStrictEqual(linuxMainGpu({ platform: 'linux', sysfsRoot: drm, devRoot: dev }), candidates.find(item => item.vendor === '0x10de'));
  assert.strictEqual(linuxMainGpu({ platform: 'win32', sysfsRoot: drm, devRoot: dev }), null);
  assert.strictEqual(primePciSelector('0000:01:00.0'), 'pci-0000_01_00_0!');
  const env = {};
  assert.strictEqual(applyLinuxMainGpuEnvironment(candidates.find(item => item.vendor === '0x10de'), env), true);
  assert.deepStrictEqual(env, {
    DRI_PRIME: 'pci-0000_01_00_0!',
    KNOT_PRIMARY_GPU_VENDOR: '0x10de',
    KNOT_PRIMARY_GPU_RENDER_NODE: path.join(dev, 'renderD128'),
    KNOT_PRIMARY_GPU_PCI: '0000:01:00.0',
    KNOT_PRIMARY_GPU_INTEGRATED: '0',
    __NV_PRIME_RENDER_OFFLOAD: '1',
    __GLX_VENDOR_LIBRARY_NAME: 'nvidia',
    __VK_LAYER_NV_optimus: 'NVIDIA_only',
    LIBVA_DRIVER_NAME: 'nvidia',
    NVD_BACKEND: 'direct'
  });
  const amdEnv = { LIBVA_DRIVER_NAME: 'nvidia', NVD_BACKEND: 'direct', __NV_PRIME_RENDER_OFFLOAD: '1' };
  assert.strictEqual(applyLinuxMainGpuEnvironment(candidates.find(item => item.pciAddress === '0000:07:00.0'), amdEnv), true);
  assert.deepStrictEqual(amdEnv, {
    DRI_PRIME: 'pci-0000_07_00_0!',
    KNOT_PRIMARY_GPU_VENDOR: '0x1002',
    KNOT_PRIMARY_GPU_RENDER_NODE: path.join(dev, 'renderD132'),
    KNOT_PRIMARY_GPU_PCI: '0000:07:00.0',
    KNOT_PRIMARY_GPU_INTEGRATED: '0'
  });

  const integratedOnly = path.join(root, 'integrated-only');
  const integratedRenderNode = path.join(integratedOnly, 'renderD129');
  fs.mkdirSync(integratedRenderNode, { recursive: true });
  fs.symlinkSync(path.join(devices, 'intel'), path.join(integratedRenderNode, 'device'), 'dir');
  const integratedSelected=linuxMainGpu({ platform: 'linux', sysfsRoot: integratedOnly, devRoot: dev });
  assert.strictEqual(integratedSelected?.integrated, true);
  const integratedEnv={};assert.strictEqual(applyLinuxMainGpuEnvironment(integratedSelected,integratedEnv),true);assert.strictEqual(integratedEnv.KNOT_PRIMARY_GPU_INTEGRATED,'1');

  const sleepingAmdOnly = path.join(root, 'sleeping-amd-only');
  for (const name of ['card5', 'renderD133']) {
    const node = path.join(sleepingAmdOnly, name);
    fs.mkdirSync(node, { recursive: true });
    fs.symlinkSync(path.join(devices, 'amd-sleeping-discrete'), path.join(node, 'device'), 'dir');
  }
  assert.strictEqual(linuxMainGpu({ platform: 'linux', sysfsRoot: sleepingAmdOnly, devRoot: dev })?.pciAddress, '0000:08:00.0');
  assert.strictEqual(applyLinuxMainGpuEnvironment(candidates.find(item => item.integrated), {}), true);
  console.log('PASS Linux GPU selection prefers discrete and accelerates integrated-only systems');
} finally {
  fs.rmSync(root, { recursive: true, force: true });
}
