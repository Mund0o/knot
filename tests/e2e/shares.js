'use strict';

// A screen share as two people meet it: two real apps, a local Worker, a call, a share started with the real code path. The "screen" is a
// canvas that counts frames in big black and white blocks, so the viewer's picture can be read back and the frame number recovered:
// what the viewer sees, how far behind live it is, and whether it ever stands still.
//   node tests/e2e/shares.js [filter]        E2E_LATENCY=60 E2E_JITTER=30
const { Rig, sleep } = require('./rig');

const LATENCY = Number(process.env.E2E_LATENCY ?? 60), JITTER = Number(process.env.E2E_JITTER ?? 30);
const FILTER = process.argv[2] || '';
const expect = (condition, message) => { if (!condition) throw new Error(message); };

// ---- a call, the way calls.js joins one
const SNAP = `(async()=>{let inbound=0;try{if(pc){const stats=await pc.getStats();stats.forEach(r=>{if(r.type==='inbound-rtp'&&r.kind==='audio')inbound+=r.bytesReceived||0})}}catch{}return{btn:callBtn.dataset.callState,disabled:callBtn.disabled,active:!!callActive,friendInCall:!!friendInCall,pc:pc?pc.connectionState:null,inbound}})()`;
async function join(app) {
  for (let click = 0; click < 5; click++) {
    const s = await app.eval(SNAP);
    if (s.btn === 'end' && s.active) return;
    if (!s.disabled) await app.eval('callBtn.click()');
    const until = Date.now() + 8000;
    while (Date.now() < until) { const t = await app.eval(SNAP); if (t.active && t.btn === 'end') return; await sleep(100); }
  }
  throw new Error(app.name + ' could not join the call');
}
async function startCall(rig, ids) {
  const { alice: a, bob: b } = rig.apps;
  await a.eval(`selectFriend(${JSON.stringify(ids.bId)})`); await b.eval(`selectFriend(${JSON.stringify(ids.aId)})`);
  await join(a); await b.waitFor('friendInCall', 'B to see the call', 10000); await join(b);
  for (const app of [a, b]) await app.waitFor(`pc&&pc.connectionState==='connected'&&!screenBtn.disabled`, 'the call to be up', 20000);
  return [a, b];
}

// ---- the "screen": 16 blocks carry the frame number in binary. It is drawn on every animation frame by a timer that does not depend on the window being shown.
// (captureDisplayStream returns a new stream every call, like the real picker; a stopped share ends its stream's track.)
// The script is collapsed to one line before it is sent, so it must not contain // comments.
const INSTALL_SCREEN = (w, h, fps) => `(()=>{
  const canvas=document.createElement('canvas');canvas.width=${w};canvas.height=${h};canvas.style.cssText='position:fixed;left:-9999px';document.body.append(canvas);
  const ctx=canvas.getContext('2d');let n=0;
  const draw=()=>{n++;ctx.fillStyle='#202428';ctx.fillRect(0,0,${w},${h});
    for(let bit=0;bit<16;bit++){ctx.fillStyle=(n>>bit)&1?'#ffffff':'#000000';ctx.fillRect(40+bit*60,40,56,56)}
    ctx.fillStyle='hsl('+(n*3%360)+' 70% 55%)';ctx.fillRect(40+(n*7)%(${w}-400),200,300,200);
    ctx.fillStyle='#d0d4da';ctx.font='28px monospace';for(let i=0;i<8;i++)ctx.fillText('frame '+n+' line '+i+' '+((n*31+i*17)%997),40,460+i*34)};
  draw();window.__screen={canvas,get frame(){return n},timer:setInterval(draw,${Math.round(1000 / fps)}),stop(){clearInterval(this.timer);canvas.remove()}};
  captureDisplayStream=async()=>canvas.captureStream(${fps});
  tuneDisplayTrack=async()=>{};waitForDisplayFrames=async()=>({width:${w},height:${h},fps:${fps}});
  chooseScreenShare=async()=>({});shareRecorderUsable=async()=>false;
  return true})()`;

// Reads the frame number off a viewer's canvas (found by `locate`, an expression for the canvas element). 0 when nothing is drawn yet.
const readFrame = locate => `(()=>{
  const canvas=${locate};if(!canvas||!canvas.width)return{frame:0,w:0,h:0};
  const ctx=canvas.getContext('2d'),sx=canvas.width/${1280},sy=canvas.height/${720};let n=0;
  for(let bit=0;bit<16;bit++){const d=ctx.getImageData(Math.round((68+bit*60)*sx),Math.round(68*sy),1,1).data;if((d[0]+d[1]+d[2])/3>128)n|=1<<bit}
  return{frame:n,w:canvas.width,h:canvas.height}})()`;
