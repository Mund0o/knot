const fs = require('fs');
const path = require('path');
const { app, BrowserWindow } = require('electron');

const root = path.join(__dirname, '..');
for (const asset of ['build/deepfilternet/v3/pkg/df_bg.wasm', 'build/deepfilternet/v3/models/DeepFilterNet3_onnx.tar.gz']) {
  const stat = fs.statSync(path.join(root, asset));
  if (stat.size < 1024 || stat.size > 20 * 1024 * 1024) throw new Error('Invalid bundled DeepFilterNet asset: ' + asset);
}
const renderer = fs.readFileSync(path.join(root, 'app.js'), 'utf8');
const main = fs.readFileSync(path.join(root, 'main.js'), 'utf8');
if (!renderer.includes('function createDeepFilterMicrophone(') || renderer.includes('cdn.mezon.ai') || !main.includes("ipcMain.handle('pair:getDeepFilterAsset'")) {
  throw new Error('DeepFilterNet is not wired to local-only assets');
}

function fail(error) {
  console.error('DeepFilter local smoke test failed:', error?.stack || error);
  app.exit(1);
}

app.whenReady().then(async () => {
  const window = new BrowserWindow({
    show: false,
    webPreferences: { contextIsolation: true, nodeIntegration: false, sandbox: false, offscreen: true, preload: path.join(__dirname, 'deepfilter-local-preload.js') }
  });
  window.webContents.on('console-message', (_event, level, message, line, sourceId) => console.error('renderer console', level, message, sourceId + ':' + line));
  try {
    await window.loadFile(path.join(root, 'index.html'));
    const result = await window.webContents.executeJavaScript(`(async()=>{
      const assert=(value,message)=>{if(!value)throw new Error(message)};
      noiseReductionMode='deepfilter';noiseHardwareMode='cpu';renderNoiseProcessingUI();
      assert(deepFilterBackendAvailable(),'DeepFilter bridge was not available');
      assert(noiseProcessingHint.textContent.includes('CPU/WASM'),'DeepFilter UI did not state the local CPU backend');
      const input=new AudioContext({sampleRate:48000}),inputDest=input.createMediaStreamDestination(),osc=input.createOscillator();
      osc.frequency.value=440;osc.connect(inputDest);osc.start();await input.resume();
      const pipeline=await createDeepFilterMicrophone(inputDest.stream),analyser=pipeline.context.createAnalyser(),mute=pipeline.context.createGain();pipeline.processor.setSuppressionLevel(0);
      analyser.fftSize=512;mute.gain.value=0;pipeline.node.connect(analyser).connect(mute).connect(pipeline.context.destination);
      await new Promise(resolve=>setTimeout(resolve,700));
      const samples=new Float32Array(analyser.fftSize);analyser.getFloatTimeDomainData(samples);
      const peak=Math.max(...samples.map(Math.abs));
      assert(pipeline.stream.getAudioTracks().length===1,'DeepFilter did not return one microphone track');
      assert(peak>.001,'DeepFilter worklet produced only silence');
      osc.stop();inputDest.stream.getTracks().forEach(track=>track.stop());pipeline.source.disconnect();pipeline.node.disconnect();pipeline.destination.disconnect();pipeline.processor.destroy();for(const url of pipeline.urls)URL.revokeObjectURL(url);await pipeline.context.close();await input.close();
      return {peak,hardware:noiseHardware.value};
    })().catch(error=>({error:{name:error?.name,message:error?.message,stack:error?.stack}}))`);
    if (result?.error) throw new Error(JSON.stringify(result.error));
    console.log('PASS DeepFilter local smoke', JSON.stringify(result));
    await window.close();
    app.exit(0);
  } catch (error) { try { await window.close(); } catch {} fail(error); }
});
