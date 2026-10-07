'use strict';

// The controller joins the app's small abilities (send a message to a friend, open a data channel, a capture) to the real engine.
// The real ShareHost and ShareViewer run here over simulated data channels; the recorder, the encoder and the player are stand-ins,
// because what is being checked is the joining: order, ownership, ending, and what the sound is told.
const assert = require('assert');
const Controller = require('../share-controller');
const Session = require('../share-session');
const { TYPE } = require('../share-wire');

const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));
async function until(condition, ms = 6000, label = 'condition') { for (let waited = 0; waited < ms; waited += 10) { if (await condition()) return; await sleep(10); } throw new Error('timed out waiting for ' + label); }
const CONFIG = { codec: 'av01.0.13H.08', width: 3840, height: 2160, fps: 60, encoder: 'fake' };
const picture = (index, key) => ({ key, pts: index * 16667, data: Uint8Array.from({ length: 2000 + (index % 5) * 300 }, (_, i) => (index * 13 + i) & 0xff) });

class DcEnd {
  constructor() { this.readyState = 'connecting'; this.bufferedAmount = 0; this.bufferedAmountLowThreshold = 0; this.binaryType = 'arraybuffer'; this.peer = null; }
  send(data) { if (this.readyState !== 'open') throw new Error('not open'); const bytes = Uint8Array.from(data); setTimeout(() => { if (this.readyState === 'open') this.peer?.onmessage?.({ data: bytes.buffer }); }, 3); }
  close() { this.readyState = 'closed'; this.onclose?.(); }
}
function dataChannelPair() { const a = new DcEnd(), b = new DcEnd(); a.peer = b; b.peer = a; setTimeout(() => { a.readyState = b.readyState = 'open'; a.onopen?.(); b.onopen?.(); }, 4); return { a, b }; }

// A pairShareCapture in the shape the preload gives it.
function fakeRecorderApi({ startResult = { width: 3840, height: 2160, fps: 60, bitrateKbps: 16000, encoder: 'NVENC' } } = {}) {
  const hooks = { config: [], frame: [], error: [], end: [] }, api = { starts: [], stops: 0, hooks };
  const hook = name => cb => { hooks[name].push(cb); return () => { hooks[name] = hooks[name].filter(f => f !== cb); }; };
  Object.assign(api, { onConfig: hook('config'), onFrame: hook('frame'), onError: hook('error'), onEnd: hook('end'), async start(options) { api.starts.push(options); return startResult; }, async stop() { api.stops++; } });
  api.emit = (name, value) => hooks[name].slice().forEach(cb => cb(value));
  return api;
}

// A player that records what it is given and answers like the real one where the controller depends on it.
function fakePlayerModule() {
  const made = [];
  return {
    made,
    createSharePlayer(options) {
      const player = { options, configs: [], records: [], active: true, destroyed: false, delay: 250, lastPacketAt: 0, lastLiveAt: 0,
        configure(config) { player.configs.push(config); }, push(record) { player.records.push(record); player.lastPacketAt = player.lastLiveAt = performance.now(); if (record.type === TYPE.END) options.onState?.({ state: 'ended' }); },
        skip() {}, setActive(value) { player.active = value; }, read() { return { painted: player.records.length, lastPacketAt: player.lastPacketAt, lastLiveAt: player.lastLiveAt, liveCapable: true }; },
        stats() { return { delayMs: player.delay }; }, destroy() { player.destroyed = true; } };
      made.push(player); return player;
    },
  };
}

// A sharer and one friend, joined the way the app joins them.
function world({ playerOptions = {}, watcherOptions = {} } = {}) {
  const log = [], recorder = fakeRecorderApi(), Player = fakePlayerModule(), announced = [];
  let sender = null, watcher = null;
  const sentToFriend = [], sentToSharer = [];
  sender = Controller.createShareSender({
    source: Controller.recorderSource(recorder, { fps: 60, width: 3840, height: 2160 }),
    sendControl: (viewerId, message) => { sentToFriend.push(message); setTimeout(() => watcher?.onControl(JSON.parse(JSON.stringify(message))), 2); },
    openDataChannel: (viewerId, label) => { const pair = dataChannelPair(); setTimeout(() => watcher?.attachDataChannel(pair.b), 1); sender.lastLabel = label; return pair.a; },
    announce: offer => announced.push(offer), log: line => log.push('host: ' + line), ...playerOptions,
  });
  const makeWatcher = () => {
    watcher = Controller.createShareWatcher({
      shareId: sender.shareId, Player, Session, lanes: null, surface: {}, log: line => log.push('viewer: ' + line),
      sendControl: message => { sentToSharer.push(message); setTimeout(() => sender.onControl('friend', JSON.parse(JSON.stringify(message))), 2); },
      onEnded: () => { watcher.ended = true; }, onError: error => { watcher.error = error; }, ...watcherOptions,
    });
    return watcher;
  };
  return { sender, recorder, Player, announced, log, sentToFriend, sentToSharer, makeWatcher, get watcher() { return watcher; } };
}

