'use strict';

const assert = require('assert');
const fs = require('fs');
const path = require('path');
const vm = require('vm');

const mainSource = fs.readFileSync(path.join(__dirname, '..', 'main.js'), 'utf8');
const rendererSource = fs.readFileSync(path.join(__dirname, '..', 'app.js'), 'utf8');

assert(mainSource.includes("capture.kill('SIGKILL')") && mainSource.includes('linuxShareAudio = null;\n    try { capture.kill') && mainSource.includes("state.capture.kill('SIGKILL')") && mainSource.includes("ipcMain.handle('pair:stopLinuxShareAudio'") && mainSource.includes('function muteLinuxLoopbackReturn') && mainSource.includes("set-sink-input-volume', id, '0%'"), 'Linux share-audio start or stop can still orphan parec after cancellation');
assert(mainSource.includes('linuxShareAudioStopping.then(()=>startLinuxShareAudio(webContents))') && mainSource.includes('if(pendingStart)try{await pendingStart}catch{}'), 'Rapidly restarting screen audio can overlap a retiring PipeWire route');
assert(mainSource.includes('function startLinuxShareAudioWithRetry') && mainSource.includes('await startLinuxShareAudioInner(webContents,generation)'), 'Linux share-audio start no longer retries a transient PipeWire route race');
assert(rendererSource.includes('async function acquireIsolatedShareAudioTrack') && rendererSource.includes('routeAttempt<=3') && rendererSource.includes('handshake<=3') && rendererSource.includes('Date.now()+900') && rendererSource.includes('if(!captureError&&received)break'), 'Screen audio still gives up after a single capture startup race');
assert(!rendererSource.includes('createScriptProcessor') && rendererSource.includes("new AudioWorkletNode(ctx,'knot-screen-audio'"), 'Screen audio regressed to renderer-thread processing');

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

  console.log('PASS Linux share-audio retries a single startup race and honors cancellation');
})().catch(error => {
  console.error(error?.stack || error);
  process.exit(1);
});
