'use strict';

const assert = require('assert');
const fs = require('fs');
const path = require('path');
const vm = require('vm');

const mainSource = fs.readFileSync(path.join(__dirname, '..', 'main.js'), 'utf8');
const rendererSource = fs.readFileSync(path.join(__dirname, '..', 'app.js'), 'utf8');
const preloadSource = fs.readFileSync(path.join(__dirname, '..', 'preload.js'), 'utf8');

assert(mainSource.includes("capture.kill('SIGKILL')") && mainSource.includes('linuxShareAudio = null;\n    try { capture.kill') && mainSource.includes("state.capture.kill('SIGKILL')") && mainSource.includes("ipcMain.handle('pair:stopLinuxShareAudio'") && mainSource.includes('function muteLinuxLoopbackReturn') && mainSource.includes("set-sink-input-volume', id, '0%'"), 'Linux share-audio start or stop can still orphan parec after cancellation');
assert(mainSource.includes('linuxShareAudioStopping.then(()=>startLinuxShareAudio(webContents))') && mainSource.includes('if(pendingStart)try{await pendingStart}catch{}'), 'Rapidly restarting screen audio can overlap a retiring PipeWire route');
assert(mainSource.includes('function startLinuxShareAudioWithRetry') && mainSource.includes('await startLinuxShareAudioInner(webContents,generation)'), 'Linux share-audio start no longer retries a transient PipeWire route race');
assert(rendererSource.includes('async function acquireIsolatedShareAudioTrack') && rendererSource.includes('routeAttempt<=3') && rendererSource.includes('handshake<=3') && rendererSource.includes('Date.now()+900') && rendererSource.includes('if(!captureError)break'), 'Screen audio still gives up after a single capture startup race');
assert(!rendererSource.includes('createScriptProcessor') && rendererSource.includes("new AudioWorkletNode(ctx,'knot-screen-audio'"), 'Screen audio regressed to renderer-thread processing');
assert(rendererSource.includes('while(isCurrent()&&!captureError&&Date.now()<deadline)') && !rendererSource.includes('while(isCurrent()&&!received') && !rendererSource.includes('if(!received)'), 'Linux share-audio handshake still requires first PCM');
assert(rendererSource.includes('op.connect(keepAlive)') && rendererSource.includes('keepAlive.connect(ctx.destination)'), 'PipeWire AudioWorklet is not kept alive against a muted destination');
assert(preloadSource.includes("stopLinuxShareAudio: () => ipcRenderer.invoke('pair:stopLinuxShareAudio')"), 'stopLinuxShareAudio is not an awaitable invoke');
assert(mainSource.includes("if (linuxShareAudio) return Promise.resolve({ label: linuxShareAudio.label, source: linuxShareAudio.source, routeReadyAt: linuxShareAudio.routeReadyAt })"), 'Reusing a live PipeWire route omits routeReadyAt');
assert(mainSource.includes('!state.loop || !state.routeEnabled') && mainSource.includes('state.routeEnabled = true') && mainSource.includes('await unmuteLinuxLoopbackReturn(state)'), 'Desktop streams can move before the muted loopback return is unmuted');
assert(mainSource.includes("const moduleStream=/loopback|null-sink|module-/i.test(`${appName} ${binary} ${mediaName} ${nodeName} ${driver}`)") && !mainSource.includes('${mediaName} ${block}'), 'PipeWire routing still treats ordinary apps as modules because of module-stream-restore.id');
assert(rendererSource.includes('void attachNativeShareAudio(gen)') && !rendererSource.includes("if(!audioStarted){audioStarted=true;void attachNativeShareAudio(gen)}"), 'Native computer sound still waits for the first GOP');
assert(rendererSource.includes('applyMediaElementOutput(audio).catch(()=>{});') && rendererSource.includes("if(!audio.muted)audio.play().catch(()=>{})"), 'Viewer screen audio does not apply the output device before play');

const firefoxBlock = `Sink Input #15648
        Driver: PipeWire
        application.name = "Firefox"
        application.process.id = "1756"
        application.process.binary = "firefox"
        media.name = "Sith Translation Meaning"
        node.name = "Firefox"
        node.loop.name = "data-loop.0"
        module-stream-restore.id = "sink-input-by-application-name:Firefox"`;
