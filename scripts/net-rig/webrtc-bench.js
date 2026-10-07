// Electron main: ROLE=offer|answer SIGDIR=... SECS=14 CONNS=1 ; measures RTCDataChannel goodput (reliable, ordered)
const { app, BrowserWindow } = require('electron');
app.commandLine.appendSwitch('no-sandbox');
app.commandLine.appendSwitch('disable-features', 'WebRtcHideLocalIpsWithMdns');
app.commandLine.appendSwitch('force-webrtc-ip-handling-policy', 'default_public_and_private_interfaces');
app.disableHardwareAcceleration();
app.whenReady().then(async () => {
  const win = new BrowserWindow({ show: false, webPreferences: { offscreen: true, contextIsolation: false, nodeIntegration: true } });
  await win.loadURL('data:text/html,<html></html>');
  const out = await win.webContents.executeJavaScript(`(async () => {
    const fs = require('fs'), role = process.env.ROLE, dir = process.env.SIGDIR, secs = +process.env.SECS || 14, conns = +process.env.CONNS || 1;
    const sleep = ms => new Promise(r => setTimeout(r, ms));
    const waitIce = pc => new Promise(res => { if (pc.iceGatheringState === 'complete') return res(); pc.addEventListener('icegatheringstatechange', () => pc.iceGatheringState === 'complete' && res()); setTimeout(res, 4000) });
    const waitFile = async f => { for (let i = 0; i < 600; i++) { if (fs.existsSync(f)) { await sleep(50); return JSON.parse(fs.readFileSync(f, 'utf8')) } await sleep(100) } throw new Error('no ' + f) };
    let t0 = 0; const perSec = []; let total = 0, opened = 0;
    const CHUNK = 64 * 1024, HIGH = 16 * 1024 * 1024, LOW = 4 * 1024 * 1024;
    const chans = [];
    for (let i = 0; i < conns; i++) {
      const pc = new RTCPeerConnection({ iceServers: [] });
      if (role === 'offer') {
        const dc = pc.createDataChannel('f' + i, { ordered: true }); dc.binaryType = 'arraybuffer'; dc.bufferedAmountLowThreshold = LOW; chans.push(dc);
        await pc.setLocalDescription(await pc.createOffer()); await waitIce(pc);
        fs.writeFileSync(dir + '/offer' + i + '.json', JSON.stringify(pc.localDescription));
        await pc.setRemoteDescription(await waitFile(dir + '/answer' + i + '.json'));
      } else {
        pc.ondatachannel = e => { const dc = e.channel; dc.binaryType = 'arraybuffer'; chans.push(dc); dc.onmessage = m => { if (!t0) t0 = Date.now(); const n = m.data.byteLength; total += n; const s = Math.floor((Date.now() - t0) / 1000); perSec[s] = (perSec[s] || 0) + n } };
        await pc.setRemoteDescription(await waitFile(dir + '/offer' + i + '.json'));
        await pc.setLocalDescription(await pc.createAnswer()); await waitIce(pc);
        fs.writeFileSync(dir + '/answer' + i + '.json', JSON.stringify(pc.localDescription));
      }
    }
    if (role === 'offer') {
      const chunk = new Uint8Array(CHUNK);
      await Promise.all(chans.map(dc => new Promise(res => { let start = 0; const go = () => { while (Date.now() - start < secs * 1000 && dc.bufferedAmount < HIGH) dc.send(chunk); if (Date.now() - start >= secs * 1000) return res(); };
        const begin = () => { start = Date.now(); dc.onbufferedamountlow = go; go(); setInterval(go, 50) }; dc.readyState === 'open' ? begin() : dc.onopen = begin })));
      await sleep(3000); return JSON.stringify({ role: 'offer', done: true });
    }
    for (let i = 0; i < 600; i++) { await sleep(100); if (t0 && Date.now() - t0 > (secs + 1.5) * 1000) break; if (!t0 && i > 300) break }
    const from = 4, to = secs; let bytes = 0; for (let s = from; s < to; s++) bytes += perSec[s] || 0;
    return JSON.stringify({ proto: 'webrtc', conns, steadyMbit: +(bytes * 8 / (to - from) / 1e6).toFixed(2), totalMiB: +(total / 1048576).toFixed(1) });
  })()`);
  console.log('RESULT ' + out); app.exit(0);
}).catch(e => { console.log('RESULT ' + JSON.stringify({ error: String(e) })); app.exit(1) });
