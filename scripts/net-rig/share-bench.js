'use strict';
// The real share stack (record format, sender/receiver core, authenticated UDP lane) between two processes, for use under
// the emulated network in rig-share.sh. The sharer plays a real encoded clip at its own frame rate; the viewer checks that
// every picture arrives intact and in order (a running SHA-256 over all payloads must match) and measures how late they are.
//   node share-bench.js <send|recv> <localIp> <peerIp> <seconds> <clip.ivf> <signalDir>
const crypto = require('crypto');
const fs = require('fs');
const path = require('path');
const { ShareSender, ShareReceiver } = require('../../share-core');
const { ShareLaneRuntime } = require('../../share-lane-runtime');
const { TYPE } = require('../../share-wire');

const [role, localIp, peerIp, secsArg, clipPath, dir] = process.argv.slice(2);
const seconds = Number(secsArg) || 12;
const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));
const waitFile = async file => { for (let i = 0; i < 600; i++) { if (fs.existsSync(file)) { await sleep(50); return JSON.parse(fs.readFileSync(file, 'utf8')); } await sleep(100); } throw new Error('no ' + file); };
const owner = { id: role };

function readIvf(file) {
  const data = fs.readFileSync(file), headerLength = data.readUInt16LE(6), frames = [];
  for (let at = headerLength; at + 12 <= data.length;) { const size = data.readUInt32LE(at); frames.push(new Uint8Array(data.subarray(at + 12, at + 12 + size))); at += 12 + size; }
  return frames;
}

(async () => {
  let peerId = null, onFrame = () => {}, onClose = () => {};
  const runtime = new ShareLaneRuntime({ sameOwner: (a, b) => a.id === b.id, udxOptions: { advertiseHosts: [localIp], stunServers: [], ...(process.env.BUF !== undefined ? { socketBufferBytes: Number(process.env.BUF) } : {}) },
    onOpen: event => { if (role === 'recv') peerId = event.peerId; }, onFrame: event => onFrame(event.frame), onClose: () => onClose() });

  if (role === 'send') {
    const frames = readIvf(clipPath), fps = 60, gop = 120;
    const lane = await runtime.open(owner), token = crypto.randomBytes(24).toString('hex'), key = crypto.randomBytes(32);
    fs.writeFileSync(path.join(dir, 'offer.json'), JSON.stringify({ lane, token, key: key.toString('hex') }));
    const answer = await waitFile(path.join(dir, 'answer.json'));
    const connecting = runtime.establish(owner, { laneId: lane.id, role: 'connect', token, key, remote: answer.lane, timeoutMs: 8000, holdMs: 0 });
    peerId = await connecting;

    const sender = new ShareSender({ emit: () => {} });
    sender.setConfig({ codec: 'av01.0.13H.08', width: 3840, height: 2160 });
    const hash = crypto.createHash('sha256');
    sender.addViewer('v');
    let outstanding = 0, lane2 = null;
    const HIGH = 4 * 1024 * 1024;
    sender.attachLane('v', 'udx', { kind: 'udx', write: bytes => {
      outstanding += bytes.length;
      runtime.send(owner, peerId, bytes).catch(() => {}).finally(() => { outstanding -= bytes.length; if (lane2.blocked && outstanding < HIGH / 2) { lane2.blocked = false; sender.laneWritable('v', 'udx'); } });
      if (outstanding >= HIGH) { lane2.blocked = true; return false; }
      return true;
    } });
    lane2 = { blocked: false };
    onFrame = bytes => { try { const m = JSON.parse(Buffer.from(bytes).toString()); if (m.a !== undefined) sender.onAck('v', m.a); if (m.r) sender.onResend('v'); } catch {} };
    const timer = setInterval(() => sender.tick(), 250);

    const t0 = process.hrtime.bigint(), total = seconds * fps;
    for (let i = 0; i < total; i++) {
      const due = t0 + BigInt(Math.round(i * 1e9 / fps));
      for (;;) { const wait = Number(due - process.hrtime.bigint()) / 1e6; if (wait <= 0) break; await sleep(Math.min(wait, 5)); }
      const data = frames[i % frames.length];
      hash.update(data);
      sender.pushFrame({ key: i % gop === 0, pts: Date.now() * 1000, data });
    }
    sender.end();
    for (let waited = 0; sender.stats().viewers[0]?.behind > 0 && waited < 60000; waited += 100) await sleep(100);
    clearInterval(timer);
    console.log(JSON.stringify({ role: 'send', frames: total, sha256: hash.digest('hex'), resent: sender.stats().viewers[0]?.resent, behind: sender.stats().viewers[0]?.behind }));
    await sleep(500); runtime.close(); process.exit(0);
  } else {
    const offer = await waitFile(path.join(dir, 'offer.json'));
    const lane = await runtime.open(owner);
    runtime.register(owner, offer.token, Buffer.from(offer.key, 'hex'));
    fs.writeFileSync(path.join(dir, 'answer.json'), JSON.stringify({ lane }));
    await runtime.establish(owner, { laneId: lane.id, role: 'accept', token: offer.token, remote: offer.lane, timeoutMs: 8000, holdMs: 0 });
    for (let waited = 0; !peerId && waited < 5000; waited += 20) await sleep(20);

    const hash = crypto.createHash('sha256'), latencies = [], gaps = [];
    let frames = 0, bytes = 0, lastAt = 0, done = false;
    const receiver = new ShareReceiver({
      onRecord: record => {
        if (record.type === TYPE.END) { done = true; return; }
        const now = Date.now(); latencies.push(now - record.pts / 1000); if (lastAt) gaps.push(now - lastAt); lastAt = now;
        hash.update(record.payload); frames++; bytes += record.payload.length;
      },
      onStuck: () => runtime.send(owner, peerId, Buffer.from('{"r":1}')).catch(() => {}),
    });
    receiver.start(0);
    // A receiver that is busy now and then, as a real main process is: the socket buffer has to hold what arrives meanwhile.
    if (Number(process.env.STALL_MS) > 0) setInterval(() => { const until = Date.now() + Number(process.env.STALL_MS); while (Date.now() < until); }, Number(process.env.STALL_EVERY_MS) || 200);
    onFrame = chunk => { receiver.pushBytes('udx', chunk); runtime.credit(owner, peerId, chunk.length); };
    const timer = setInterval(() => { receiver.tick(); runtime.send(owner, peerId, Buffer.from(JSON.stringify({ a: receiver.ackSeq }))).catch(() => {}); }, 100);
    for (let waited = 0; !done && waited < (seconds + 90) * 1000; waited += 50) await sleep(50);
    clearInterval(timer);
    await runtime.send(owner, peerId, Buffer.from(JSON.stringify({ a: receiver.ackSeq }))).catch(() => {});   // the last acknowledgement, so the sharer can release everything
    const sorted = [...latencies].sort((a, b) => a - b), q = p => sorted.length ? Math.round(sorted[Math.min(sorted.length - 1, Math.floor(sorted.length * p))]) : 0;
    console.log(JSON.stringify({ role: 'recv', ended: done, frames, sha256: hash.digest('hex'), mbps: +(bytes * 8 / seconds / 1e6).toFixed(1), latP50: q(.5), latP95: q(.95), latP99: q(.99), latMax: q(1), stalls250: gaps.filter(g => g > 250).length, duplicates: receiver.duplicates }));
    await sleep(300); runtime.close(); process.exit(0);
  }
})().catch(error => { console.log(JSON.stringify({ role, error: String(error?.stack || error) })); process.exit(1); });
