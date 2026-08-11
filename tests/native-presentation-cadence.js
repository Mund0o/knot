const path = require('path');
const { app, BrowserWindow } = require('electron');

function fail(error) {
  console.error('Native presentation cadence test failed:', error?.stack || error);
  app.exit(1);
}

app.commandLine.appendSwitch('autoplay-policy', 'no-user-gesture-required');

app.whenReady().then(async () => {
  const window = new BrowserWindow({
    show: false,
    webPreferences: { contextIsolation: false, nodeIntegration: true, sandbox: false, offscreen: true, backgroundThrottling: false }
  });
  try {
    await window.loadFile(path.join(__dirname, '..', 'index.html'));
    await new Promise(resolve => setTimeout(resolve, 250));
    const result = await window.webContents.executeJavaScript(`(async()=>{
      const wait=ms=>new Promise(resolve=>setTimeout(resolve,ms)),realDecoder=window.VideoDecoder,descriptor=Object.getOwnPropertyDescriptor(window,'MediaStreamTrackGenerator');
      Object.defineProperty(window,'MediaStreamTrackGenerator',{configurable:true,writable:true,value:undefined});
      const source=new OffscreenCanvas(64,36),context=source.getContext('2d');context.fillStyle='#36c';context.fillRect(0,0,64,36);
      class BurstDecoder{
        constructor(callbacks){this.callbacks=callbacks;this.decodeQueueSize=0}
        configure(config){this.config=config}
        decode(chunk){this.decodeQueueSize++;this.callbacks.output(new VideoFrame(source,{timestamp:chunk.timestamp,duration:chunk.duration}));this.decodeQueueSize--}
        reset(){} close(){}
      }
      const size=value=>value<127?[0x80|value]:value<16383?[0x40|(value>>8),value&255]:[0x20|(value>>16),(value>>8)&255,value&255];
      const cluster=(base,index)=>{const body=[0xe7,...size(base>255?2:1),...(base>255?[base>>8,base&255]:[base])];for(let frame=0;frame<6;frame++){const relative=Math.round(frame*1000/60),payload=[0x81,relative>>8,relative&255,index===0&&frame===0?0x80:0,frame];body.push(0xa3,...size(payload.length),...payload)}return new Uint8Array([0x1f,0x43,0xb6,0x75,...size(body.length),...body])};
      window.VideoDecoder=BurstDecoder;const video=document.createElement('video');video.muted=true;document.body.append(video);let decoderError='';const player=createWebCodecsNativeScreenPlayer(video,'AV1',error=>{decoderError=String(error?.message||error)},{width:64,height:36,fps:60,enforceLatencyTarget:false});
      try{
        if(!player?.append(new Uint8Array([0x63,0xa2,0x84,0x81,0x0d,0x8c,0])))throw new Error('decoder init was rejected');
        const started=performance.now();for(let index=0;index<10;index++){if(!player.append(cluster(index*100,index)))throw new Error('burst cluster was rejected');await wait(100)}await wait(180);const stats=player.stats();return{...stats,elapsed:performance.now()-started,decoderError}
      }finally{player?.destroy();video.remove();window.VideoDecoder=realDecoder;if(descriptor)Object.defineProperty(window,'MediaStreamTrackGenerator',descriptor);else delete window.MediaStreamTrackGenerator}
    })()`, true);
    if (result.decoderError) throw new Error(result.decoderError);
    if (result.presentationMode !== 'canvas') throw new Error(`expected controlled canvas path, got ${result.presentationMode}`);
    if (result.renderedFrames < 50) throw new Error(`only presented ${result.renderedFrames} of 60 burst-delivered frames`);
    if (result.renderFps < 45 || result.renderFps > 75) throw new Error(`presentation cadence was ${result.renderFps.toFixed(1)} fps`);
    if (!result.renderCadenceP95Ms || result.renderCadenceP95Ms > 35) throw new Error(`presentation cadence p95 was ${result.renderCadenceP95Ms.toFixed(1)} ms`);
    console.log('PASS native AV1 burst presentation cadence', JSON.stringify(result));
    window.destroy();app.quit();
  } catch (error) {
    window.destroy();fail(error);
  }
});