const loopbackBlock = `Sink Input #9
        Driver: module-loopback.c
        application.name = "Loopback"
        media.name = "Loopback (pair_share_1.monitor)"
        node.name = "loopback-1-9"`;
function moduleStreamFrom(block) {
  const appName = block.match(/application\.name\s*=\s*"([^"]+)"/)?.[1] || '';
  const binary = block.match(/application\.process\.binary\s*=\s*"([^"]+)"/)?.[1] || '';
  const mediaName = block.match(/media\.name\s*=\s*"([^"]+)"/)?.[1] || '';
  const nodeName = block.match(/node\.name\s*=\s*"([^"]+)"/)?.[1] || '';
  const driver = block.match(/^\s*Driver:\s*(\S+)/m)?.[1] || '';
  return /loopback|null-sink|module-/i.test(`${appName} ${binary} ${mediaName} ${nodeName} ${driver}`);
}
assert(/loopback|null-sink|module-/i.test(`Firefox firefox Sith Translation Meaning ${firefoxBlock}`), 'fixture no longer reproduces the module-stream-restore false positive');
assert(!moduleStreamFrom(firefoxBlock), 'Firefox playback would still be left on the real sink');
assert(moduleStreamFrom(loopbackBlock), 'loopback return path would be moved into the share monitor');

const start = mainSource.indexOf('function startLinuxShareAudio(webContents)');
const end = mainSource.indexOf('function trimLinuxShareAudio');
assert(start >= 0 && end > start, 'could not locate Linux share-audio start retry');

async function runRetry(innerImpl, extras = {}) {
  const innerCalls = [];
  const context = {
    Date,
    Promise,
    setTimeout,
    process: { platform: 'linux', pid: 1 },
    linuxShareAudio: extras.linuxShareAudio || null,
    linuxShareAudioStart: null,
    linuxShareAudioStopping: extras.linuxShareAudioStopping || null,
    linuxShareAudioGeneration: extras.linuxShareAudioGeneration || 0
  };
  context.startLinuxShareAudioInner = async (webContents, generation) => {
    innerCalls.push(generation);
    return innerImpl(webContents, generation, innerCalls.length, context);
  };
  vm.createContext(context);
  vm.runInContext(mainSource.slice(start, end), context);
  const result = await context.startLinuxShareAudio(extras.webContents || { id: 1 });
  return { result, innerCalls, context };
}

(async () => {
  const recovered = await runRetry((_webContents, _generation, call) => call === 1 ? null : { label: 'Knot Share Audio', source: 'pair_share_1.monitor' });
  assert.strictEqual(recovered.innerCalls.length, 2, 'transient PipeWire start was not retried');
  assert.deepStrictEqual(recovered.result, { label: 'Knot Share Audio', source: 'pair_share_1.monitor' });

  const cancelled = await runRetry((_webContents, generation, call, sandbox) => {
    if (call === 1) sandbox.linuxShareAudioGeneration = generation + 1;
    return null;
  });
  assert.strictEqual(cancelled.innerCalls.length, 1, 'cancelled PipeWire start was retried after generation change');
  assert.strictEqual(cancelled.result, null);

  const exhausted = await runRetry(() => null);
  assert.strictEqual(exhausted.innerCalls.length, 3, 'PipeWire start did not stop after three failed attempts');
  assert.strictEqual(exhausted.result, null);

  const reused = await runRetry(() => ({ label: 'should-not-rebuild' }), {
    linuxShareAudio: { label: 'Knot Share Audio', source: 'pair_share_1.monitor', routeReadyAt: 123 }
  });
  assert.strictEqual(reused.innerCalls.length, 0, 'existing PipeWire route was rebuilt instead of reused');
  assert.strictEqual(reused.result?.label, 'Knot Share Audio');
  assert.strictEqual(reused.result?.source, 'pair_share_1.monitor');
  assert.strictEqual(reused.result?.routeReadyAt, 123);

  console.log('PASS Linux share-audio retries a single startup race and honors cancellation');
})().catch(error => {
  console.error(error?.stack || error);
  process.exit(1);
});
