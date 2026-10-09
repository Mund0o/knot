'use strict';

// The list of codecs the app believes this computer decodes on its GPU (it is shown in Settings, announced to friends and used for the line under a
// share). Chromium says "supported" to a hardware request it then serves on the CPU, so the app decodes a short test clip for each codec and counts
// it only when the pictures come out as a GPU hands them over (NV12 and the like) and not planar (I420), which is what a software decoder makes.
// Here: the real Chromium decoder on a machine with no hardware decoding (every picture planar, so nothing may be listed), then a stand-in decoder
// that behaves as each kind would.
const path = require('path');
const { app, BrowserWindow } = require('electron');

app.commandLine.appendSwitch('autoplay-policy', 'no-user-gesture-required');
const fail = error => { console.error('hardware decode probe test failed:', error?.stack || error); app.exit(1); };

app.whenReady().then(async () => {
  const window = new BrowserWindow({ show: false, width: 1000, height: 700, webPreferences: { contextIsolation: true, nodeIntegration: false, offscreen: true } });
  try {
    await window.loadFile(path.join(__dirname, '..', 'index.html'), { query: { testMode: '1' } });
    await new Promise(resolve => setTimeout(resolve, 2500));
    const result = await window.webContents.executeJavaScript(`(async () => {
      const assert = (condition, message) => { if (!condition) throw new Error(message); };
      const saved = { list: localHardwareDecode, decode: decodeProbeClip, supported: VideoDecoder.isConfigSupported, announce: announceNetBudget, render: renderVideoDecodeStatus };
      const out = {};
      try {
        announceNetBudget = () => {}; renderVideoDecodeStatus = () => {};

        // 1. the real decoder: each probe clip really decodes (or the browser refuses the codec), and no picture is a GPU's here
        const clips = await loadGpuDecodeProbe();
        assert(clips.av1 && clips.h264 && clips.vp9 && clips.vp9.frames.length >= 5, 'the probe clips are missing a codec');
        out.formats = {};
        for (const [name, key] of [['AV1', 'av1'], ['H264', 'h264'], ['VP9', 'vp9']]) {
          const decoded = await decodeProbeClip(clips[key], 'prefer-software');
          if (decoded) { assert(decoded.decoded === clips[key].frames.length, name + ' clip decoded ' + decoded.decoded + ' of ' + clips[key].frames.length + ' pictures'); out.formats[name] = decoded.format; }
        }
        await probeHardwareDecode();
        assert(Array.isArray(localHardwareDecode), 'the probe left no list');
        out.real = localHardwareDecode.slice();
        for (const name of out.real) assert(!/^I4\\\\d\\\\d/.test(out.formats[name] || ''), name + ' is listed as hardware but its pictures are ' + out.formats[name]);

        // 2. a decoder that behaves like a GPU (NV12), like software (I420), and one that cannot give a format at all
        const behaviour = { AV1: 'NV12', H264: 'I420', VP9: '' };
        VideoDecoder.isConfigSupported = async () => ({ supported: true });
        decodeProbeClip = async clip => ({ decoded: clip.frames.length, pictures: [], format: behaviour[clip.codec.startsWith('av01') ? 'AV1' : clip.codec.startsWith('avc1') ? 'H264' : 'VP9'] });
        await probeHardwareDecode();
        assert(localHardwareDecode.includes('AV1'), 'a codec whose pictures are NV12 was not listed: ' + localHardwareDecode);
        assert(!localHardwareDecode.includes('H264'), 'a codec whose pictures are planar (software) was listed: ' + localHardwareDecode);
        assert(localHardwareDecode.includes('VP9'), 'a codec the page cannot tell about lost the browser\\'s answer: ' + localHardwareDecode);
        out.stand = localHardwareDecode.slice();

        // 3. a codec the browser will not take at all is not listed, and a clip that throws does not remove the browser's answer
        VideoDecoder.isConfigSupported = async ({ codec }) => ({ supported: !codec.startsWith('vp09') });
        decodeProbeClip = async () => { throw new Error('decode timed out'); };
        await probeHardwareDecode();
        assert(!localHardwareDecode.includes('VP9') && localHardwareDecode.includes('AV1') && localHardwareDecode.includes('H264'), 'refused or failing probes were handled wrongly: ' + localHardwareDecode);
        // 4. a decoder that passed the test clip and then had to be given up on a real stream is taken off the list (and friends told); leaving Knot's own
        // GPU decoder for the CPU at a size it does not handle is not a failure of the hardware
        let announced = 0; announceNetBudget = () => { announced++; };
        const watcherOf = (decoder, softwareReason) => ({ stats: () => ({ player: { decoder, softwareReason } }) });
        localHardwareDecode = ['AV1', 'H264'];
        noteDecoderFallback(watcherOf('hardware-preferred', ''), { codec: 'av01.0.13H.08' }); assert(localHardwareDecode.includes('AV1') && announced === 0, 'a hardware decoder that is working was taken off the list');
        noteDecoderFallback(watcherOf('software', 'decoded on the CPU at this size'), { codec: 'av01.0.13H.08' }); assert(localHardwareDecode.includes('AV1') && announced === 0, 'leaving the GPU helper for the CPU was taken for a hardware failure');
        noteDecoderFallback(watcherOf('software', 'The hardware decoder showed a different picture than the software decoder'), { codec: 'av01.0.13H.08' });
        assert(!localHardwareDecode.includes('AV1') && localHardwareDecode.includes('H264') && announced === 1, 'a hardware decoder that was given up on stayed on the list: ' + localHardwareDecode + ' ' + announced);
        noteDecoderFallback(watcherOf('software', 'x'), { codec: 'av01.0.13H.08' }); assert(announced === 1, 'the same fallback was announced twice');
        return out;
      } finally {
        localHardwareDecode = saved.list; decodeProbeClip = saved.decode; VideoDecoder.isConfigSupported = saved.supported; announceNetBudget = saved.announce; renderVideoDecodeStatus = saved.render;
      }
    })()`);
    console.log('PASS the hardware decode list counts only codecs whose pictures come from a GPU', JSON.stringify(result));
    app.exit(0);
  } catch (error) { fail(error); }
});
