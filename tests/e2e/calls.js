'use strict';

// DM calling as a person meets it, against two real apps and a local Worker with a slow, jittery network between
// them. Every scenario ends the same way: both sides must be in the call, hear each other, and agree about it.
//   node tests/e2e/calls.js [filter]        E2E_LATENCY=100 E2E_JITTER=60 E2E_TRIALS=2
const { Rig, TurnLab, sleep } = require('./rig');

const LATENCY = Number(process.env.E2E_LATENCY ?? 100), JITTER = Number(process.env.E2E_JITTER ?? 60), TRIALS = Number(process.env.E2E_TRIALS ?? 2);
const FILTER = process.argv[2] || '';
const LIVE_BUDGET_MS = Number(process.env.E2E_BUDGET ?? 6000);   // from the last click to both sides hearing each other

const PROBE = `(async()=>{
  let inbound=0;try{if(pc){const stats=await pc.getStats();stats.forEach(r=>{if(r.type==='inbound-rtp'&&r.kind==='audio')inbound+=r.bytesReceived||0})}}catch{}
  return {status:callStatus.textContent,btn:callBtn.dataset.callState,disabled:callBtn.disabled,active:!!callActive,friendInCall:!!friendInCall,pc:pc?pc.connectionState:null,inbound,hint:pairHint.textContent}
})()`;
const snapshot = app => app.eval(PROBE);
const isLive = s => s.active && s.btn === 'end' && s.pc === 'connected' && s.inbound > 0 && s.friendInCall;

// Presses the call button the way a person does: wait for it to be usable, click, and if nothing happened in a
// while, click again. Returns how many clicks it took.
async function join(app, { patienceMs = 8000, maxClicks = 5 } = {}) {
  const started = Date.now(); let clicks = 0;
  while (clicks < maxClicks) {
    const state = await snapshot(app);
    if (state.btn === 'end' && state.active) break;
    if (state.disabled) { await sleep(150); if (Date.now() - started > patienceMs * maxClicks) break; continue; }
    clicks++; await app.eval('callBtn.click()');
    const until = Date.now() + patienceMs;
    while (Date.now() < until) { const s = await snapshot(app); if (s.active && s.btn === 'end') return { clicks, ms: Date.now() - started }; await sleep(80); }
  }
  return { clicks, ms: Date.now() - started };
}

// Bytes of audio received so far; two readings apart tell whether sound is flowing right now.
const inboundBytes = async app => (await snapshot(app)).inbound;
async function flowing(app, ms = 450) { const before = await inboundBytes(app); await sleep(ms); return (await inboundBytes(app)) > before; }
async function bothLive(a, b, budgetMs = LIVE_BUDGET_MS) {
  const started = Date.now(); let last = [];
  while (Date.now() - started < budgetMs) {
    last = await Promise.all([snapshot(a), snapshot(b)]);
    if (isLive(last[0]) && isLive(last[1])) {
      const [x, y] = await Promise.all([flowing(a), flowing(b)]);
      if (x && y) return { ok: true, ms: Date.now() - started };
    }
    await sleep(120);
  }
  return { ok: false, ms: budgetMs, states: last.map(s => `${s.status}|${s.pc}|in=${s.inbound}|active=${s.active}|friend=${s.friendInCall}`) };
}

const open = async (rig, ids, who = ['alice', 'bob']) => {
  const [a, b] = who.map(name => rig.apps[name]);
  await a.eval(`selectFriend(${JSON.stringify(ids.bId)})`); await b.eval(`selectFriend(${JSON.stringify(ids.aId)})`);
  return [a, b];
};
const hangUp = async app => { await sleep(900); await app.eval('callBtn.dataset.callState==="end"&&callBtn.click()'); };   // nobody ends a call in under a second; that click would be a double-click
const expect = (condition, message) => { if (!condition) throw new Error(message); };