const READ_FRAME = readFrame("remoteScreen.parentElement?.querySelector('.native-screen-canvas')");

// ---- what the compositor really shows: a screenshot of the viewer's page, decoded here (8-bit PNG, no interlace) ----
const zlib = require('zlib');
function decodePng(buffer) {
  let at = 8, width = 0, height = 0, colorType = 0; const data = [];
  while (at < buffer.length) {
    const length = buffer.readUInt32BE(at), type = buffer.toString('ascii', at + 4, at + 8), body = buffer.subarray(at + 8, at + 8 + length);
    if (type === 'IHDR') { width = body.readUInt32BE(0); height = body.readUInt32BE(4); colorType = body[9]; if (body[8] !== 8 || body[12] !== 0) throw new Error('unsupported PNG'); }
    else if (type === 'IDAT') data.push(body); else if (type === 'IEND') break;
    at += 12 + length;
  }
  const channels = colorType === 6 ? 4 : colorType === 2 ? 3 : 0; if (!channels) throw new Error('unsupported PNG color type ' + colorType);
  const raw = zlib.inflateSync(Buffer.concat(data)), stride = width * channels, out = Buffer.alloc(height * stride);
  for (let y = 0; y < height; y++) {
    const filter = raw[y * (stride + 1)], row = raw.subarray(y * (stride + 1) + 1, (y + 1) * (stride + 1)), above = y ? out.subarray((y - 1) * stride, y * stride) : Buffer.alloc(stride), line = out.subarray(y * stride, (y + 1) * stride);
    for (let x = 0; x < stride; x++) {
      const a = x >= channels ? line[x - channels] : 0, b = above[x], c = x >= channels ? above[x - channels] : 0;
      const predictor = filter === 0 ? 0 : filter === 1 ? a : filter === 2 ? b : filter === 3 ? (a + b) >> 1 : (() => { const p = a + b - c, pa = Math.abs(p - a), pb = Math.abs(p - b), pc = Math.abs(p - c); return pa <= pb && pa <= pc ? a : pb <= pc ? b : c; })();
      line[x] = (row[x] + predictor) & 255;
    }
  }
  return { width, height, channels, pixel: (x, y) => { const i = (Math.round(y) * width + Math.round(x)) * channels; return [out[i], out[i + 1], out[i + 2]]; } };
}
// The frame number as the screen really shows it: where the tile is drawn (in device pixels), sampled from a screenshot of the page.
async function frameOnScreen(app, canvasExpression) {
  // A fresh profile opens the account onboarding dialog over everything; a person would have dismissed it.
  await app.eval("document.querySelectorAll('dialog[open]').forEach(dialog=>dialog.close())");
  await sleep(300);
  const box = await app.eval(`(()=>{const canvas=${canvasExpression};if(!canvas)return null;const r=canvas.getBoundingClientRect(),style=getComputedStyle(canvas);return{x:r.left,y:r.top,w:r.width,h:r.height,ratio:window.devicePixelRatio,opacity:Number(style.opacity),hidden:canvas.hidden||style.visibility==='hidden'||style.display==='none',live:canvas.classList.contains('is-live'),cw:canvas.width,ch:canvas.height}})()`);
  if (!box || box.hidden || box.w < 50) return { frame: 0, box };
  const shot = decodePng(Buffer.from((await app.cdp('Page.captureScreenshot', { format: 'png' })).data, 'base64'));
  // The picture is shown 16:9 inside the canvas element (letterboxed when the element has another shape).
  const fit = Math.min(box.w / 16, box.h / 9), w = fit * 16, h = fit * 9, left = box.x + (box.w - w) / 2, top = box.y + (box.h - h) / 2;
  let n = 0;
  for (let bit = 0; bit < 16; bit++) { const [r, g, b] = shot.pixel((left + w * (68 + bit * 60) / 1280) * box.ratio, (top + h * 68 / 720) * box.ratio); if ((r + g + b) / 3 > 128) n |= 1 << bit; }
  return { frame: n, box };
}

// The windows are real and visible but fully transparent (KNOT_TEST_RIG_SHOW), so page visibility and animation frames behave as they do for a person.
const LIVE_VIEW = `document.visibilityState==='visible'`;
const SHOWN = { alice: { env: { KNOT_TEST_RIG_SHOW: '1' } }, bob: { env: { KNOT_TEST_RIG_SHOW: '1' } } };

