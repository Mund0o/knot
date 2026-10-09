'use strict';

// A viewer that keeps falling behind tells the sharer what its link really delivers, and the sharer sizes the NEXT share to it. (The report was dead
// code after the share engine was rebuilt: nothing ever set `networkReceiveCongested`, so the sharer sized a share from speed tests alone, which measure
// two computers' connections and not the path between them.) In the real page: the detector on a simulated clock, then the sharer's bitrate with and
// without a congested friend, then the sharer's own line.
const path = require('path');
const { app, BrowserWindow } = require('electron');

app.commandLine.appendSwitch('autoplay-policy', 'no-user-gesture-required');
const fail = error => { console.error('share congestion test failed:', error?.stack || error); app.exit(1); };

app.whenReady().then(async () => {
  const window = new BrowserWindow({ show: false, width: 1000, height: 700, webPreferences: { contextIsolation: true, nodeIntegration: false, offscreen: true } });
  try {
    await window.loadFile(path.join(__dirname, '..', 'index.html'), { query: { testMode: '1' } });
    await new Promise(resolve => setTimeout(resolve, 2500));
    const result = await window.webContents.executeJavaScript(`(async () => {
      const assert = (condition, message) => { if (!condition) throw new Error(message); };
      const saved = { congested: networkReceiveCongested, live: networkLiveReceiveMbps, announce: announceNetBudget, explicit: screenBitrateExplicit, slider: screenBitrateMbps, budgets: new Map(peerNetBudgets), capacity: networkCapacity };
      let announced = 0; const out = {};
      try {
        announceNetBudget = () => { announced++; };
        networkReceiveCongested = false; networkLiveReceiveMbps = NaN; resetReceiveCongestion();
        let t = 1e12; const watcher = { rates: { mbps: 40 }, delayMs: 160 };
        const tick = (mbps, delayMs, count = 1) => { for (let i = 0; i < count; i++) { watcher.rates = { mbps }; watcher.delayMs = delayMs; t += 1000; updateReceiveCongestion(watcher, t); } };

        // 1. a healthy share is never reported
        tick(40, 160, 30);
        assert(!networkReceiveCongested && announced === 0, 'a healthy share was reported as congested');

        // 2. sitting 2.5 s behind live is not enough for a moment, then it is: the median rate is announced
        tick(12, 2500, 3); assert(!networkReceiveCongested, 'reported after 3 seconds');
        tick(12, 2500, 3);
        assert(networkReceiveCongested && networkLiveReceiveMbps === 12 && announced === 1, 'a viewer 2.5 s behind for 6 s was not reported: ' + [networkReceiveCongested, networkLiveReceiveMbps, announced]);
        out.reported = networkLiveReceiveMbps;

        // 3. the report follows the rate while it lasts (a change of more than a quarter), and not for small changes
        tick(13, 2500, 3); assert(announced === 1, 'a small change was announced again');
        tick(20, 2500, 12); assert(networkLiveReceiveMbps === 20 && announced === 2, 'a changed rate was not announced: ' + [networkLiveReceiveMbps, announced]);

        // 4. twenty calm seconds end it
        tick(40, 160, 19); assert(networkReceiveCongested, 'ended before twenty calm seconds');
        tick(40, 160, 2); assert(!networkReceiveCongested && Number.isNaN(networkLiveReceiveMbps) && announced === 3, 'twenty calm seconds did not end the report');

        // 5. the sender moving this viewer up because it was 6 s behind is reported at once (once there are a few readings); other gaps are not
        resetReceiveCongestion(); announced = 0; tick(14, 160, 5);
        noteShareGap({ reason: 'rejoined' }); tick(14, 160, 2); assert(!networkReceiveCongested, 'a rejoin was taken for congestion');
        noteShareGap({ reason: 'behind' }); tick(14, 160, 1);
        assert(networkReceiveCongested && networkLiveReceiveMbps === 14, 'a viewer moved up for being behind was not reported: ' + [networkReceiveCongested, networkLiveReceiveMbps]);
        out.afterGap = networkLiveReceiveMbps;

        // 6. the sharer sizes the next share to what its friend receives: an explicit 200 Mbps is held to 92% of it, an uncongested friend leaves it alone
        screenBitrateExplicit = true; screenBitrateMbps = 200; networkCapacity = null;
        const key = directBudgetKey();
        peerNetBudgets.set(key, networkMath().normalizeNetBudget({ downloadMbps: 900, liveMbps: 14, congested: true }));
        const congestedKbps = targetNativeAv1BitrateKbps(3840, 2160, 60);
        peerNetBudgets.set(key, networkMath().normalizeNetBudget({ downloadMbps: 900, liveMbps: 14, congested: false }));
        const freeKbps = targetNativeAv1BitrateKbps(3840, 2160, 60);
        assert(congestedKbps > 11000 && congestedKbps <= 12880, 'an explicit 200 Mbps to a friend receiving 14 was sized ' + congestedKbps + ' kbps, not about 12880');
        assert(freeKbps > 100000, 'a friend that is not congested lowered an explicit bitrate to ' + freeKbps);
        out.kbps = { congested: congestedKbps, free: freeKbps };

        // 6b. a low reading of the connection never rewrites what the person chose: the slider shows the limit, the saved choice and the variable stay
        // (the settings page's own slider when it exists, a stand-in when it does not)
        const made = [], element = (tag, id, setup) => { let item = document.getElementById(id); if (!item) { item = document.createElement(tag); item.id = id; setup?.(item); document.body.append(item); made.push(item); } return item; };
        const slider = element('input', 'screenBitrateSetting', item => { item.type = 'range'; item.min = '2'; item.max = '200'; item.value = '200'; });
        const label = element('span', 'screenBitrateValue'); const hint = element('div', 'screenBitrateCapHint');
        const kept = { max: slider.max, value: slider.value, label: label.textContent };
        slider.max = '200'; slider.value = '200';
        const writes = []; const realSsSet = ssSet; ssSet = (key, value) => { writes.push([key, value]); return realSsSet(key, value); };
        try {
          screenBitrateMbps = 200; screenBitrateExplicit = true; networkCapacity = { uploadMbps: 40, downloadMbps: 900, probeVersion: networkMath().PROBE_VERSION, at: Date.now() };
          syncScreenBitrateSlider();
          assert(Number(slider.max) < 40 && Number(slider.value) === Number(slider.max), 'the slider was not held to the measured path: max ' + slider.max + ' value ' + slider.value);
          assert(screenBitrateMbps === 200, 'a low reading of the connection rewrote the chosen bitrate to ' + screenBitrateMbps);
          assert(!writes.some(([key]) => key === 'screenBitrate'), 'a low reading of the connection was saved over the chosen bitrate: ' + JSON.stringify(writes));
          assert(/\\(you chose 200\\)/.test(label.textContent), 'the slider does not say what was chosen: ' + label.textContent);
          networkCapacity = { uploadMbps: 900, downloadMbps: 900, probeVersion: networkMath().PROBE_VERSION, at: Date.now() };
          syncScreenBitrateSlider(); assert(Number(slider.value) === 200 && !/you chose/.test(label.textContent), 'the chosen 200 Mbps did not come back when the connection measured faster: ' + slider.value + ' ' + label.textContent);
        } finally { ssSet = realSsSet; for (const item of made) item.remove(); slider.max = kept.max; slider.value = kept.value; label.textContent = kept.label; }

        // 7. the sharer's own line says what the friend receives
        peerNetBudgets.set(key, networkMath().normalizeNetBudget({ downloadMbps: 900, liveMbps: 14, congested: true }));
        const wasShare = dmShare, wasActive = screenActive, wasInfo = dmShareInfo;
        dmShare = { stats: () => ({ viewers: [{ lane: 'udx', lagMs: 8000 }] }) }; screenActive = true; dmShareInfo = { encoder: 'test', config: null };
        updateShareLagNote();
        assert(/ 8\\.0 s behind: the connection cannot carry this bitrate.* · they are receiving about 14 Mbps; the next share you start is sized to that/.test(screenStatus.textContent), 'the sharer is not told what the friend receives: ' + screenStatus.textContent);
        dmShare = wasShare; screenActive = wasActive; dmShareInfo = wasInfo; updateShareLagNote();
        return out;
      } finally {
        announceNetBudget = saved.announce; networkReceiveCongested = saved.congested; networkLiveReceiveMbps = saved.live; screenBitrateExplicit = saved.explicit; screenBitrateMbps = saved.slider; networkCapacity = saved.capacity;
        peerNetBudgets.clear(); for (const [k, v] of saved.budgets) peerNetBudgets.set(k, v); resetReceiveCongestion();
      }
    })()`);
    console.log('PASS a viewer that keeps falling behind tells the sharer what it receives, and the next share is sized to it', JSON.stringify(result));
    app.exit(0);
  } catch (error) { fail(error); }
});
