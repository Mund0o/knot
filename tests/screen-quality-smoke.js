const fs = require('fs');
const { app, BrowserWindow } = require('electron');

const TEST_TIMEOUT_MS = 30000;

function fail(message, details) {
  if (details) console.error(JSON.stringify(details, null, 2));
  console.error('4K60 screen-share smoke test failed:', message);
  process.exitCode = 1;
  app.exit(1);
}

app.commandLine.appendSwitch('enable-features', 'AcceleratedVideoEncoder,AcceleratedVideoDecodeLinuxZeroCopyGL');
try {
  const intelRenderNode = fs.readdirSync('/sys/class/drm')
    .filter(name => /^renderD\d+$/.test(name))
    .find(name => fs.readFileSync(`/sys/class/drm/${name}/device/vendor`, 'utf8').trim().toLowerCase() === '0x8086');
  if (intelRenderNode) app.commandLine.appendSwitch('hardware-video-device-path', `/dev/dri/${intelRenderNode}`);
} catch {}

app.whenReady().then(async () => {
  const requestedCodec = /^(?:H264|VP9|VP8|AV1)$/.test(process.env.PAIR_TEST_CODEC || '') ? process.env.PAIR_TEST_CODEC : 'H264';
  const window = new BrowserWindow({
    show: false,
    webPreferences: {
      backgroundThrottling: false,
      contextIsolation: true,
      nodeIntegration: false,
      offscreen: true
    }
  });
  const timeout = setTimeout(() => fail('timed out'), TEST_TIMEOUT_MS);
  await window.loadURL('data:text/html,<meta charset="utf-8"><title>Pair 4K60 test</title>');

  try {
    const result = await window.webContents.executeJavaScript(`(async()=>{
      const wait=ms=>new Promise(resolve=>setTimeout(resolve,ms));
      const canvas=document.createElement('canvas');canvas.width=3840;canvas.height=2160;
      const gl=canvas.getContext('webgl',{alpha:false,antialias:false,depth:false,preserveDrawingBuffer:false});
      if(!gl)throw new Error('WebGL unavailable');
      const shader=(type,source)=>{const s=gl.createShader(type);gl.shaderSource(s,source);gl.compileShader(s);if(!gl.getShaderParameter(s,gl.COMPILE_STATUS))throw new Error(gl.getShaderInfoLog(s));return s};
      const program=gl.createProgram();
      gl.attachShader(program,shader(gl.VERTEX_SHADER,'attribute vec2 p;void main(){gl_Position=vec4(p,0.,1.);}'));
      gl.attachShader(program,shader(gl.FRAGMENT_SHADER,'precision highp float;uniform float t;void main(){vec2 p=gl_FragCoord.xy;float n=fract(sin(dot(floor(p/3.)+t,vec2(12.9898,78.233)))*43758.5453);vec3 bands=.5+.5*cos(vec3(0.,2.1,4.2)+t*.8+p.x*.006+p.y*.004);gl_FragColor=vec4(mix(bands,vec3(n),.42),1.);}'));
      gl.linkProgram(program);if(!gl.getProgramParameter(program,gl.LINK_STATUS))throw new Error(gl.getProgramInfoLog(program));gl.useProgram(program);
      const buffer=gl.createBuffer();gl.bindBuffer(gl.ARRAY_BUFFER,buffer);gl.bufferData(gl.ARRAY_BUFFER,new Float32Array([-1,-1,1,-1,-1,1,-1,1,1,-1,1,1]),gl.STATIC_DRAW);
      const position=gl.getAttribLocation(program,'p');gl.enableVertexAttribArray(position);gl.vertexAttribPointer(position,2,gl.FLOAT,false,0,0);const time=gl.getUniformLocation(program,'t');
      let frame=0,track;const stream=canvas.captureStream(0);track=stream.getVideoTracks()[0];const timer=setInterval(()=>{gl.uniform1f(time,frame++/60);gl.drawArrays(gl.TRIANGLES,0,6);gl.flush();track.requestFrame()},1000/60);track.contentHint='motion';
      const senderPc=new RTCPeerConnection(),receiverPc=new RTCPeerConnection();
      senderPc.onicecandidate=e=>{if(e.candidate)receiverPc.addIceCandidate(e.candidate).catch(()=>{})};receiverPc.onicecandidate=e=>{if(e.candidate)senderPc.addIceCandidate(e.candidate).catch(()=>{})};
      const sender=senderPc.addTrack(track,stream),transceiver=senderPc.getTransceivers().find(t=>t.sender===sender),caps=RTCRtpSender.getCapabilities('video');
      const preferred=[],seen=new Set(),testCodec=${JSON.stringify(requestedCodec)};for(const name of [testCodec,'H264','VP9','VP8','AV1'])for(const codec of caps?.codecs||[]){if(codec.mimeType?.toUpperCase()===('VIDEO/'+name)&&!seen.has(codec)){seen.add(codec);preferred.push(codec)}}for(const codec of caps?.codecs||[]){if(!seen.has(codec)&&/^video\\/(?:rtx|red|ulpfec|flexfec)/i.test(codec.mimeType||'')){seen.add(codec);preferred.push(codec)}}if(preferred.length)transceiver.setCodecPreferences(preferred);
      const offer=await senderPc.createOffer();await senderPc.setLocalDescription(offer);await receiverPc.setRemoteDescription(offer);const answer=await receiverPc.createAnswer();await receiverPc.setLocalDescription(answer);await senderPc.setRemoteDescription(answer);
      const connected=Date.now()+5000;while(senderPc.connectionState!=='connected'&&Date.now()<connected)await wait(25);if(senderPc.connectionState!=='connected')throw new Error('local peer connection did not connect');
      let parameters=sender.getParameters();if(!parameters.encodings?.length)parameters.encodings=[{}];Object.assign(parameters.encodings[0],{maxBitrate:160000000,maxFramerate:60,scaleResolutionDownBy:1,priority:'high'});if('networkPriority'in parameters.encodings[0])parameters.encodings[0].networkPriority='high';parameters.degradationPreference='maintain-framerate-and-resolution';try{await sender.setParameters(parameters)}catch{parameters=sender.getParameters();if(!parameters.encodings?.length)parameters.encodings=[{}];Object.assign(parameters.encodings[0],{maxBitrate:160000000,maxFramerate:60,scaleResolutionDownBy:1});parameters.degradationPreference='maintain-framerate-and-resolution';await sender.setParameters(parameters)}
      await wait(5000);let first;for(const report of (await sender.getStats()).values())if(report.type==='outbound-rtp'&&(report.kind==='video'||report.mediaType==='video'))first=report;
      await wait(5000);const senderStats=await sender.getStats(),receiverStats=await receiverPc.getStats();let out,inbound,codec,source;for(const report of senderStats.values()){if(report.type==='outbound-rtp'&&(report.kind==='video'||report.mediaType==='video'))out=report;if(report.type==='media-source'&&(report.kind==='video'||report.mediaType==='video'))source=report}if(out)codec=senderStats.get(out.codecId);for(const report of receiverStats.values())if(report.type==='inbound-rtp'&&(report.kind==='video'||report.mediaType==='video'))inbound=report;
      const appliedParameters=sender.getParameters();clearInterval(timer);track.stop();senderPc.close();receiverPc.close();
      const seconds=Math.max(.001,(out.timestamp-first.timestamp)/1000),frames=Math.max(0,(out.framesEncoded||0)-(first.framesEncoded||0)),encode=Math.max(0,(out.totalEncodeTime||0)-(first.totalEncodeTime||0));
      return {requestedCodec:testCodec,source:{width:source?.width,height:source?.height,fps:source?.framesPerSecond,requestedFrames:frame},sender:{width:out.frameWidth,height:out.frameHeight,fps:out.framesPerSecond,framesEncoded:frames,mbps:(out.bytesSent-first.bytesSent)*8/seconds/1e6,qualityLimitationReason:out.qualityLimitationReason,averageEncodeMs:frames?encode/frames*1000:null,encoderImplementation:out.encoderImplementation||'',powerEfficientEncoder:out.powerEfficientEncoder,codec:codec?.mimeType||''},receiver:{width:inbound?.frameWidth,height:inbound?.frameHeight,fps:inbound?.framesPerSecond,framesDropped:inbound?.framesDropped||0,freezeCount:inbound?.freezeCount||0},parameters:appliedParameters};
    })()`, true);

    const failures = [];
    if (result.sender.width !== 3840 || result.sender.height !== 2160) failures.push('sender resolution is not 3840x2160');
    if ((result.sender.fps || 0) < 55) failures.push('sender is below 55 fps');
    if (result.sender.qualityLimitationReason && result.sender.qualityLimitationReason !== 'none') failures.push('quality limitation: ' + result.sender.qualityLimitationReason);
    if (result.sender.averageEncodeMs !== null && result.sender.averageEncodeMs > 16.7) failures.push('average encode time exceeds one 60 fps frame interval');
    if (result.receiver.width !== 3840 || result.receiver.height !== 2160) failures.push('receiver resolution is not 3840x2160');
    if ((result.receiver.fps || 0) < 55) failures.push('receiver is below 55 fps');
    console.log(JSON.stringify(result, null, 2));
    if (failures.length) return fail(failures.join('; '), result);
    console.log('PASS 3840x2160 at 60 fps with no WebRTC quality limitation');
    clearTimeout(timeout);window.destroy();app.quit();
  } catch (error) {
    clearTimeout(timeout);window.destroy();fail(error?.stack || error?.message || String(error));
  }
});