const scenarios = {
  async 'a share reaches the other screen'(rig, ids) {
    const [a, b] = await startCall(rig, ids);
    await a.eval(LIVE_VIEW); await b.eval(LIVE_VIEW);
    await a.eval(`shareFrameRate=30;shareResolution='source';screenCodec='auto';screenAudioOn=false;syncScreenAudioToggle();${INSTALL_SCREEN(1280, 720, 30).replace(/\s+/g, ' ')}`);
    const started = Date.now();
    await a.eval('startScreenShare()');
    await a.waitFor('screenActive&&!!dmShare', 'the share to start', 20000);
    await b.waitFor('!!dmWatch&&dmWatch.stats().player.painted>5', 'the first pictures', 20000);
    const firstPicture = Date.now() - started;
    // Watch for two seconds: the frame must keep advancing, and never stand still for long.
    const seen = []; const until = Date.now() + 2500;
    while (Date.now() < until) { const [mine, theirs] = await Promise.all([a.eval('__screen.frame'), b.eval(READ_FRAME)]); seen.push({ at: Date.now(), live: mine, shown: theirs.frame, w: theirs.w, h: theirs.h }); await sleep(100); }
    const shown = seen.filter(s => s.shown > 0);
    expect(shown.length >= 15, `the viewer's picture could not be read (${shown.length} readings of ${seen.length})`);
    expect(shown.at(-1).shown > shown[0].shown + 20, `the picture is not moving: ${shown[0].shown} -> ${shown.at(-1).shown}`);
    const behind = shown.map(s => (s.live - s.shown) / 30 * 1000).sort((x, y) => x - y), median = behind[Math.floor(behind.length / 2)];
    expect(shown.at(-1).w > 0 && shown.at(-1).h > 0, 'the view has no size');
    // And what the window really displays (not just what the canvas holds): the same frame counter, read from a screenshot of the viewer.
    const onScreen = await frameOnScreen(b, "remoteScreen.parentElement?.querySelector('.native-screen-canvas')");
    const liveNow = await a.eval('__screen.frame');
    expect(onScreen.box && !onScreen.box.hidden && onScreen.box.opacity === 1 && onScreen.box.live, 'the picture is not revealed on screen: ' + JSON.stringify(onScreen.box));
    expect(onScreen.frame > 0 && Math.abs(onScreen.frame - liveNow) < 60, `the window shows frame ${onScreen.frame} while the sharer is at ${liveNow}`);
    const line = await b.eval('screenStatus.textContent');
    expect(/^Friend sharing · \d+p · \d+ fps · [\d.]+ Mbps · \w[\w.]* on (CPU|GPU)/.test(line), 'the line under the share does not say what arrives and what decodes it: ' + line);
    const player = await b.eval('JSON.stringify(dmWatch.stats().player)'), host = await a.eval('JSON.stringify(dmShare.stats())');
    const p = JSON.parse(player), h = JSON.parse(host);
    expect(p.stalls <= 1, 'the viewer stalled ' + p.stalls + ' times on a healthy link');
    expect(p.decodeSkips === 0 && p.errors === 0, `decoder skips ${p.decodeSkips} errors ${p.errors}`);
    expect(h.viewers.length === 1, 'the sharer has ' + h.viewers.length + ' viewers');
    return { firstPictureMs: firstPicture, medianBehindLiveMs: Math.round(median), lane: h.viewers[0].lane, sharerSource: h.source, viewerStalls: p.stalls, painted: p.painted, delayMs: p.delayMs, decoder: p.decoder, size: shown.at(-1).w + 'x' + shown.at(-1).h };
  },

  async 'the sound is held back with the picture'(rig, ids) {
    const [a, b] = await startCall(rig, ids);
    await a.eval(LIVE_VIEW); await b.eval(LIVE_VIEW);
    await a.eval(`shareFrameRate=30;shareResolution='source';screenCodec='auto';screenAudioOn=false;syncScreenAudioToggle();${INSTALL_SCREEN(1280, 720, 30).replace(/\s+/g, ' ')}`);
    await a.eval('startScreenShare()');
    await b.waitFor('!!dmWatch&&dmWatch.stats().player.painted>5', 'the first pictures', 20000);
    await sleep(2500);
    const result = await b.eval(`(()=>{const sender=screenAudioTransceiver?.sender||screenAudioTransceiver,t=pc.getTransceivers().find(item=>item.sender===sender),r=t?.receiver;return{has:!!r,supported:!!r&&'jitterBufferTarget' in r,target:r?.jitterBufferTarget,delay:dmWatch.delayMs}})()`);
    expect(result.has, 'no screen-audio receiver'); expect(result.supported, 'the receiver has no jitterBufferTarget');
    expect(result.target >= 120 && result.target <= 4000, 'target out of range: ' + result.target);
    expect(Math.abs(result.target - (result.delay + 40)) <= 60, `sound is held ${result.target} ms but the picture is ${result.delay} ms behind`);
    return result;
  },

  async 'stopping ends it for the viewer, and a new share works'(rig, ids) {
    const [a, b] = await startCall(rig, ids);
    await a.eval(LIVE_VIEW); await b.eval(LIVE_VIEW);
    await a.eval(`shareFrameRate=30;shareResolution='source';screenCodec='auto';screenAudioOn=false;syncScreenAudioToggle();${INSTALL_SCREEN(1280, 720, 30).replace(/\s+/g, ' ')}`);
    const rounds = [];
    for (let round = 0; round < 2; round++) {
      await a.eval('startScreenShare()');
      await b.waitFor('!!dmWatch&&dmWatch.stats().player.painted>5', 'round ' + round + ': the first pictures', 20000);
      const stopped = Date.now();
      await a.eval('stopScreenShare()');
      await b.waitFor('!dmWatch&&remoteScreen.hidden&&!dmShareOffer', 'round ' + round + ': the share to end for the viewer', 15000);
      await a.waitFor('!screenActive&&!dmShare&&screenBtn.textContent==="Share screen"', 'round ' + round + ': the sharer to be idle', 8000);
      rounds.push(Date.now() - stopped);
      await sleep(500);
    }
    return { endedForViewerMs: rounds };
  },

  async 'stop watching and resume'(rig, ids) {
    const [a, b] = await startCall(rig, ids);
    await a.eval(LIVE_VIEW); await b.eval(LIVE_VIEW);
    await a.eval(`shareFrameRate=30;shareResolution='source';screenCodec='auto';screenAudioOn=false;syncScreenAudioToggle();${INSTALL_SCREEN(1280, 720, 30).replace(/\s+/g, ' ')}`);
    await a.eval('startScreenShare()');
    await b.waitFor('!!dmWatch&&dmWatch.stats().player.painted>5', 'the first pictures', 20000);
    await b.eval('stopWatchingRemoteShare()');
    await b.waitFor('!dmWatch&&!!dmShareOffer', 'watching to stop', 5000);
    await a.waitFor('dmShare.stats().viewers.length===0', 'the sharer to drop the viewer', 8000);
    const before = await a.eval('dmShare.stats().nextSeq');
    await sleep(1500);
    await b.eval(`watchDmShare('remote')`);
    await b.waitFor('!!dmWatch&&dmWatch.stats().player.painted>5', 'pictures after resuming', 20000);
    const after = await a.eval('dmShare.stats().nextSeq');
    const first = await b.eval(READ_FRAME), live = await a.eval('__screen.frame');
    expect(first.frame > 0 && live - first.frame < 90, `after resuming the viewer is at frame ${first.frame} while the sharer is at ${live}`);
    return { recordsWhileAway: after - before, resumedAtFrame: first.frame, sharerFrame: live };
  },
};

