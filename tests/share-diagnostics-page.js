'use strict';

// The lines the real page writes into the share log while it shows or shares a screen: what they say, that nothing is written when no share is on,
// and that a share whose numbers are missing cannot break the page. The log's own file, limits and process lines are tests/share-diagnostics.js.
const path = require('path');
const { app, BrowserWindow } = require('electron');

app.commandLine.appendSwitch('autoplay-policy', 'no-user-gesture-required');
const fail = error => { console.error('share diagnostics page test failed:', error?.stack || error); app.exit(1); };

app.whenReady().then(async () => {
  const window = new BrowserWindow({ show: false, width: 1000, height: 700, webPreferences: { contextIsolation: true, nodeIntegration: false, offscreen: true } });
  try {
    await window.loadFile(path.join(__dirname, '..', 'index.html'), { query: { testMode: '1' } });
    // the page's own start-up ends shares and watchers it finds; let it finish first
    await new Promise(resolve => setTimeout(resolve, 2500));
    const result = await window.webContents.executeJavaScript(`(async () => {
      const assert = (condition, message) => { if (!condition) throw new Error(message); };
      const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));
      const lines = []; const saved = { watch: dmWatch, share: dmShare, offer: dmShareOffer, pair: window.pairShareDiag, debug: screenAudioDebug };
      try {
        window.pairShareDiag = { record: text => (lines.push(text), true) };
        // nothing is written when no share is on
        dmWatch = null; dmShare = null; recordShareDiagnostics();
        assert(!lines.length, 'a line was written with no share on: ' + lines.join(' | '));

        // watching a friend's share
        dmShareOffer = { config: { codec: 'av01.0.13H.08', width: 3840, height: 2160, fps: 60 } };
        dmWatch = { rates: { receivedFps: 59.6, shownFps: 19.2, tickFps: 20.1, decodedFps: 58.9, mbps: 41.37 },
          stats: () => ({ player: { width: 3840, height: 2160, delayMs: 160, depthMs: 180, pending: 3, stalls: 1, jumps: 0, skippedShown: 7, lastState: 'live', decoder: 'hardware-preferred', decodeMode: 'throughput', frameFormat: 'I420', drawMsP95: 12.34 }, viewer: { udx: true, duplicates: 2, pending: 5 } }) };
        screenAudioDebug = ' · your friend is not sharing sound (their sound is off, or it could not start)';
        recordShareDiagnostics();
        assert(lines.length === 1, 'expected one viewer line, got ' + lines.length);
        const viewer = lines[0];
        for (const part of ['viewer AV1 3840x2160', 'recv=60', 'shown=19', 'redraw=20', 'decoded=59', 'mbps=41.4', 'delay=160', 'pending=3', 'stalls=1', 'skipped=7', 'state=live', 'decoder=hardware-preferred/throughput/I420', 'draw95=12.3ms', 'udx=1', 'dup=2', 'wait=5', 'sound=your friend is not sharing sound', 'hidden=']) assert(viewer.includes(part), 'the viewer line lacks "' + part + '": ' + viewer);
        assert(/ blocked=\\d+x\\/\\d+ms hidden=[01]$/.test(viewer), 'the viewer line does not end with how long the page was blocked: ' + viewer);      // a number: the page may really have been busy
        assert(viewer.length < 700, 'the viewer line is ' + viewer.length + ' characters');

        // sharing, with numbers that change between lines
        lines.length = 0; dmWatch = null;
        let encoded = 1000;
        dmShare = { stats: () => ({ source: 'page', capture: { codec: 'avc1.64002a', width: 1920, height: 1080, encoded, kbps: 19000, dropped: 4, queued: 2 }, viewers: [{ lane: 'udx', behind: 3, resent: 5, sentBytes: 52428800 }] }) };
        screenAudioDebug = ' · sound live';
        recordShareDiagnostics(); encoded += 58; await sleep(1000); recordShareDiagnostics();       // (the page's own one-second timer may add a line of its own between these)
        assert(lines.length >= 2, 'expected sharer lines, got ' + lines.length);
        for (const sharer of lines) for (const part of ['sharer src=page avc1.64002a 1920x1080', 'kbps=19000', 'dropped=4', 'queued=2', 'viewers=[udx:behind3:lag0ms:resent5:skips0:50MB]', 'sound=sound live']) assert(sharer.includes(part), 'the sharer line lacks "' + part + '": ' + sharer);
        assert(lines.some(line => /encoded=[1-9]\\d*\\/s/.test(line)), 'no sharer line reports the pictures encoded in the second: ' + lines.join(' | '));
        const sharer = lines.at(-1);

        // a viewer that is seconds behind: the sharer's own line says so, and stops saying so when it catches up
        const lagging = { lagMs: 7400 }; dmShare = { stats: () => ({ source: 'page', viewers: [{ lane: 'udx', behind: 400, resent: 0, sentBytes: 1, lagMs: lagging.lagMs }] }) };
        const wasActive = screenActive, wasInfo = dmShareInfo; screenActive = true; dmShareInfo = { encoder: 'test', config: null };
        updateShareLagNote();
        assert(/ · your friend is 7\\.4 s behind: the connection cannot carry this bitrate/.test(screenStatus.textContent), 'the sharer is not told the viewer is behind: ' + screenStatus.textContent);
        dmShare = { stats: () => ({ source: 'page', viewers: [{ lane: 'dc', behind: 400, resent: 0, sentBytes: 1, lagMs: 9000 }] }) }; updateShareLagNote();
        assert(/9\\.0 s behind: the connection cannot carry this bitrate \\(they are on the slow data-channel route/.test(screenStatus.textContent), 'the sharer is not told the viewer is on the data channel: ' + screenStatus.textContent);
        dmShare = { stats: () => ({ source: 'page', viewers: [{ lane: 'udx', behind: 400, resent: 0, sentBytes: 1, lagMs: lagging.lagMs }] }) };
        lagging.lagMs = 300; updateShareLagNote();
        assert(!/behind/.test(screenStatus.textContent), 'the sharer is still told the viewer is behind: ' + screenStatus.textContent);
        screenActive = wasActive; dmShareInfo = wasInfo;

        // both at once (watching one friend while sharing to another cannot happen in a DM, but a missing number must never throw)
        lines.length = 0; dmWatch = { stats: () => ({}), rates: undefined }; dmShare = { stats: () => ({}) };
        recordShareDiagnostics();
        assert(lines.length === 2 && lines.every(line => /^(viewer|sharer) /.test(line)), 'missing numbers broke the lines: ' + JSON.stringify(lines));
        dmWatch = { stats: () => { throw new Error('boom'); } }; dmShare = null; lines.length = 0;
        recordShareDiagnostics();
        assert(lines.length === 1 && /log error boom/.test(lines[0]), 'a failing stats call was not reported as a line: ' + JSON.stringify(lines));

        // without the bridge (an older shell) the page does nothing
        window.pairShareDiag = undefined; lines.length = 0; recordShareDiagnostics();
        return { viewer, sharer };
      } finally { dmWatch = saved.watch; dmShare = saved.share; dmShareOffer = saved.offer; window.pairShareDiag = saved.pair; screenAudioDebug = saved.debug; }
    })()`);
    console.log('PASS the page writes one short, numbers-only line a second for a share it watches or sends', JSON.stringify(result).slice(0, 700));
    app.exit(0);
  } catch (error) { fail(error); }
});