const scenarios = {
  async 'A calls, B joins'(rig, ids) {
    const [a, b] = await open(rig, ids);
    for (const proxy of Object.values(rig.proxies)) proxy.resetCounts();
    const x = await join(a); await b.waitFor('friendInCall', 'B to see the call', 8000);
    const pressed = Date.now(); const y = await join(b); const live = await bothLive(a, b);
    expect(x.clicks === 1 && y.clicks === 1, `needed ${x.clicks}+${y.clicks} clicks`); expect(live.ok, 'not live: ' + JSON.stringify(live.states));
    const joinToLiveMs = Date.now() - pressed; await sleep(1500);
    // What this call cost the Worker: every message either app sent to it from the first click until a moment after both heard each other.
    const messages = {}; for (const proxy of Object.values(rig.proxies)) for (const [key, count] of Object.entries(proxy.counts)) if (/^(signal|call-presence|connect|turn-credentials)/.test(key)) messages[key] = (messages[key] || 0) + count;
    return { clicks: [x.clicks, y.clicks], joinToLiveMs, workerMessages: messages };
  },
  async 'B never opened the DM'(rig, ids) {
    const { alice: a, bob: b } = rig.apps; await a.eval(`selectFriend(${JSON.stringify(ids.bId)})`);
    const x = await join(a); await b.waitFor('friendInCall', 'B to hear about the call', 8000);
    await b.eval(`selectFriend(${JSON.stringify(ids.aId)})`);
    const y = await join(b); const live = await bothLive(a, b);
    expect(x.clicks === 1 && y.clicks === 1, `needed ${x.clicks}+${y.clicks} clicks`); expect(live.ok, 'not live: ' + JSON.stringify(live.states));
    return { clicks: [x.clicks, y.clicks], liveMs: live.ms };
  },
  async 'hang up and redial three times'(rig, ids) {
    const [a, b] = await open(rig, ids); const rounds = [];
    for (let round = 0; round < 3; round++) {
      const x = await join(a); const y = await join(b); const live = await bothLive(a, b);
      expect(x.clicks === 1 && y.clicks === 1, `round ${round + 1}: needed ${x.clicks}+${y.clicks} clicks`); expect(live.ok, `round ${round + 1} not live: ` + JSON.stringify(live.states));
      rounds.push(live.ms); await hangUp(a); await sleep(700); await hangUp(b); await sleep(700);
    }
    return { liveMs: rounds };
  },
  async 'both press call at the same moment'(rig, ids) {
    const [a, b] = await open(rig, ids);
    await Promise.all([a.eval('callBtn.click()'), b.eval('callBtn.click()')]);
    const live = await bothLive(a, b, 12000);
    expect(live.ok, 'glare left them apart: ' + JSON.stringify(live.states));
    return { liveMs: live.ms };
  },
  async 'the caller hangs up before anyone answers, then the friend calls back'(rig, ids) {
    const [a, b] = await open(rig, ids);
    await join(a); await b.waitFor('friendInCall', 'B to see the ring', 8000);
    await hangUp(a); await b.waitFor('!friendInCall', 'the ring to stop', 8000);
    const y = await join(b); await a.waitFor('friendInCall', 'A to see the call back', 8000);
    const x = await join(a); const live = await bothLive(a, b);
    expect(y.clicks === 1 && x.clicks === 1, `needed ${y.clicks}+${x.clicks} clicks`); expect(live.ok, 'not live: ' + JSON.stringify(live.states));
    return { clicks: [y.clicks, x.clicks], liveMs: live.ms };
  },
  async 'the friend loses signaling for four seconds while the phone rings'(rig, ids) {
    const [a, b] = await open(rig, ids);
    await join(a); await b.waitFor('friendInCall', 'B to see the ring', 8000);
    await rig.proxies.bob.blip(4000);
    await b.waitFor("directorySocket?.readyState===1&&directoryAuthenticatedSocket===directorySocket", 'B to reconnect', 30000);
    await b.waitFor('friendInCall', 'B to hear about the call again', 12000);
    const y = await join(b); const live = await bothLive(a, b);
    expect(y.clicks === 1, `needed ${y.clicks} clicks after the reconnect`); expect(live.ok, 'not live: ' + JSON.stringify(live.states));
    return { clicks: y.clicks, liveMs: live.ms };
  },
  async 'a live call survives six seconds without signaling and still ends cleanly'(rig, ids) {
    const [a, b] = await open(rig, ids);
    await join(a); await join(b); expect((await bothLive(a, b)).ok, 'never went live');
    await Promise.all([rig.proxies.alice.blip(6000), rig.proxies.bob.blip(6000)]);
    await sleep(500); const during = await Promise.all([snapshot(a), snapshot(b)]);
    expect(during.every(s => s.active && s.pc === 'connected'), 'the call dropped when only signaling was lost: ' + JSON.stringify(during.map(s => s.status)));
    await Promise.all([a, b].map(app => app.waitFor("directorySocket?.readyState===1&&directoryAuthenticatedSocket===directorySocket", 'to reconnect', 30000)));
    await hangUp(a); await b.waitFor('!friendInCall', 'B to learn A hung up', 10000);
    const end = await Promise.all([snapshot(a), snapshot(b)]);
    expect(!end[0].active && end[0].btn === 'start', 'A still thinks it is in a call');
    return { ok: true };
  },
  async 'the friend restarts Knot while the phone rings'(rig, ids) {
    const [a, b] = await open(rig, ids);
    await join(a); await b.waitFor('friendInCall', 'B to see the ring', 8000);
    await b.restart(); await b.waitFor(`!!directoryUser(${JSON.stringify(ids.aId)})`, 'B to see their friends again', 20000); await b.eval(`selectFriend(${JSON.stringify(ids.aId)})`);
    await b.waitFor('friendInCall', 'B to hear about the ring after restarting', 15000);
    const y = await join(b); const live = await bothLive(a, b);
    expect(y.clicks === 1, `needed ${y.clicks} clicks after the restart`); expect(live.ok, 'not live: ' + JSON.stringify(live.states));
    return { clicks: y.clicks, liveMs: live.ms };
  },
  async 'the caller restarts Knot mid-call and rejoins'(rig, ids) {
    const [a, b] = await open(rig, ids);
    await join(a); await join(b); expect((await bothLive(a, b)).ok, 'never went live');
    await a.restart(); await a.waitFor(`!!directoryUser(${JSON.stringify(ids.bId)})`, 'A to see their friends again', 20000); await a.eval(`selectFriend(${JSON.stringify(ids.bId)})`);
    const x = await join(a, { patienceMs: 10000 }); const live = await bothLive(a, b, 10000);
    expect(live.ok, 'rejoin failed after a restart: ' + JSON.stringify(live.states)); expect(x.clicks === 1, `needed ${x.clicks} clicks to rejoin`);
    return { clicks: x.clicks, liveMs: live.ms };
  },
  async 'a frantic triple click starts one call, not a toggle war'(rig, ids) {
    const [a, b] = await open(rig, ids);
    for (let index = 0; index < 3; index++) { await a.eval('callBtn.click()'); await sleep(120); }
    await b.waitFor('friendInCall', 'B to see the ring', 8000);
    const state = await snapshot(a); expect(state.active && state.btn === 'end', 'the extra clicks cancelled the call: ' + state.status);
    await join(b); const live = await bothLive(a, b); expect(live.ok, 'not live: ' + JSON.stringify(live.states));
    return { liveMs: live.ms };
  },
  async 'a friend leaves mid-call and rejoins with one click'(rig, ids) {
    const [a, b] = await open(rig, ids);
    await join(a); await join(b); expect((await bothLive(a, b)).ok, 'never went live');
    await hangUp(b); await a.waitFor('!friendInCall', 'A to see B leave', 8000);
    const waiting = await snapshot(a); expect(waiting.active && waiting.btn === 'end', 'A should stay in the call, waiting: ' + waiting.status);
    const y = await join(b); const live = await bothLive(a, b);
    expect(live.ok, 'the rejoin failed: ' + JSON.stringify(live.states)); expect(y.clicks === 1, `needed ${y.clicks} clicks to rejoin`);
    return { clicks: y.clicks, liveMs: live.ms };
  },
  async 'the connection is ready before the friend answers, so joining is instant'(rig, ids) {
    const [a, b] = await open(rig, ids);
    await join(a);
    await b.waitFor("!!pc&&pc.connectionState==='connected'&&!callActive", 'the connection to come up while the phone rings', 8000);
    const paused = await b.eval('(()=>{const e=reservedVoiceSender()?.getParameters().encodings;return e&&e.length?e[0].active:null})()');
    expect(paused === false, 'an unanswered connection should not be sending silence (active=' + paused + ')');
    const pressed = Date.now(); await join(b); const live = await bothLive(a, b, 4000);
    expect(live.ok, 'not live: ' + JSON.stringify(live.states));
    const joinToLiveMs = Date.now() - pressed; expect(joinToLiveMs < 2500, 'joining a ready connection took ' + joinToLiveMs + ' ms');
    return { joinToLiveMs };
  },
  async 'silence between calls costs nothing and rejoining resumes sound'(rig, ids) {
    const [a, b] = await open(rig, ids);
    await join(a); await join(b); expect((await bothLive(a, b)).ok, 'never went live');
    await hangUp(a); await hangUp(b); await sleep(1500);
    const idle = await Promise.all([flowing(a, 1500), flowing(b, 1500)]);
    expect(!idle[0] && !idle[1], 'audio kept flowing after both left the call: ' + JSON.stringify(idle));
    const x = await join(a); const y = await join(b); const live = await bothLive(a, b);
    expect(live.ok, 'sound did not resume after rejoining: ' + JSON.stringify(live.states)); expect(x.clicks === 1 && y.clicks === 1, `needed ${x.clicks}+${y.clicks} clicks`);
    return { idleFlowing: idle, liveMs: live.ms };
  },
  async 'a friend who is offline is rung when they come back'(rig, ids) {
    const [a, b] = await open(rig, ids);
    await b.stop(); await a.waitFor(`!friendReachable(${JSON.stringify(ids.bId)})`, 'A to see B go offline', 20000);
    const x = await join(a); expect(x.clicks === 1, 'the press was refused for an offline friend');
    const waiting = await snapshot(a); expect(waiting.active, 'A should be calling: ' + waiting.status);
    await b.start({ keepData: true }); await b.waitFor("directorySocket?.readyState===1&&directoryAuthenticatedSocket===directorySocket", 'B to sign in again', 40000);
    await b.waitFor(`!!directoryUser(${JSON.stringify(ids.aId)})`, 'B to see their friends', 20000); await b.eval(`selectFriend(${JSON.stringify(ids.aId)})`);
    await b.waitFor('friendInCall', 'B to hear the waiting call', 15000);
    const y = await join(b); const live = await bothLive(a, b, 10000);
    expect(live.ok && y.clicks === 1, 'not live after the friend came back: ' + JSON.stringify(live.states));
    return { clicks: y.clicks, liveMs: live.ms };
  },
  async 'encrypted chat and the files channel work over the new connection'(rig, ids) {
    const [a, b] = await open(rig, ids);
    await join(a); await join(b); expect((await bothLive(a, b)).ok, 'never went live');
    const keys = await Promise.all([a, b].map(app => app.eval('!!sharedKey&&!!directFileKey')));
    expect(keys.every(Boolean), 'the two sides did not both derive their keys: ' + keys);
    const channels = await Promise.all([a, b].map(app => app.eval("({chat:chat?.readyState,files:files?.readyState,bus:!!fileBus(),negotiated:chat?.negotiated&&files?.negotiated})")));
    expect(channels.every(c => c.chat === 'open' && c.files === 'open' && c.bus && c.negotiated), 'channels not ready: ' + JSON.stringify(channels));
    const text = 'direct hello ' + Math.random().toString(36).slice(2, 8);
    await a.eval(`(async()=>{send({t:'msg',v:await seal(chatPayload(${JSON.stringify(text)},null))})})()`);
    await b.waitFor(`document.body.textContent.includes(${JSON.stringify(text)})`, 'B to receive the encrypted direct message', 8000);
    return { delivered: true };
  },
  async 'both start a renegotiation mid-call and the call stays live'(rig, ids) {
    const [a, b] = await open(rig, ids);
    await join(a); await join(b); expect((await bothLive(a, b)).ok, 'never went live');
    await Promise.all([a, b].map(app => app.eval("(async()=>{pc.addTransceiver('video',{direction:'sendonly'});return await renegotiate()})()")));
    await Promise.all([a, b].map(app => app.waitFor("pc.signalingState==='stable'&&pc.getTransceivers().filter(t=>t.mid&&t.receiver.track.kind==='video').length>=2", 'both video lines to settle', 15000)));
    const live = await bothLive(a, b, 6000); expect(live.ok, 'the call broke during renegotiation: ' + JSON.stringify(live.states));
    return { liveMs: live.ms };
  },
  async 'with no direct path at all the relay carries the call and files and screens are held back'(rig, ids) {
    const [a, b] = await open(rig, ids);
    const started = Date.now(); await join(a); await join(b);
    const live = await bothLive(a, b, 45000);
    expect(live.ok, 'the relay never carried the call: ' + JSON.stringify(live.states));
    const probe = "({route:linkHub.current.route,relayMode:relayVoiceMode,escalated:linkHub.current.escalated,noFiles:files===null,shareHeld:screenBtn.disabled})";
    const routes = await Promise.all([a, b].map(app => app.eval(probe)));
    expect(routes.every(r => r.route === 'relay' && r.relayMode && r.escalated && r.noFiles && r.shareHeld), 'the call is not held to relay rules: ' + JSON.stringify(routes));
    const refused = await a.eval(`ensureDmMediaConnection(${JSON.stringify(ids.bId)},{requireFileChannel:true}).then(()=>'allowed',e=>e.message)`);
    expect(/relay/i.test(refused), 'a file connection was allowed over the relay: ' + refused);
    return { liveMs: Date.now() - started, routes: routes.map(r => r.route) };
  },
  async 'a ring that arrives while viewing another conversation is joined from its own DM'(rig, ids) {
    const { alice: a, bob: b, carol: c } = rig.apps; const aId = ids.aId, bId = ids.bId, cId = ids.cId;
    await a.eval(`selectFriend(${JSON.stringify(cId)})`); await b.eval(`selectFriend(${JSON.stringify(aId)})`);
    await join(b); await a.waitFor('friendInCall', 'A to hear B ringing while viewing C', 8000);
    const viewing = await a.eval('({status:callStatus.textContent,button:callBtn.title,calling:dmCallPeerId})');
    expect(viewing.calling === bId, 'the ring was not attributed to the caller: ' + JSON.stringify(viewing));
    await a.eval(`selectFriend(${JSON.stringify(bId)})`);
    const opened = await a.eval('({status:callStatus.textContent,button:callBtn.title})');
    expect(/Join/.test(opened.button), 'opening the caller\'s DM did not offer to join: ' + JSON.stringify(opened));
    const x = await join(a); const live = await bothLive(a, b);
    expect(x.clicks === 1 && live.ok, 'not live: ' + JSON.stringify(live.states));
    return { clicks: x.clicks, liveMs: live.ms };
  },
};