const DM_SETUP = (a, extra = '') => a.eval(`shareFrameRate=30;shareResolution='source';screenCodec='auto';screenAudioOn=false;syncScreenAudioToggle();${INSTALL_SCREEN(1280, 720, 30).replace(/\s+/g, ' ')}${extra}`);

// ---- the link misbehaves: what a viewer sees, and what is never changed
scenarios['a stalled link shows buffering over the last picture, then recovers, and nothing is lowered'] = async (rig, ids) => {
  const [a, b] = await startCall(rig, ids);
  await DM_SETUP(a);
  await a.eval('startScreenShare()');
  await b.waitFor('!!dmWatch&&dmWatch.stats().player.painted>30', 'a steady picture', 20000);
  const before = JSON.parse(await b.eval('JSON.stringify(dmWatch.stats().player)')), beforeCfg = await b.eval('JSON.stringify(dmWatch.viewer.configs ? [...dmWatch.viewer.configs.values()] : [])');
  const overlay = `(()=>{const el=remoteScreenTile.querySelector('.share-buffering');return !!el&&!el.hidden})()`;
  // The link stops delivering to the viewer for a while (everything sent meanwhile is lost to it).
  await b.eval('dmWatch.viewer.receiver.pushBytes=()=>{};true');
  const stallStarted = Date.now(); const during = [];
  while (Date.now() - stallStarted < 4200) { during.push({ frame: (await b.eval(READ_FRAME)).frame, overlay: await b.eval(overlay) }); await sleep(200); }
  if (process.env.E2E_DEBUG) console.log('DEBUG stats at end of stall', await b.eval('JSON.stringify(dmWatch.stats())'));
  const frozen = during.at(-1).frame;
  expect(frozen > 0 && during.slice(-6).every(v => v.frame === frozen), 'the picture did not stay on the last frame during the stall: ' + JSON.stringify(during.slice(-6)));
  expect(during.some(v => v.overlay), 'no buffering view appeared during a four second stall');
  await b.eval('delete dmWatch.viewer.receiver.pushBytes;true');
  const resumed = Date.now();
  await b.waitFor(`(()=>{const c=remoteScreen.parentElement.querySelector('.native-screen-canvas');return !!c})()&&dmWatch.stats().player.painted>${before.painted + 150}`, 'pictures to flow again', 45000);
  await b.waitFor(overlay.replace('return !!el&&!el.hidden', 'return !el||el.hidden'), 'the buffering view to go away', 20000);
  const recoveredMs = Date.now() - resumed;
  const after = JSON.parse(await b.eval('JSON.stringify(dmWatch.stats().player)')), afterCfg = await b.eval('JSON.stringify(dmWatch.viewer.configs ? [...dmWatch.viewer.configs.values()] : [])');
  const host = JSON.parse(await a.eval('JSON.stringify(dmShare.stats())'));
  expect(after.width === before.width && after.height === before.height, `the picture size changed: ${before.width}x${before.height} -> ${after.width}x${after.height}`);
  expect(afterCfg === beforeCfg, 'the stream description changed during the stall');
  expect(after.stalls >= 1, 'the viewer never recorded the stall');
  expect(host.viewers[0].skips === 0, 'the sharer skipped pictures for a stalled viewer that was only seconds behind');
  expect(after.decodeSkips === 0 && after.errors === 0, `decoder skips ${after.decodeSkips} errors ${after.errors}`);
  const live = await a.eval('__screen.frame'), shown = (await b.eval(READ_FRAME)).frame;
  return { stallMs: 4200, recoveredMs, stalls: after.stalls, delayMs: Math.round(after.delayMs), resent: host.viewers[0].resent, behindNowFrames: live - shown, size: after.width + 'x' + after.height };
};

