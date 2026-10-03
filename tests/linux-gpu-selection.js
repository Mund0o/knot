const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { linuxGpuCandidates, linuxMainGpu, primePciSelector, applyLinuxMainGpuEnvironment, nvidiaVaapiDrivers, nvidiaVaapiDriver, nvidiaVaapiEligible, nvidiaDecodeVerdicts, recordNvidiaDecodeVerdict, selectNvidiaVaapiDriver } = require('../linux-gpu');

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
    __VK_LAYER_NV_optimus: 'NVIDIA_only'
  });
  const verifiedEnv = {};
  applyLinuxMainGpuEnvironment(candidates.find(item => item.vendor === '0x10de'), verifiedEnv, { nvidiaVaapi: true });
  assert.strictEqual(verifiedEnv.LIBVA_DRIVER_NAME, 'nvidia', 'a verified NVIDIA VA-API driver must be pinned');
  assert.strictEqual(verifiedEnv.NVD_BACKEND, 'direct', 'only the direct backend exports Chromium-importable pictures');
  const unverifiedEnv = { LIBVA_DRIVER_NAME: 'nvidia', NVD_BACKEND: 'egl' };
  applyLinuxMainGpuEnvironment(candidates.find(item => item.vendor === '0x10de'), unverifiedEnv);
  assert(!('LIBVA_DRIVER_NAME' in unverifiedEnv) && !('NVD_BACKEND' in unverifiedEnv), 'an unverified driver must not inherit a libva override');

  const libva = path.join(root, 'libva');fs.mkdirSync(libva);
  assert.strictEqual(nvidiaVaapiDriver({ LIBVA_DRIVERS_PATH: libva }, { statSync: () => { throw new Error('missing'); } }), null);
  fs.writeFileSync(path.join(libva, 'nvidia_drv_video.so'), 'driver');
  const driver = nvidiaVaapiDriver({ LIBVA_DRIVERS_PATH: libva });
  assert(driver && driver.path === path.join(libva, 'nvidia_drv_video.so') && driver.fingerprint.includes(':6:'));
  assert.strictEqual(nvidiaVaapiEligible(null, null), false, 'no driver means CPU decode');
  assert.strictEqual(nvidiaVaapiEligible(driver, null), true, 'an untested driver is checked at startup');
  assert.strictEqual(nvidiaVaapiEligible(driver, { driver: driver.fingerprint, verdict: 'ok' }), true);
  assert.strictEqual(nvidiaVaapiEligible(driver, { driver: driver.fingerprint, verdict: 'broken' }), false, 'a failed driver build must stay on CPU decode');
  assert.strictEqual(nvidiaVaapiEligible(driver, { driver: 'older-build', verdict: 'broken' }), true, 'an updated driver is checked again');

  // Knot's own build (resources/nvidia-vaapi) comes first; a system copy is
  // the fallback once the bundled one has failed its check.
  const mountA = path.join(root, 'mount-a', 'nvidia-vaapi'), mountB = path.join(root, 'mount-b', 'nvidia-vaapi');
  for (const dir of [mountA, mountB]) { fs.mkdirSync(dir, { recursive: true }); fs.writeFileSync(path.join(dir, 'nvidia_drv_video.so'), 'bundled-driver'); }
  const stamp = new Date('2026-10-03T12:00:00Z');for (const dir of [mountA, mountB]) fs.utimesSync(path.join(dir, 'nvidia_drv_video.so'), stamp, stamp);
  const found = nvidiaVaapiDrivers({ LIBVA_DRIVERS_PATH: libva }, fs, { bundledDirs: [mountA] });
  assert.deepStrictEqual(found.map(item => [item.dir, item.bundled]), [[mountA, true], [libva, false]], 'the bundled driver must be tried before a system copy');
  // An AppImage mounts somewhere new every launch; its driver keeps one identity.
  assert.strictEqual(nvidiaVaapiDrivers({}, fs, { bundledDirs: [mountB] })[0].fingerprint, found[0].fingerprint, 'a bundled driver must be recognised across AppImage mounts, or a failed check would repeat forever');
  assert.strictEqual(nvidiaVaapiDrivers({ LIBVA_DRIVERS_PATH: mountA }, fs, { bundledDirs: [mountA] }).length, 1, 'the bundled folder found twice is one driver');
  let verdicts = nvidiaDecodeVerdicts(null);
  assert.deepStrictEqual(selectNvidiaVaapiDriver(found, verdicts), { driver: found[0], state: 'on' });
  verdicts = nvidiaDecodeVerdicts(JSON.stringify(recordNvidiaDecodeVerdict(null, found[0].fingerprint, 'broken')));
  assert.deepStrictEqual(selectNvidiaVaapiDriver(found, verdicts), { driver: found[1], state: 'on' }, 'a failed bundled driver must fall back to the system one');
  verdicts = nvidiaDecodeVerdicts(recordNvidiaDecodeVerdict(verdicts && { drivers: verdicts }, found[1].fingerprint, 'unsupported'));
  assert.deepStrictEqual(selectNvidiaVaapiDriver(found, verdicts), { driver: null, state: 'failed' }, 'with every driver failed, video decodes on the CPU');
  assert.deepStrictEqual(selectNvidiaVaapiDriver([], {}), { driver: null, state: 'missing' });
  assert.deepStrictEqual(nvidiaDecodeVerdicts(JSON.stringify({ driver: 'old', verdict: 'broken' })), { old: 'broken' }, 'the 1.1.121 verdict must still be honoured');
  let many = null;for (let i = 0; i < 12; i++) many = recordNvidiaDecodeVerdict(many, 'build-' + i, 'broken');
  assert.deepStrictEqual(Object.keys(many.drivers), ['build-4', 'build-5', 'build-6', 'build-7', 'build-8', 'build-9', 'build-10', 'build-11'], 'only the newest verdicts are kept');

  // libva loads the selected driver from its folder; a relaunch starts again
  // from the user's own LIBVA_DRIVERS_PATH.
  const nvidiaGpu = candidates.find(item => item.vendor === '0x10de');
  const bundledEnv = { LIBVA_DRIVERS_PATH: '/opt/custom/dri' };
  applyLinuxMainGpuEnvironment(nvidiaGpu, bundledEnv, { nvidiaVaapi: true, nvidiaVaapiDir: mountA });
  assert.strictEqual(bundledEnv.LIBVA_DRIVERS_PATH, mountA, 'libva must load the selected driver build');
  assert.deepStrictEqual(nvidiaVaapiDrivers(bundledEnv, fs, {}).map(item => item.dir).includes(mountA), false, 'a relaunch must not treat the previous mount as a system driver');
  applyLinuxMainGpuEnvironment(nvidiaGpu, bundledEnv, { nvidiaVaapi: false });
  assert.strictEqual(bundledEnv.LIBVA_DRIVERS_PATH, '/opt/custom/dri', 'turning NVIDIA decode off must restore the user\'s driver path');
  assert(!('KNOT_USER_LIBVA_DRIVERS_PATH' in bundledEnv));
  const plainEnv = {};
  applyLinuxMainGpuEnvironment(nvidiaGpu, plainEnv, { nvidiaVaapi: true, nvidiaVaapiDir: mountA });
  applyLinuxMainGpuEnvironment(nvidiaGpu, plainEnv, { nvidiaVaapi: true, nvidiaVaapiDir: mountB });
  assert.strictEqual(plainEnv.LIBVA_DRIVERS_PATH, mountB);
  applyLinuxMainGpuEnvironment(nvidiaGpu, plainEnv, { nvidiaVaapi: false });
  assert(!('LIBVA_DRIVERS_PATH' in plainEnv), 'a driver path Knot set must not outlive NVIDIA decode');

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
