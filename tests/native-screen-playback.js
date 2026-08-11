const path = require('path');
const { app, BrowserWindow } = require('electron');
const { linuxMainGpu, applyLinuxMainGpuEnvironment } = require('../linux-gpu');
const { applyGpuAccelerationPolicy } = require('../gpu-acceleration');

const input = process.argv.find(value => value.endsWith('.webm'));
if (!input) throw new Error('Pass a WebM capture path');
const gpu = linuxMainGpu();
if (applyLinuxMainGpuEnvironment(gpu)) {
  applyGpuAccelerationPolicy(app, { platform: process.platform, gpu, wayland: !!(process.env.XDG_SESSION_TYPE === 'wayland' || process.env.WAYLAND_DISPLAY) });
}

function fail(error) {
  console.error('Native screen playback test failed:', error?.stack || error);
  app.exit(1);
}

app.whenReady().then(async () => {
  const window = new BrowserWindow({
    show: false,
    webPreferences: { nodeIntegration: true, contextIsolation: false, sandbox: false, offscreen: true }
  });
  window.webContents.on('console-message', (_event, _level, message) => console.error('[renderer]', message));
  try {
    await window.loadURL('data:text/html,<video id="screen" muted autoplay playsinline></video>');
    const result = await window.webContents.executeJavaScript(`(async()=>{
      const fs=require('fs'),wait=ms=>new Promise(resolve=>setTimeout(resolve,ms)),bytes=fs.readFileSync(${JSON.stringify(path.resolve(input))}),mime='video/webm; codecs="av01.0.13M.08"';
      if(!MediaSource.isTypeSupported(mime))throw new Error('Chromium MediaSource does not support '+mime);
      const mediaSource=new MediaSource(),video=document.querySelector('#screen');video.src=URL.createObjectURL(mediaSource);
      await new Promise(resolve=>mediaSource.addEventListener('sourceopen',resolve,{once:true}));const buffer=mediaSource.addSourceBuffer(mime);
      const append=chunk=>new Promise((resolve,reject)=>{const done=()=>{buffer.removeEventListener('error',bad);resolve()};const bad=()=>{buffer.removeEventListener('updateend',done);reject(new Error('SourceBuffer append failed'))};buffer.addEventListener('updateend',done,{once:true});buffer.addEventListener('error',bad,{once:true});buffer.appendBuffer(chunk)});
      const signature=Buffer.from([0x1f,0x43,0xb6,0x75]),clusters=[];for(let offset=0;(offset=bytes.indexOf(signature,offset))>=0;offset+=4)clusters.push(offset);if(clusters.length<2)throw new Error('capture has no complete WebM clusters');const started=performance.now();await append(bytes.subarray(0,clusters[0]));for(let index=0;index<clusters.length-1;index++){await append(bytes.subarray(clusters[index],clusters[index+1]));if(index<10)await wait(2)}
      await video.play();await new Promise((resolve,reject)=>{const timer=setTimeout(()=>reject(new Error('no decoded AV1 frame')),5000);if(video.requestVideoFrameCallback)video.requestVideoFrameCallback(()=>{clearTimeout(timer);resolve()});else video.addEventListener('loadeddata',()=>{clearTimeout(timer);resolve()},{once:true})});const firstFrameMs=performance.now()-started;await wait(1000);const quality=video.getVideoPlaybackQuality?.()||{};return{supported:true,width:video.videoWidth,height:video.videoHeight,firstFrameMs,decoded:quality.totalVideoFrames||0,dropped:quality.droppedVideoFrames||0,buffered:video.buffered.length?video.buffered.end(video.buffered.length-1):0};
    })()`, true);
    console.log(JSON.stringify(result, null, 2));
    if (result.width !== 3840 || result.height !== 2160 || result.decoded < 30 || result.dropped > 3) {
      throw new Error('incremental AV1 playback did not retain 4K with continuous decode');
    }
    console.log('PASS incremental MediaSource AV1 playback');
    window.destroy();app.quit();
  } catch (error) {
    window.destroy();fail(error);
  }
});