scenarios['without UDP the share rides the data channel, smoothly'] = async (rig, ids) => {
  const [a, b] = await startCall(rig, ids);
  await DM_SETUP(a);
  await a.eval('startScreenShare()');
  await b.waitFor('!!dmWatch&&dmWatch.stats().player.painted>40', 'a steady picture', 20000);
  const seen = []; const until = Date.now() + 3000;
  while (Date.now() < until) { const [live, shown] = await Promise.all([a.eval('__screen.frame'), b.eval(READ_FRAME)]); seen.push((live - shown.frame) / 30 * 1000); await sleep(100); }
  seen.sort((x, y) => x - y);
  const host = JSON.parse(await a.eval('JSON.stringify(dmShare.stats())')), p = JSON.parse(await b.eval('JSON.stringify(dmWatch.stats().player)'));
  expect(host.viewers[0].lane === 'dc', 'the share is not on the data channel: ' + host.viewers[0].lane);
  expect(host.udx[0].state !== 'ready', 'a UDP lane came up although it was switched off');
  expect(p.stalls === 0 && seen[Math.floor(seen.length / 2)] < 700, `stalls ${p.stalls}, median behind ${seen[Math.floor(seen.length / 2)]} ms`);
  return { lane: host.viewers[0].lane, udx: host.udx[0].state, medianBehindMs: Math.round(seen[Math.floor(seen.length / 2)]), stalls: p.stalls };
};
scenarios['without UDP the share rides the data channel, smoothly'].noUdp = true;

