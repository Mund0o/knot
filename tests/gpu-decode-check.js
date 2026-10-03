const path = require('path');
const { app, BrowserWindow } = require('electron');

function fail(error) {
  console.error('GPU decode check test failed:', error?.stack || error);
  app.exit(1);
}

// The NVIDIA startup check compares a GPU decode of a known clip with a CPU
// decode. There is no GPU here, so a CPU decode stands in for a correct GPU and
// the known nvidia-vaapi-driver faults are simulated on top of it.
app.whenReady().then(async () => {
  const window = new BrowserWindow({
    show: false,
    webPreferences: { contextIsolation: true, nodeIntegration: false, offscreen: true },
  });
  try {
    await window.loadFile(path.join(__dirname, '..', 'index.html'));
    await new Promise(resolve => setTimeout(resolve, 300));
    const result = await window.webContents.executeJavaScript(`(async()=>{
      const assert=(condition,message)=>{if(!condition)throw new Error(message)};
      const probe=await loadGpuDecodeProbe();
      assert(probe.av1.frames.length===45&&probe.h264.frames.length===15,'decode check clips are incomplete');
      // The GPU run is redirected to the CPU decoder, then altered.
      const asGpu=alter=>async(clip,acceleration)=>{const result=await decodeProbeClip(clip,'prefer-software');return acceleration==='prefer-hardware'&&result?alter(result,clip):result};

      const correct=await verifyGpuDecodeAgainstSoftware({decode:asGpu(result=>result)});
      assert(correct.verdict==='ok'&&correct.codec==='av1'&&correct.correlation===1,'a correct decode was not accepted: '+JSON.stringify(correct));

      // A correct GPU decode may convert colour range slightly differently.
      const range=await verifyGpuDecodeAgainstSoftware({decode:asGpu(result=>({...result,pictures:result.pictures.map(picture=>picture.map((value,index)=>index%4===3?value:(value-16)*255/219))}))});
      assert(range.verdict==='ok','a colour-range difference failed the check: '+JSON.stringify(range));

      // nvidia-vaapi-driver before 0.0.18: every picture white.
      const white=await verifyGpuDecodeAgainstSoftware({decode:asGpu(result=>({...result,pictures:result.pictures.map(picture=>new Uint8ClampedArray(picture.length).fill(255))}))});
      assert(white.verdict==='broken','white video passed the check: '+JSON.stringify(white));

      // 0.0.18 on AV1 frame_size_override: the 180-line frames come out at the
      // 192-line sequence size, stretched.
      const stretch=async(clip,acceleration)=>{
        if(acceleration!=='prefer-hardware')return decodeProbeClip(clip,'prefer-software');
        const canvas=document.createElement('canvas');canvas.width=clip.width;canvas.height=clip.height;const context=canvas.getContext('2d',{willReadFrequently:true});
        const pictures=[];let decoded=0;
        const decoder=new VideoDecoder({output:frame=>{decoded++;if(decoded>clip.frames.length-GPU_DECODE_COMPARE_LAST){context.drawImage(frame,0,0,clip.width,192);pictures.push(context.getImageData(0,0,clip.width,clip.height).data)}frame.close()},error:()=>{}});
        decoder.configure({codec:clip.codec,codedWidth:clip.width,codedHeight:clip.height,hardwareAcceleration:'prefer-software'});
        clip.frames.forEach((data,index)=>decoder.decode(new EncodedVideoChunk({type:index?'delta':'key',timestamp:index*33333,data:Uint8Array.from(atob(data),c=>c.charCodeAt(0))})));
        await decoder.flush();decoder.close();return {decoded,pictures};
      };
      const stretched=await verifyGpuDecodeAgainstSoftware({decode:stretch});
      assert(stretched.verdict==='broken'&&stretched.correlation<GPU_DECODE_MIN_CORRELATION,'a stretched AV1 decode passed the check: '+JSON.stringify(stretched));

      // A decoder that drops pictures is broken too.
      const dropped=await verifyGpuDecodeAgainstSoftware({decode:asGpu(result=>({...result,decoded:result.decoded-1}))});
      assert(dropped.verdict==='broken','a decoder that lost pictures passed the check');

      // GeForce RTX 20 / GTX 16: no AV1 on the GPU, so H.264 is checked.
      const noAv1=await verifyGpuDecodeAgainstSoftware({decode:async(clip,acceleration)=>acceleration==='prefer-hardware'&&clip===probe.av1?null:decodeProbeClip(clip,'prefer-software')});
      assert(noAv1.verdict==='ok'&&noAv1.codec==='h264','a GPU without AV1 decode was not checked with H.264: '+JSON.stringify(noAv1));

      const nothing=await verifyGpuDecodeAgainstSoftware({decode:async(clip,acceleration)=>acceleration==='prefer-hardware'?null:decodeProbeClip(clip,'prefer-software')});
      assert(nothing.verdict==='unsupported','a GPU that decodes nothing was not reported unsupported');

      const failing=await verifyGpuDecodeAgainstSoftware({decode:async(clip,acceleration)=>{if(acceleration==='prefer-hardware')throw new Error('decoder error');return decodeProbeClip(clip,'prefer-software')}});
      assert(failing.verdict==='broken','a GPU decoder that errors was not reported broken');
      return {correct:correct.correlation,range:range.correlation,stretched:stretched.correlation,white:white.correlation};
    })()`);
    console.log('PASS GPU decode check', JSON.stringify(result));
    app.exit(0);
  } catch (error) {
    fail(error);
  }
});
