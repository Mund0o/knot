'use strict';

// What the person sharing is told about their sound, in the real page: a capture that cannot start says why (it used to leave "starting sound
// capture" on the screen for good while the viewer received a silent track that looked like sound), and a capture that runs but hears nothing
// says so until something plays. Offscreen, with the capture functions replaced: no real sound device is touched.
const path = require('path');
const { app, BrowserWindow } = require('electron');

app.commandLine.appendSwitch('autoplay-policy', 'no-user-gesture-required');
const fail = error => { console.error('share sound status test failed:', error?.stack || error); app.exit(1); };

app.whenReady().then(async () => {
  const window = new BrowserWindow({ show: false, width: 1000, height: 700, webPreferences: { contextIsolation: true, nodeIntegration: false, offscreen: true } });
  try {
    await window.loadFile(path.join(__dirname, '..', 'index.html'), { query: { testMode: '1' } });
    await new Promise(resolve => setTimeout(resolve, 300));
    const result = await window.webContents.executeJavaScript(`(async () => {
      const assert = (condition, message) => { if (!condition) throw new Error(message); };
      const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));
      const saved = { linux: linuxShareAudioTrack, win: setupNativeScreenCapture, send, active: screenActive, audioOn: screenAudioOn, status: screenStatus.textContent, debug: screenAudioDebug, now: Date.now,
        pc, transceiver: screenAudioTransceiver, remoteAudio: nativeRemoteAudio, expected: remoteScreenExpected, announced: remoteShareSoundAnnounced, setInterval: window.setInterval };
      const sent = [];
      try {
        // ---- capture cannot start
        send = message => { sent.push(message); return true; };
        const failing = async () => { shareAudioFailureReason = 'Addon not built: no pair-capture.node'; return null; };
        linuxShareAudioTrack = failing; setupNativeScreenCapture = failing;
        screenActive = true; screenAudioOn = true; screenGen++; screenAudioDebug = ' · starting sound capture';
        await attachNativeShareAudio(screenGen);
        assert(screenAudioDebug === ' · sound unavailable (Addon not built: no pair-capture.node)', 'the sharer is not told why sound could not start: ' + screenAudioDebug);
        assert(sent.some(message => message.t === 'screen-audio' && message.active === false), 'the viewer is not told there is no sound: ' + JSON.stringify(sent));
        assert(screenStatus.textContent.includes('sound unavailable (Addon not built'), 'the status line does not carry the reason: ' + screenStatus.textContent);

        // ---- capture runs, hears nothing, then something plays
        let loudAt = 0; const track = { _knotShareAudioHeard: () => true, _knotShareAudioLoudAt: () => loudAt };      // like the capture's own: a closure over a value that changes
        screenAudioDebug = ' · waiting for computer sound';
        let wanted = true; watchShareAudioLevel(track, () => wanted);
        await sleep(1300);
        assert(screenAudioDebug === ' · sound live', 'sound capture that began after the share is still "waiting": ' + screenAudioDebug);
        const realNow = Date.now.bind(Date); const shift = 9000; Date.now = () => realNow() + shift;
        await sleep(1300);
        assert(screenAudioDebug === ' · sound on, but nothing is playing on this computer', 'a capture that hears nothing is called live: ' + screenAudioDebug);
        loudAt = Date.now();
        await sleep(1300);
        assert(screenAudioDebug === ' · sound live', 'sound that plays again is still called nothing: ' + screenAudioDebug);
        // a track without a level (the Linux capture) is left alone
        const before = screenAudioDebug; watchShareAudioLevel({ _knotShareAudioHeard: () => true }, () => wanted); await sleep(1200);
        assert(screenAudioDebug === before, 'a capture without a level was changed: ' + screenAudioDebug);
        wanted = false; await sleep(1200);
        Date.now = saved.now;

        // ---- the viewer's sound line, from the real monitor against a fake receiver (it looks every 2.5 s; here every 0.1 s, and the clock moves 2.5 s a look)
        const fakeTrack = { kind: 'audio', readyState: 'live' };
        let packets = 0, energy = 0, loud = false, clock = 1e12;
        const receiver = { track: fakeTrack, getStats: async () => { packets += 60; if (loud) energy += 1; clock += 2500; return new Map([['a', { type: 'inbound-rtp', kind: 'audio', packetsReceived: packets, totalAudioEnergy: energy }]]); } };
        pc = { getReceivers: () => [receiver] }; screenAudioTransceiver = { receiver };
        nativeRemoteAudio = { paused: false, muted: false, volume: 1, srcObject: null, play() {}, pause() {} };
        remoteScreenExpected = true; screenAudioDebug = '';
        const realSetInterval = window.setInterval.bind(window); window.setInterval = (fn, ms) => realSetInterval(fn, ms >= 2000 ? 100 : ms);
        Date.now = () => clock;
        const until = async (label, test) => { for (let i = 0; i < 60; i++) { if (test(screenAudioDebug)) return; await sleep(100); } throw new Error(label + ': ' + screenAudioDebug); };
        const seen = [];
        remoteShareSoundAnnounced = false; startRemoteShareAudioMonitor();
        await until('a share without sound is not told apart from silence', text => /your friend is not sharing sound/.test(text)); seen.push(screenAudioDebug);
        remoteShareSoundAnnounced = true;
        await until('sound that was announced is not called silent after a while', text => /your friend’s sound is silent/.test(text)); seen.push(screenAudioDebug);
        loud = true;
        await until('sound that is heard is not called playing', text => text === ' · sound playing'); seen.push(screenAudioDebug);
        stopRemoteShareAudioMonitor();
        return { unavailable: sent.length, seen };
      } finally {
        stopRemoteShareAudioMonitor(); window.setInterval = saved.setInterval; pc = saved.pc; screenAudioTransceiver = saved.transceiver; nativeRemoteAudio = saved.remoteAudio; remoteScreenExpected = saved.expected; remoteShareSoundAnnounced = saved.announced;
        Date.now = saved.now; linuxShareAudioTrack = saved.linux; setupNativeScreenCapture = saved.win; send = saved.send; screenActive = saved.active; screenAudioOn = saved.audioOn;
        screenStatus.textContent = saved.status; screenAudioDebug = saved.debug;
      }
    })()`);
    console.log('PASS the sharer is told why sound could not start and when nothing is playing, and the viewer is told whose end the silence is on', JSON.stringify(result));
    app.exit(0);
  } catch (error) { fail(error); }
});