// ---- a long share: pictures keep flowing and memory stays flat. Opt-in because it takes minutes:  E2E_ENDURANCE_MS=300000 node tests/e2e/shares.js endurance
const rssMb = app => { try { return Math.round(require('child_process').execFileSync('ps', ['-eo', 'pgid=,rss='], { encoding: 'utf8' }).split('\n').reduce((sum, line) => { const [pgid, rss] = line.trim().split(/\s+/).map(Number); return pgid === app.child.pid ? sum + (rss || 0) : sum; }, 0) / 1024); } catch { return 0; } };
const heapMb = async app => Math.round((await app.cdp('Runtime.getHeapUsage')).usedSize / 1048576);
const endurance = async (rig, ids) => {
  const total = Number(process.env.E2E_ENDURANCE_MS), [a, b] = await startCall(rig, ids);
  await DM_SETUP(a);
  await a.eval('startScreenShare()');
  await b.waitFor('!!dmWatch&&dmWatch.stats().player.painted>40', 'a steady picture', 20000);
  const samples = [], began = Date.now();
  while (Date.now() - began < total) {
    await sleep(20000);
    const p = JSON.parse(await b.eval('JSON.stringify(dmWatch.stats().player)')), h = JSON.parse(await a.eval('JSON.stringify(dmShare.stats())')), v = JSON.parse(await b.eval('JSON.stringify(dmWatch.stats().viewer)'));
    samples.push({ s: Math.round((Date.now() - began) / 1000), painted: p.painted, stalls: p.stalls, jumps: p.jumps, queued: p.queued, waiting: p.decodedWaiting, pending: v.pending, logMB: Math.round(h.logBytes / 1048576 * 10) / 10, records: h.records, heapA: await heapMb(a), heapB: await heapMb(b), rssA: rssMb(a), rssB: rssMb(b) });
  }
  const first = samples[1] || samples[0], last = samples.at(-1);
  console.log('  samples: ' + samples.map(x => `${x.s}s painted=${x.painted} stalls=${x.stalls} queued=${x.queued} log=${x.logMB}MB heap=${x.heapA}/${x.heapB}MB rss=${x.rssA}/${x.rssB}MB`).join('\n           '));
  expect(last.painted > first.painted + 100, 'pictures stopped flowing');
  expect(last.stalls <= 2 && last.jumps === 0, `stalls ${last.stalls}, jumps ${last.jumps} on a healthy link`);
  expect(last.logMB < 20 && last.queued < 100 && last.waiting < 60 && last.pending < 50, 'a queue is growing: ' + JSON.stringify(last));
  expect(last.heapA - first.heapA < 40 && last.heapB - first.heapB < 40, `JS heap grew: sharer ${first.heapA}->${last.heapA} MB, viewer ${first.heapB}->${last.heapB} MB`);
  expect(last.rssA - first.rssA < 200 && last.rssB - first.rssB < 200, `process memory grew: sharer ${first.rssA}->${last.rssA} MB, viewer ${first.rssB}->${last.rssB} MB`);
  return { seconds: last.s, painted: last.painted, stalls: last.stalls, heapGrowthMB: [last.heapA - first.heapA, last.heapB - first.heapB], rssGrowthMB: [last.rssA - first.rssA, last.rssB - first.rssB] };
};
if (process.env.E2E_ENDURANCE_MS) scenarios['endurance: a long share stays steady'] = endurance;

// ---- the Linux recorder path (GPU Screen Recorder), pointed at a named monitor so no portal dialog ever opens on the desktop
function recorderMonitor() {
  try {
    const { execFileSync } = require('child_process');
    const { linuxMainGpu } = require('../../linux-gpu'), { nativeScreenInfo, gpuScreenRecorderCommand } = require('../../native-screen');
    const gpu = linuxMainGpu(); if (process.platform !== 'linux' || !gpu || !['0x10de', '0x1002'].includes(gpu.vendor) || !nativeScreenInfo(gpu.vendor, gpu.card).supported) return null;
    const runner = gpuScreenRecorderCommand(), listing = execFileSync(runner.command, [...runner.prefix, '--info'], { encoding: 'utf8', timeout: 10000 });
    return listing.split(/\r?\n/).map(line => /^([A-Za-z0-9_.-]+)\|(\d+)x(\d+)$/.exec(line)).find(Boolean)?.[1] || null;
  } catch { return null; }
}
const recorderPids = () => { try { return require('child_process').execFileSync('ps', ['-eo', 'pid,args'], { encoding: 'utf8' }).split('\n').filter(line => /gpu-screen-recorder/.test(line) && /-k av1/.test(line)).map(line => line.trim().split(/\s+/)[0]); } catch { return []; } };

