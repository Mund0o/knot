// usage: node lane-bench.js <A|B> <stunIp> <secs> ; A sends, B receives. Signaling through the RIG_SIG directory.
const fs = require('fs'), crypto = require('crypto');
const P = require('path').join(__dirname, '..', '..') + '/';
const { UdxLanes } = require(P + 'udx-lane'); const { DirectFileHost, connect } = require(P + 'direct-file');
const [role, stunIp, secsArg] = process.argv.slice(2); const secs = Number(secsArg || 12), dir = process.env.RIG_SIG || '/tmp/knot-net-rig/sig';
const sleep = ms => new Promise(r => setTimeout(r, ms));
const waitFile = async f => { for (let i = 0; i < 300; i++) { if (fs.existsSync(f)) { await sleep(50); return JSON.parse(fs.readFileSync(f, 'utf8')) } await sleep(100) } throw new Error('no ' + f) };
(async () => {
  const lanes = new UdxLanes({ stunServers: stunIp === 'none' ? [] : [[stunIp, 3478]], punchWindowMs: 8000, lowTtls: process.env.LOWTTL ? JSON.parse(process.env.LOWTTL) : undefined, holdMs: process.env.HOLD ? Number(process.env.HOLD) : undefined, debug: process.env.DBG ? m => console.log(role, m) : null });
  const local = await lanes.open();
  const announce = () => fs.writeFileSync(`${dir}/${role}.json`, JSON.stringify(local));
  if (!(process.env.COORD && role === 'B')) announce();               // coordinated: the receiver announces only after it has started
  const remote = await waitFile(`${dir}/${role === 'A' ? 'B' : 'A'}.json`);
  const shared = JSON.parse(fs.readFileSync(`${dir}/secret.json`, 'utf8')), key = Buffer.from(shared.key, 'hex'), token = shared.token;
  if (role === 'A' && process.env.SKEW) await sleep(Number(process.env.SKEW));   // the sender starts late, after the receiver
  const t0 = Date.now();
  let socket;
  try {
    if (process.env.COORD) {
      // coordinated: B (receiver) starts first and holds; A (sender) starts, releases at once, then says it is armed
      if (role === 'B') { const p = lanes.establish(local.id, { token, remote, holdMs: 30000 }); announce(); (async () => { await waitFile(dir + '/armed.json'); lanes.release(local.id) })(); socket = await p }
      else { const p = lanes.establish(local.id, { token, remote, holdMs: 0 }); fs.writeFileSync(dir + '/armed.json', '{}'); socket = await p }
    } else socket = await lanes.establish(local.id, { token, remote });
  }
  catch (e) { console.log(JSON.stringify({ role, error: 'punch failed: ' + e.message, local: local.endpoints.map(x => x.kind + ' ' + x.ip + ':' + x.port) })); process.exit(0) }
  const punchMs = Date.now() - t0;
  const MiB = 1 << 20;
  if (role === 'A') {
    const peer = await connect(null, null, token, key, { socket, timeout: 8000 });
    const chunk = crypto.randomBytes(MiB), end = Date.now() + secs * 1000;
    while (Date.now() < end) await peer.sendAsync(chunk);
    await sleep(2500); console.log(JSON.stringify({ role, punchMs, sent: true })); process.exit(0);
  } else {
    const host = new DirectFileHost(0); const per = []; let first = 0, total = 0;
    host.register(token, key, peer => { peer.onFrame = f => { if (!first) first = Date.now(); total += f.length; const s = Math.floor((Date.now() - first) / 1000); per[s] = (per[s] || 0) + f.length; peer.credit(f.length) } });
    host.acceptStream(socket);
    await sleep((secs + 5) * 1000);
    let bytes = 0; const from = 3, to = secs; for (let s = from; s < to; s++) bytes += per[s] || 0;
    console.log(JSON.stringify({ role, punchMs, peerEndpoint: socket.remoteAddress, steadyMbit: +(bytes * 8 / (to - from) / 1e6).toFixed(1), totalMiB: +(total / MiB).toFixed(1) })); process.exit(0);
  }
})().catch(e => { console.log(JSON.stringify({ role, error: String(e && e.message || e) })); process.exit(1) });