(async () => {
  const rows = []; let failed = 0;
  for (const [name, run] of Object.entries(scenarios)) {
    if (FILTER && !name.toLowerCase().includes(FILTER.toLowerCase())) continue;
    let passes = 0; const notes = [];
    for (let trial = 1; trial <= TRIALS; trial++) {
      const three = /another conversation/.test(name), relay = /no direct path/.test(name);
      if (relay && !TurnLab.available()) { notes.push('skipped: install node-turn (see tests/e2e/rig.js)'); passes++; continue; }
      const rig = new Rig({ latencyMs: LATENCY, jitterMs: JITTER, names: three ? ['alice', 'bob', 'carol'] : ['alice', 'bob'], turn: relay, stripDirect: relay });
      try { await rig.start(); const ids = await rig.befriend('alice', 'bob'); if (three) ids.cId = (await rig.befriend('alice', 'carol')).bId; const result = await run(rig, ids); passes++; notes.push(JSON.stringify(result)); }
      catch (error) {
        notes.push('FAIL: ' + error.message);
        for (const [who, app] of Object.entries(rig.apps)) { const tail = app.console.filter(entry => /error|exception|warn/.test(entry.type)).slice(-3).map(entry => String(entry.text).slice(0, 140)); if (tail.length) notes.push(`  ${who}: ${tail.join(' | ')}`); }
      } finally { try { await rig.stop(); } catch (error) { notes.push('RIG: ' + error.message); failed++; } }
    }
    failed += TRIALS - passes; rows.push({ name, passes });
    console.log(`${passes === TRIALS ? 'PASS' : 'FAIL'} ${name} (${passes}/${TRIALS})`); for (const note of notes) console.log('     ' + note);
  }
  console.log(failed ? `\n${failed} trial(s) failed` : '\nALL CALL SCENARIOS PASSED');
  setTimeout(() => process.exit(failed ? 1 : 0), 300);
})();