const recorderScenarios = {
  async 'the Linux recorder reaches the other screen, and leaves nothing running'(rig, ids) {
    const monitor = recorderMonitor();
    if (!monitor) return 'SKIPPED (no NVIDIA/AMD GPU Screen Recorder with a monitor here)';
    const [a, b] = await startCall(rig, ids);
    const before = new Set(recorderPids());
    await a.eval(`shareFrameRate=60;shareResolution='1080';screenCodec='auto';screenAudioOn=false;syncScreenAudioToggle();shareRecorderUsable=async()=>true;chooseScreenShare=async()=>({});const realSource=ShareKit.recorderSource;ShareKit.recorderSource=(api,options)=>realSource(api,{...options,captureSource:${JSON.stringify(monitor)}});true`);
    const started = Date.now();
    await a.eval('startScreenShare()');
    await a.waitFor('screenActive&&!!dmShare', 'the share to start', 30000);
    await b.waitFor('!!dmWatch&&dmWatch.stats().player.painted>10', 'pictures from the recorder', 30000);
    const firstPictureMs = Date.now() - started;
    await sleep(2500);
    const p = JSON.parse(await b.eval('JSON.stringify(dmWatch.stats().player)')), h = JSON.parse(await a.eval('JSON.stringify(dmShare.stats())'));
    expect(h.source === 'recorder', 'the sharer is not using the recorder: ' + h.source);
    expect(p.width === 1920 && p.height === 1080, `the viewer decodes ${p.width}x${p.height}, not 1920x1080`);
    expect(p.errors === 0 && p.decodeSkips === 0, `decoder errors ${p.errors}, skips ${p.decodeSkips}`);
    expect(p.painted > 20, 'too few pictures painted: ' + p.painted);
    const during = recorderPids().filter(pid => !before.has(pid)); expect(during.length >= 1, 'no recorder process was started');
    await a.eval('stopScreenShare()');
    await a.waitFor('!screenActive&&!dmShare', 'the sharer to be idle', 10000);
    for (let waited = 0; recorderPids().some(pid => !before.has(pid)) && waited < 6000; waited += 100) await sleep(100);
    const left = recorderPids().filter(pid => !before.has(pid)); expect(!left.length, 'the recorder outlived the share: ' + left.join(','));
    return { firstPictureMs, size: p.width + 'x' + p.height, painted: p.painted, renderFps: Math.round(p.renderFps), decoder: p.decoder, lane: h.viewers[0]?.lane, recorderGone: true };
  },
};

// ---- a group call: three apps in one group DM voice channel
async function startGroupCall(rig) {
  const { alice: a, bob: b, carol: c } = rig.apps;
  const ab = await rig.befriend('alice', 'bob'), ac = await rig.befriend('alice', 'carol'); await rig.befriend('bob', 'carol');
  await a.eval(`directorySend({type:'create-group-dm',name:'trio',memberIds:[${JSON.stringify(ab.bId)},${JSON.stringify(ac.bId)}]})`);
  for (const app of [a, b, c]) await app.waitFor('(directorySnapshot.groupDms||[]).length===1', 'the group', 20000);
  const gid = await a.eval('directorySnapshot.groupDms[0].id');
  for (const app of [a, b, c]) {
    await app.eval(`selectGroupDm(${JSON.stringify(gid)})`);
    await app.eval(`joinServerVoice(groupDm(${JSON.stringify(gid)}).channels.find(channel=>channel.type==='voice'))`);
  }
  for (const app of [a, b, c]) await app.waitFor(`serverPeers.size===2&&[...serverPeers.values()].every(state=>state.pc.connectionState==='connected'&&state.channel?.readyState==='open')`, 'the group mesh to connect', 40000);
  return { gid, aliceId: await a.eval('directoryUserId'), apps: [a, b, c] };
}
const GROUP_CANVAS = aliceId => `(serverPeers.get(${JSON.stringify(aliceId)})?.screen?.parentElement||document.createElement('div')).querySelector('.native-screen-canvas')`;

