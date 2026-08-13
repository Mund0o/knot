const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const vm = require('vm');
const {
  CAPTURE_ABI,
  verifyWindowsAudioAddon,
  writeWindowsAudioManifest
} = require('../scripts/windows-audio-addon-guard');

const root = fs.mkdtempSync(path.join(os.tmpdir(), 'knot-audio-guard-'));
try {
  const release = path.join(root, 'addon', 'build', 'Release');
  fs.mkdirSync(release, { recursive: true });
  fs.mkdirSync(path.join(root, 'node_modules', 'electron'), { recursive: true });
  const sourcePath = path.join(root, 'addon', 'pair-capture.cc');
  const binaryPath = path.join(release, 'pair-capture.node');
  const source = `static constexpr char kCaptureAbi[] = "${CAPTURE_ABI}";\n`;
  fs.writeFileSync(sourcePath, source);
  fs.writeFileSync(path.join(root, 'node_modules', 'electron', 'package.json'), JSON.stringify({ version: '43.2.0' }));

  const binary = Buffer.alloc(512);
  binary.write('MZ', 0, 'ascii');
  binary.writeUInt32LE(0x80, 0x3c);
  binary.write('PE\0\0', 0x80, 'binary');
  binary.writeUInt16LE(0x8664, 0x84);
  binary.write(CAPTURE_ABI, 0x100, 'ascii');
  fs.writeFileSync(binaryPath, binary);

  const manifest = writeWindowsAudioManifest(root);
  assert.strictEqual(manifest.captureAbi, CAPTURE_ABI);
  assert.strictEqual(verifyWindowsAudioAddon(root).electronVersion, '43.2.0');

  fs.appendFileSync(sourcePath, '// changed after build\n');
  assert.throws(() => verifyWindowsAudioAddon(root), /addon is stale/);
  fs.writeFileSync(sourcePath, source);
  writeWindowsAudioManifest(root);

  fs.unlinkSync(binaryPath);
  assert.throws(() => verifyWindowsAudioAddon(root), /addon is missing/);

  let WorkletProcessor;
  const workletSource = fs.readFileSync(path.join(__dirname, '..', 'screen-audio-worklet.js'), 'utf8');
  vm.runInNewContext(workletSource, {
    Float32Array,
    AudioWorkletProcessor: class { constructor() { this.port = { onmessage: null, postMessage() {} }; } },
    registerProcessor(name, Processor) { if (name === 'knot-screen-audio') WorkletProcessor = Processor; }
  });
  assert(WorkletProcessor, 'screen audio worklet did not register');
  const oversized = new WorkletProcessor(), oversizedPcm = new Float32Array(10000 * 2);
  for (let frame = 0; frame < 10000; frame++) oversizedPcm[frame * 2] = oversizedPcm[frame * 2 + 1] = frame;
  oversized.port.onmessage({ data: oversizedPcm });
  assert.strictEqual(oversized.frames, 3840, 'oversized worklet packet exceeded the stale-audio target');
  assert.strictEqual(oversized.queue[0][0], 6160, 'worklet retained the stale beginning of an oversized packet');

  const queued = new WorkletProcessor();
  for (let packet = 0; packet < 9; packet++) {
    const pcm = new Float32Array(960 * 2); pcm.fill(packet);
    queued.port.onmessage({ data: pcm });
  }
  assert.strictEqual(queued.frames, 3840, 'worklet queue did not trim back to 80 ms');
  const output = [[new Float32Array(128), new Float32Array(128)]];
  queued.process([], output);
  assert.strictEqual(output[0][0][0], 5, 'worklet played stale queued audio after a renderer stall');
  const mainSource = fs.readFileSync(path.join(__dirname, '..', 'main.js'), 'utf8');
  const addonSource = fs.readFileSync(path.join(__dirname, '..', 'addon', 'pair-capture.cc'), 'utf8');
  const preloadSource = fs.readFileSync(path.join(__dirname, '..', 'preload.js'), 'utf8');
  const rendererSource = fs.readFileSync(path.join(__dirname, '..', 'app.js'), 'utf8');
  assert(mainSource.includes('NATIVE_AUDIO_MAX_INFLIGHT = 3') && mainSource.includes("ipcMain.on('pair:cleanAudioAck'"), 'native audio IPC is not acknowledgement-bounded');
  assert(addonSource.includes('return initSystemLoopback();') && addonSource.includes('"system-loopback"'), 'Windows 10 fallback capture is missing');
  assert(preloadSource.includes("ipcRenderer.send('pair:cleanAudioAck'"), 'renderer bridge does not release native audio IPC backpressure');
  assert(!rendererSource.includes('createScriptProcessor') && rendererSource.includes("new AudioWorkletNode(ctx,'knot-screen-audio'"), 'Windows capture regressed to renderer-thread audio processing');
  assert(rendererSource.includes('screenShareOutputElements()') && rendererSource.includes('applyMediaElementOutput(nativeRemoteAudio)') && rendererSource.includes('state.screenAudio'), 'selected output does not cover native/server screen audio');
  console.log('PASS Windows audio addon guard and bounded screen-audio worklet');
} finally {
  fs.rmSync(root, { recursive: true, force: true });
}