(async () => {
  // 1. The whole way through: recorder -> host -> data channel -> viewer -> player. Order, keys and times arrive intact.
  {
    const w = world();
    const started = await w.sender.start();
    assert.strictEqual(started.encoder, 'NVENC'); assert.strictEqual(started.keepsUp, true);
    assert.deepStrictEqual(w.recorder.starts, [{ fps: 60, width: 3840, height: 2160 }]);
    assert.strictEqual(w.sender.offer(), null, 'an offer was made before the stream was described');
    w.recorder.emit('frame', picture(0, true));                                           // a picture before the description is not kept
    w.recorder.emit('config', CONFIG);
    assert.strictEqual(w.announced.length, 1); assert.deepStrictEqual(w.announced[0], { t: 'share-offer', shareId: w.sender.shareId, v: 2, config: CONFIG });
    assert.deepStrictEqual(w.sender.offer(), w.announced[0]);
    const watcher = w.makeWatcher();
    watcher.watch();
    await until(() => w.sender.hasViewers(), 3000, 'the viewer to be added');
    const sent = [];
    for (let i = 0; i < 90; i++) { const frame = picture(i, i % 30 === 0); sent.push(frame); w.recorder.emit('frame', frame); await sleep(2); }
    const player = w.Player.made[0];
    await until(() => player.records.filter(r => r.type === TYPE.VIDEO).length >= 90, 6000, 'every picture to arrive');
    const got = player.records.filter(r => r.type === TYPE.VIDEO);
    assert.deepStrictEqual(player.configs.map(c => c.codec), ['av01.0.13H.08']);
    for (let i = 0; i < 90; i++) { assert.strictEqual(got[i].key, sent[i].key, 'key flag ' + i); assert.strictEqual(Math.round(got[i].pts), sent[i].pts); assert(Buffer.from(got[i].payload).equals(Buffer.from(sent[i].data)), 'picture ' + i + ' arrived changed'); }
    assert.strictEqual(w.sentToSharer[0].t, 'share-watch'); assert.strictEqual(w.sentToSharer[0].shareId, w.sender.shareId);
    assert(/^knot-share-/.test(w.sender.lastLabel));
    assert.strictEqual(w.sender.stats().source, 'recorder');
    console.log('PASS 90 pictures went recorder -> host -> data channel -> viewer -> player, in order, keys and times intact');

    // 2. The picture changes size: the stream is described again, and the viewer's player is told.
    w.recorder.emit('config', { ...CONFIG, width: 1920, height: 1080 });
    w.recorder.emit('frame', picture(100, true));
    await until(() => player.configs.length === 2, 3000, 'the new description');
    assert.strictEqual(player.configs[1].width, 1920); assert.strictEqual(w.announced.length, 1, 'a resize announced the share a second time');
    await until(() => player.records.filter(r => r.type === TYPE.VIDEO).length >= 91, 3000, 'the picture after the resize');
    console.log('PASS a new picture size is described to the viewer without a second announcement');

    // 3. Messages for another share, or from nobody in particular, are ignored.
    const before = w.sender.stats().viewers.length;
    w.sender.onControl('stranger', { t: 'share-watch', shareId: 'someone-elses-share', caps: {} });
    w.sender.onControl('stranger', null);
    assert.strictEqual(w.sender.stats().viewers.length, before);

    // 4. Stopping: the source is stopped, the end reaches the viewer after what was captured, and the viewer finishes.
    await w.sender.stop({ drainMs: 3000 });
    assert.strictEqual(w.recorder.stops, 1); assert.strictEqual(w.recorder.hooks.frame.length, 0, 'the recorder\'s hooks were left behind');
    await until(() => watcher.ended === true, 4000, 'the viewer to see the end');
    assert.strictEqual(player.records.at(-1).type, TYPE.END, 'the end did not come last');
    assert.strictEqual(player.records.filter(r => r.type === TYPE.VIDEO).length, 91, 'pictures were lost before the end');
    assert.strictEqual(w.sender.offer(), null, 'an ended share still offers itself');
    watcher.stop({ notify: false }); assert(player.destroyed);
    console.log('PASS stopping stops the recorder, delivers everything captured, then the end; the viewer finishes and the offer is withdrawn');
  }

  // 5. The sharer vanishes without its end record (the app was killed): the viewer does not hang on the last picture.
  {
    // A vanished sharer sends no heartbeats either: the host's timers are switched off.
    const w = world({ watcherOptions: { endQuietMs: 300 }, playerOptions: { hostOptions: { setTimer: () => 0, clearTimer: () => {} } } });
    await w.sender.start(); w.recorder.emit('config', CONFIG);
    const watcher = w.makeWatcher(); watcher.watch();
    await until(() => w.sender.hasViewers(), 3000, 'viewer');
    for (let i = 0; i < 10; i++) w.recorder.emit('frame', picture(i, i === 0));
    await until(() => w.Player.made[0].records.length >= 10, 3000, 'pictures');
    watcher.onControl({ t: 'share-end', shareId: w.sender.shareId });                     // the control message arrives, the end record never does
    const before = Date.now();
    await until(() => watcher.ended === true, 3000, 'the quiet fallback');
    assert(Date.now() - before >= 250, 'finished before the quiet period');
    watcher.stop({ notify: false });
    console.log('PASS a share whose end record never arrives still ends for the viewer once nothing more comes');
  }

  // 6. End record arrives but the player holds a long backlog: the viewer finishes when playout is done, or at the cap.
  {
    const w = world({ watcherOptions: { endPlayoutMs: 300 } });
    await w.sender.start(); w.recorder.emit('config', CONFIG);
    const watcher = w.makeWatcher(); watcher.watch();
    await until(() => w.sender.hasViewers(), 3000, 'viewer');
    w.Player.made[0].options.onState = () => {};                                          // this player never says "ended" by itself
    const realPush = w.Player.made[0].push; w.Player.made[0].push = record => { w.Player.made[0].records.push(record); };
    w.recorder.emit('frame', picture(0, true));
    await w.sender.stop({ drainMs: 2000 });
    const before = Date.now();
    await until(() => watcher.ended === true, 3000, 'the playout cap');
    assert(Date.now() - before >= 250, 'finished before the cap');
    void realPush; watcher.stop({ notify: false });
    console.log('PASS a viewer holding a backlog at the end finishes by the playout cap');
  }

  // 7. Sources: failures surface, and nothing is delivered after stop.
  {
    const api = fakeRecorderApi({ startResult: { error: 'GPU Screen Recorder is unavailable' } });
    await assert.rejects(Controller.recorderSource(api, {}).start({ onConfig() {}, onFrame() {}, onError() {}, onEnd() {} }), /GPU Screen Recorder is unavailable/);
    assert.strictEqual(api.hooks.config.length + api.hooks.frame.length + api.hooks.error.length + api.hooks.end.length, 0, 'a failed start left hooks behind');

    const w = world(); const errors = [], ends = [];
    const sender = Controller.createShareSender({ shareId: 'abcdef123456', source: Controller.recorderSource(w.recorder, {}), sendControl() {}, openDataChannel() { return null; }, onError: e => errors.push(e.message), onEnd: () => ends.push(1) });
    await sender.start(); w.recorder.emit('config', CONFIG);
    w.recorder.emit('error', 'capture crashed'); w.recorder.emit('end');
    assert.deepStrictEqual(errors, ['capture crashed']); assert.strictEqual(ends.length, 1);
    await sender.stop({ drainMs: 0 }); w.recorder.emit('error', 'late'); w.recorder.emit('end'); w.recorder.emit('frame', picture(1, true));
    assert.deepStrictEqual(errors, ['capture crashed']); assert.strictEqual(ends.length, 1, 'events were delivered after stop');
    assert.throws(() => Controller.createShareSender({ source: {}, sendControl() {} }), /needs a source/);
    console.log('PASS a recorder that will not start fails cleanly; errors and endings are reported once and never after stop');
  }

  // 8. The page source: the encoder is chosen by what the computer can do, started once, and told to stop.
  {
    const calls = [];
    const Encoder = {
      EFFICIENCY: { av1: 1, vp9: 1.25, h264: 1.6 },
      async choose(options) { calls.push(['choose', options]); return { choice: { codec: 'h264', hardware: false, config: {} }, keepsUp: false, sustainedFps: 41.5, tried: [{ codec: 'h264', hardware: false, fps: 41.5 }] }; },
      create(options) { calls.push(['create', options.choice.codec, options.fps, options.bitrateKbps]); return { stats: () => ({ encoded: 1, dropped: 0 }), start: () => { calls.push(['start']); options.onConfig({ ...CONFIG, codec: 'avc1.640034' }); options.onFrame(picture(0, true)); return new Promise(() => {}); }, stop: async () => { calls.push(['stop']); } }; },
    };
    const track = { listeners: [], addEventListener(type, fn) { this.listeners.push([type, fn]); }, removeEventListener(type, fn) { this.listeners = this.listeners.filter(l => l[1] !== fn); } };
    const source = Controller.pageSource({ Encoder, track, width: 1920, height: 1080, fps: 60, av1Kbps: 10000 });
    const records = [];
    const sender = Controller.createShareSender({ shareId: 'abcdef123457', source, sendControl() {}, openDataChannel() { return null; }, hostOptions: {} });
    const info = await sender.start();
    assert.deepStrictEqual([info.encoder, info.hardware, info.keepsUp, info.sustainedFps], ['software H264', false, false, 41.5], 'the sharer is not told what the encoder can sustain');
    assert.strictEqual(sender.config.codec, 'avc1.640034'); assert.strictEqual(sender.stats().nextSeq, 1); assert.deepStrictEqual(sender.stats().capture, { encoded: 1, dropped: 0 }, 'the encoder\'s own numbers are not in the share stats');
    assert.deepStrictEqual(calls.map(c => c[0]), ['choose', 'create', 'start']);
    assert.strictEqual(calls[0][1].bitrateKbps, 10000, 'the benchmark ran at a different rate than the share');
    assert.strictEqual(calls[1][3], 16000, 'H.264 was not given 1.6x the AV1 rate'); assert.strictEqual(info.bitrateKbps, 16000);
    assert.strictEqual(await sender.start(), info, 'start ran twice'); assert.strictEqual(calls.filter(c => c[0] === 'start').length, 1);
    await sender.stop({ drainMs: 0 });
    assert.strictEqual(calls.at(-1)[0], 'stop'); assert.strictEqual(track.listeners.length, 0, 'the ended listener was left on the track');
    const dead = Controller.pageSource({ Encoder: { choose: async () => ({ choice: null, tried: [] }) }, track, width: 1, height: 1 });
    await assert.rejects(dead.start({}), /cannot encode video/);
    void records;
    console.log('PASS the in-page source reports what the encoder can sustain, starts once, and releases the track');
  }

  // 8b. The offer is repeated while sharing, so a friend who joins later (or reconnects) finds it; it stops with the share.
  {
    const w = world({ playerOptions: { reannounceMs: 40 } });
    await w.sender.start(); w.recorder.emit('config', CONFIG);
    await until(() => w.announced.length >= 4, 3000, 'repeated offers');
    assert(w.announced.every(offer => offer.shareId === w.sender.shareId && offer.config.codec === CONFIG.codec), 'a repeated offer differs from the first');
    w.recorder.emit('config', { ...CONFIG, width: 1920, height: 1080 });
    await until(() => w.announced.at(-1).config.width === 1920, 1000, 'the new size in the next offer');
    await w.sender.stop({ drainMs: 0 });
    const count = w.announced.length; await sleep(200);
    assert.strictEqual(w.announced.length, count, 'offers kept coming after stop');
    console.log('PASS the offer is repeated while sharing (with the current size) and stops with the share');
  }

  // 8c. The line under a friend's share tells what arrives, what is shown, what decodes it, and whose end a problem is on.
  {
    const config = { codec: 'av01.0.13H.08', width: 3840, height: 2160, fps: 60 };
    const say = o => Controller.describeShare({ config, ...o });
    assert.strictEqual(say({ receivedFps: 59.6, shownFps: 59.2, mbps: 16.04 }), 'Friend sharing · 2160p · 60 fps · 16 Mbps · AV1 on GPU');
    assert.strictEqual(say({ receivedFps: 30, shownFps: 30, mbps: 4.25, software: true }), 'Friend sharing · 2160p · 30 fps · 4.3 Mbps · AV1 on CPU');
    assert(/only 20 fps shown · this computer is falling behind/.test(say({ receivedFps: 60, shownFps: 20, mbps: 16 })), 'a slow viewer is not told it is the one falling behind');
    assert(!/falling behind/.test(say({ receivedFps: 60, shownFps: 58, mbps: 16 })));
    assert(/still screen/.test(say({ receivedFps: 0, shownFps: 0, stillScreen: true })) && !/nothing arriving|falling behind/.test(say({ receivedFps: 0, shownFps: 0, stillScreen: true })), 'a quiet screen is reported as a problem');
    assert(/nothing arriving from your friend’s connection/.test(say({ receivedFps: 0, quietMs: 2500 })), 'a dead link is not blamed on the friend’s connection');
    assert(/ · buffering$/.test(say({ receivedFps: 40, shownFps: 40, mbps: 5, buffering: true })));
    assert.strictEqual(Controller.describeShare({ receivedFps: 12, shownFps: 12, config: { codec: 'avc1.640034', width: 1280, height: 720 } }), 'Friend sharing · 720p · 12 fps · H.264 on GPU');
    // the watcher measures the rates itself, from the player's and the viewer's counters
    let clock = 10000; const counters = { received: 0, painted: 0 }, player = { configure() {}, push() {}, skip() {}, setActive() {}, destroy() {}, read: () => ({ lastPacketAt: clock - 20, lastLiveAt: clock - 20 }), stats: () => ({ delayMs: 250, received: counters.received, painted: counters.painted, decoder: 'software', buffering: false }) };
    const w = Controller.createShareWatcher({ shareId: 'abcdef123458', Player: { createSharePlayer: () => player }, Session, now: () => clock, sendControl() {} });
    w.viewer.receiver.bytes = 0;
    w.readout({ config });                                    // first call only takes a sample
    clock += 2000; counters.received = 120; counters.painted = 118; w.viewer.receiver.bytes = 2 * 1024 * 1024;
    const line = w.readout({ config });
    assert.strictEqual(line, 'Friend sharing · 2160p · 60 fps · 8.4 Mbps · AV1 on CPU', 'the watcher measured the wrong rates: ' + line);
    w.stop({ notify: false });
    console.log('PASS the status line under a share says what arrives, what is shown, what decodes it, and whose end a problem is on');
  }

  // 9. The sound follows the picture.
  {
    assert.strictEqual(Controller.audioTargetMs(0), 120, 'below the floor that stops sound choking');
    assert.strictEqual(Controller.audioTargetMs(250), 290); assert.strictEqual(Controller.audioTargetMs(900), 940);
    assert.strictEqual(Controller.audioTargetMs(10000), 4000, 'above what the browser accepts');
    assert.strictEqual(Controller.audioTargetMs(NaN), 120);
    let delay = 250; const withTarget = { jitterBufferTarget: 0 }, other = { jitterBufferTarget: 0 }, noProperty = {}, timers = [];
    const align = Controller.createAudioAlign({ getReceivers: () => [withTarget, other, noProperty, null], getDelayMs: () => delay, setTimer: fn => { timers.push(fn); return timers.length; }, clearTimer() {} });
    align.start(); assert.strictEqual(withTarget.jitterBufferTarget, 290); assert.strictEqual(other.jitterBufferTarget, 290); assert('jitterBufferTarget' in noProperty === false);
    delay = 260; timers[0](); assert.strictEqual(withTarget.jitterBufferTarget, 290, 'a ten millisecond drift moved the sound');
    delay = 600; timers[0](); assert.strictEqual(withTarget.jitterBufferTarget, 640);
    delay = 20; timers[0](); assert.strictEqual(withTarget.jitterBufferTarget, 120);
    const fresh = { jitterBufferTarget: 0 }; const late = Controller.createAudioAlign({ getReceivers: () => [fresh], getDelayMs: () => 100 }); late.apply(); assert.strictEqual(fresh.jitterBufferTarget, 140, 'a receiver that appeared late was not set');
    console.log('PASS sound is held back by the picture\'s delay, never below the choke floor or above the browser limit, and only moves when the delay really does');
  }
  process.exit(0);
})().catch(error => { console.error(error); process.exit(1); });