const groupScenarios = {
  async 'a group share reaches both watchers, and stops cleanly'(rig) {
    const { aliceId, apps: [a, b, c] } = await startGroupCall(rig);
    await a.eval(`shareFrameRate=30;shareResolution='source';screenCodec='auto';screenAudioOn=false;syncScreenAudioToggle();${INSTALL_SCREEN(1280, 720, 30).replace(/\s+/g, ' ')}`);
    const started = Date.now();
    await a.eval('startServerScreenShare({skipPicker:true})');
    await a.waitFor('!!serverShare&&!!serverShare.sender.config', 'the share to start', 20000);
    const watching = id => `(()=>{const s=serverPeers.get(${JSON.stringify(id)});return !!s?.shareWatch&&s.shareWatch.stats().player.painted>5})()`;
    for (const app of [b, c]) await app.waitFor(watching(aliceId), 'the first pictures', 25000);
    const firstPictureMs = Date.now() - started;
    const seen = { bob: [], carol: [] }; const until = Date.now() + 2500;
    while (Date.now() < until) {
      const [live, x, y] = await Promise.all([a.eval('__screen.frame'), b.eval(readFrame(GROUP_CANVAS(aliceId))), c.eval(readFrame(GROUP_CANVAS(aliceId)))]);
      seen.bob.push({ live, shown: x.frame }); seen.carol.push({ live, shown: y.frame }); await sleep(100);
    }
    const report = {};
    for (const [name, list] of Object.entries(seen)) {
      const shown = list.filter(v => v.shown > 0);
      expect(shown.length >= 15, `${name}'s picture could not be read (${shown.length} of ${list.length})`);
      expect(shown.at(-1).shown > shown[0].shown + 20, `${name}'s picture is not moving`);
      const behind = shown.map(v => (v.live - v.shown) / 30 * 1000).sort((p, q) => p - q); report[name + 'BehindMs'] = Math.round(behind[Math.floor(behind.length / 2)]);
    }
    const host = JSON.parse(await a.eval('JSON.stringify(serverShare.sender.stats())'));
    expect(host.viewers.length === 2, 'the sharer has ' + host.viewers.length + ' viewers');
    // Carol stops watching: only she stops receiving.
    await c.eval(`stopWatchingServerShare(${JSON.stringify(aliceId)})`);
    await a.waitFor('serverShare.sender.stats().viewers.length===1', 'the sharer to drop carol', 8000);
    await sleep(800);
    expect(await b.eval(watching(aliceId)), 'bob stopped receiving when carol stopped');
    // Alice stops: bob's view goes away.
    const stopped = Date.now(); await a.eval('stopServerScreenShare()');
    await b.waitFor(`!serverPeers.get(${JSON.stringify(aliceId)}).shareWatch&&!serverPeers.get(${JSON.stringify(aliceId)}).screen`, 'the share to end for bob', 15000);
    await a.waitFor('!serverShare&&!serverScreenSharing()', 'the sharer to be idle', 8000);
    return { firstPictureMs, ...report, endedForBobMs: Date.now() - stopped, lanes: host.viewers.map(v => v.lane).join('+') };
  },
};

(async () => {
  const jobs = [...Object.entries(scenarios).map(([name, fn]) => ({ name, fn, group: false })), ...Object.entries(recorderScenarios).map(([name, fn]) => ({ name, fn, group: false, recorder: true })), ...Object.entries(groupScenarios).map(([name, fn]) => ({ name, fn, group: true }))].filter(job => job.name.includes(FILTER));
  let failed = 0;
  for (const job of jobs) {
    const noUdp = job.fn.noUdp ? { KNOT_TEST_NO_UDX: '1' } : {};
    const shown = { env: { KNOT_TEST_RIG_SHOW: '1', ...noUdp } }, sharer = job.recorder ? { env: { KNOT_TEST_RIG_SHOW: '1', KNOT_NATIVE_SCREEN_TEST: '1' } } : shown;
    const rig = new Rig({ latencyMs: LATENCY, jitterMs: JITTER, names: job.group ? ['alice', 'bob', 'carol'] : ['alice', 'bob'], appOptions: { alice: sharer, bob: shown, carol: shown } });
    try {
      await rig.start();
      const detail = job.group ? await job.fn(rig) : await job.fn(rig, await rig.befriend('alice', 'bob'));
      console.log('PASS ' + job.name + ' ' + JSON.stringify(detail));
    } catch (error) {
      failed++; console.log('FAIL ' + job.name + ': ' + (error.message || error));
      for (const app of Object.values(rig.apps)) { const lines = app.console.filter(c => /share|Share|watch|decode|error|exception|stopp|ended|Screen|screen/i.test(c.text)).slice(-25); if (lines.length) console.log(`  [${app.name}] ` + lines.map(l => l.type + ': ' + String(l.text).slice(0, 200)).join('\n  ')); }
    } finally { try { await rig.stop(); } catch (error) { console.log('RIG: ' + error.message); failed++; } }
  }
  console.log(failed ? `${failed} FAILED` : 'ALL SHARE E2E SCENARIOS PASSED');
  process.exit(failed ? 1 : 0);
})();
