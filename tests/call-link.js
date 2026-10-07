'use strict';

// Two CallLinks in one renderer, each with a real RTCPeerConnection, talking through an in-memory "network"
// that can delay, drop, duplicate and reorder-within-limits what they send. Run with run-electron-smoke.js.
const fs = require('fs');
const path = require('path');
const { app, BrowserWindow } = require('electron');

app.commandLine.appendSwitch('disable-features', 'WebRtcHideLocalIpsWithMdns');
app.commandLine.appendSwitch('use-fake-ui-for-media-stream');
app.commandLine.appendSwitch('autoplay-policy', 'no-user-gesture-required');   // the test's audio contexts must run to produce packets
app.disableHardwareAcceleration();

const source = fs.readFileSync(path.join(__dirname, '..', 'call-link.js'), 'utf8');

const harness = `
(async () => {
  const { CallLink, LinkHub, embedMeta, extractMeta, versionOf } = window.KnotCallLink;
  const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));
  const until = async (predicate, label, timeout = 15000) => { const stop = Date.now() + timeout; for (;;) { if (await predicate()) return; if (Date.now() > stop) throw new Error('timed out: ' + label); await sleep(25); } };
  const results = [], fail = message => { throw new Error(message); };
  const ok = (condition, message) => { if (!condition) fail(message); };

  // ---- the meta attributes survive and never reach the browser
  {
    const pc = new RTCPeerConnection(); pc.createDataChannel('x'); const offer = await pc.createOffer();
    const pub = { kty: 'EC', crv: 'P-256', x: 'a'.repeat(43), y: 'b'.repeat(43) };
    const wrapped = embedMeta(offer.sdp, { link: '0123456789abcdef', pub, ack: 7 });
    const meta = extractMeta(wrapped);
    ok(meta.link === '0123456789abcdef' && meta.pub.x === pub.x && meta.pub.y === pub.y && meta.ack === 7, 'meta did not round-trip');
    ok(meta.sdp === offer.sdp, 'stripping the meta changed the SDP');
    ok(wrapped.indexOf('a=knot-link') < wrapped.indexOf('\\nm='), 'the meta must sit before the first media section');
    ok(extractMeta(embedMeta(offer.sdp, { link: 'not-hex' })).link === '', 'a bad link id was accepted');
    ok(extractMeta(embedMeta(offer.sdp, { link: '0123456789abcdef', pub: { x: 'short', y: 'short' } })).pub === null, 'a bad key was accepted');
    ok(Number.isInteger(versionOf(offer.sdp)), 'no SDP version');
    pc.close(); results.push('PASS link id, key and ack ride in the SDP and are stripped before the browser sees them');
  }

  // A network between two people. Each direction is ordered per transport but can be slow, lossy or duplicating.
  class Net {
    constructor(options = {}) { Object.assign(this, { delay: () => 20, loss: () => false, dup: () => false }, options); this.sent = 0; this.lost = 0; this.log = []; this.cut = false; }
    // The real path is one WebSocket per direction through the Worker, so messages from one side arrive in the order
    // they were sent, only late. Each call of send() belongs to one direction, keyed by its destination function.
    send(to, message) {
      this.sent++; if (this.cut || this.loss(message)) { this.lost++; return true; }
      const copies = this.dup(message) ? 2 : 1, lanes = this.lanes ||= new Map();
      for (let i = 0; i < copies; i++) {
        const at = Math.max(lanes.get(to.lane) || 0, Date.now() + this.delay(message)) + i; lanes.set(to.lane, at);
        setTimeout(() => to(message), Math.max(0, at - Date.now()));
      }
      return true;
    }
  }

  const ids = { a: 'aaaa', b: 'bbbb' };   // b > a, so b is the polite side
  function peer(name, net, other, options = {}) {
    const side = { name, links: [], pubs: [], channelText: [], states: [], logs: [], created: 0 };
    side.hub = new LinkHub({
      selfId: ids[name], log: message => side.logs.push(message),
      create: ({ peerId, linkId, polite }) => {
        side.created++;
        const link = new CallLink({
          RTCPeerConnection, peerId, linkId, polite, iceServers: [], log: message => side.logs.push(message),
          localPub: { kty: 'EC', crv: 'P-256', x: name.repeat(43).slice(0, 43), y: name.repeat(43).slice(0, 43) },
          offerRetryMs: options.offerRetryMs, escalateMs: options.escalateMs, restartMinMs: 300, relayServers: options.relayServers,
          signal: message => { const deliver = m => other().hub.receive(ids[name], m); deliver.lane = name; return net.send(deliver, message); },
          onpub: pub => side.pubs.push(pub.x[0]), onstate: state => side.states.push(state),
          setup: (pc, self) => {
            self.chat = pc.createDataChannel('chat', { negotiated: true, id: 0 });
            self.chat.onmessage = event => side.channelText.push(event.data);
            // addTrack, not addTransceiver: only transceivers made this way are reused when an offer arrives (the app does the same).
            const context = new AudioContext(), destination = context.createMediaStreamDestination(); self.context = context;
            const tone = context.createOscillator(); tone.connect(destination); tone.start();   // real samples, so audio packets really flow
            self.audio = pc.addTrack(destination.stream.getAudioTracks()[0], destination.stream);
          },
          ...options.link,
        });
        side.links.push(link); return link;
      },
    });
    return side;
  }
  const connected = side => side.hub.current?.state === 'connected' && side.hub.current.chat?.readyState === 'open';
  const closeAll = (...sides) => sides.forEach(side => { for (const link of side.links) { try { link.context?.close(); } catch {} } side.hub.drop(); });
  const talk = async (from, to, text) => { from.hub.current.chat.send(text); await until(() => to.channelText.includes(text), 'a message over the data channel'); };

  // ---- an ordinary connection, built from one side's click
  {
    const net = new Net({ delay: () => 15 + Math.random() * 40 }); let A, B; A = peer('a', net, () => B); B = peer('b', net, () => A);
    const link = A.hub.ensure(ids.b); link.start();
    await until(() => connected(A) && connected(B), 'a plain connection', 15000);
    ok(A.hub.current.linkId === B.hub.current.linkId, 'the two sides use different link ids');
    ok(A.pubs.length === 1 && B.pubs.length === 1 && A.pubs[0] === 'b' && B.pubs[0] === 'a', 'the keys were not exchanged exactly once: ' + JSON.stringify([A.pubs, B.pubs]));
    ok(B.created === 1, 'the answering side built ' + B.created + ' links');
    await talk(A, B, 'hello from a'); await talk(B, A, 'hello from b');
    ok(A.hub.current.offerCount === 1 && B.hub.current.offerCount === 0, 'extra offers were made: ' + [A.hub.current.offerCount, B.hub.current.offerCount] + ' A:' + JSON.stringify(A.logs) + ' B:' + JSON.stringify(B.logs));
    closeAll(A, B); results.push('PASS a plain connection: one offer, keys exchanged once, negotiated channel works both ways');
  }

  // ---- both sides start at once, many network timings
  {
    let wins = 0, merged = 0;
    for (let run = 0; run < 14; run++) {
      const spread = () => 5 + Math.random() * 180, net = new Net({ delay: spread }); let A, B; A = peer('a', net, () => B); B = peer('b', net, () => A);
      const first = Math.random() < .5 ? [A, B] : [B, A];
      first[0].hub.ensure(ids[first[1].name]).start(); await sleep(Math.random() * 120); first[1].hub.ensure(ids[first[0].name]).start();
      const dump = side => ({ links: side.links.map(l => ({ id: l.linkId.slice(0, 6), creator: l.creator, closed: l.closed, state: l.state, sig: l.pc.signalingState, est: l.established, offers: l.offerCount })), cur: side.hub.current?.linkId.slice(0, 6), logs: side.logs.slice(-14) });
      try { await until(() => connected(A) && connected(B), 'glare run ' + run + ' to connect', 12000); } catch (error) { fail(error.message + ' first=' + first[0].name + ' A=' + JSON.stringify(dump(A)) + ' B=' + JSON.stringify(dump(B))); }
      ok(A.hub.current.linkId === B.hub.current.linkId, 'glare run ' + run + ': links never merged');
      await talk(A, B, 'x' + run);
      if ([...A.logs, ...B.logs].some(line => /keeping our own link/.test(line)) || A.created + B.created > 2) merged++;
      wins++; closeAll(A, B);
    }
    ok(merged >= 3, 'only ' + merged + ' runs actually collided, so the merge rule was barely exercised');
    results.push('PASS simultaneous starts end as one connection (' + wins + ' randomised runs, ' + merged + ' truly collided)');
  }

  // ---- messages lost, duplicated and delayed
  {
    let drops = 0;
    const net = new Net({ delay: () => 30 + Math.random() * 50, loss: message => message.kind !== 'candidate' && drops < 3 && ++drops, dup: () => true });
    let A, B; A = peer('a', net, () => B, { offerRetryMs: 500 }); B = peer('b', net, () => A, { offerRetryMs: 500 });
    A.hub.ensure(ids.b).start();
    await until(() => connected(A) && connected(B), 'a connection despite lost and doubled messages', 20000);
    ok(net.lost >= 3, 'the test never lost anything'); ok(A.hub.current.offerRetries >= 1 || B.hub.current.offerRetries >= 1 || A.logs.some(l => /sending again/.test(l)), 'the lost offer was not sent again');
    ok(B.created === 1 && A.created === 1, 'duplicates created extra links: ' + [A.created, B.created]);
    await talk(A, B, 'still fine'); closeAll(A, B); results.push('PASS lost, duplicated and delayed signalling still connects (' + net.lost + ' lost)');
  }

  // ---- the friend restarts: a brand new link replaces the old one on the side that stayed
  {
    const net = new Net({ delay: () => 20 }); let A, B; A = peer('a', net, () => B); B = peer('b', net, () => A);
    A.hub.ensure(ids.b).start(); await until(() => connected(A) && connected(B), 'first connection');
    const firstId = B.hub.current.linkId, oldLink = B.hub.current;
    A.hub.drop(); A.pubs.length = 0; A.channelText.length = 0;                  // the app restarted: all state gone
    A.hub.ensure(ids.b).start();
    await until(() => connected(A) && connected(B) && B.hub.current.linkId !== firstId, 'the rebuilt connection', 20000);
    ok(oldLink.closed && B.created === 2, 'the old link was kept: closed=' + oldLink.closed + ' created=' + B.created);
    await talk(A, B, 'after restart'); await talk(B, A, 'and back'); closeAll(A, B); results.push('PASS a restarted friend replaces the old link with one offer');
  }

  // ---- both change the call at the same time (renegotiation glare), many timings
  {
    for (let run = 0; run < 10; run++) {
      const net = new Net({ delay: () => 5 + Math.random() * 160 }); let A, B; A = peer('a', net, () => B); B = peer('b', net, () => A);
      A.hub.ensure(ids.b).start(); await until(() => connected(A) && connected(B), 'first connection');
      A.hub.current.pc.addTransceiver('video', { direction: 'sendonly' }); await sleep(Math.random() * 120); B.hub.current.pc.addTransceiver('video', { direction: 'sendonly' });
      const videoLines = side => side.hub.current.pc.getTransceivers().filter(t => t.mid && t.receiver.track.kind === 'video').length;
      const dump = side => JSON.stringify({ sig: side.hub.current.pc.signalingState, lines: videoLines(side), logs: side.logs.slice(-8) });
      try { await until(() => A.hub.current.pc.signalingState === 'stable' && B.hub.current.pc.signalingState === 'stable' && videoLines(A) >= 2 && videoLines(B) >= 2, 'both video lines to settle', 12000); }
      catch (error) { fail('renegotiation run ' + run + ': ' + error.message + ' A=' + dump(A) + ' B=' + dump(B)); }
      await sleep(400);
      const count = side => side.hub.current.pc.getTransceivers().filter(t => t.mid).length;
      ok(count(A) === count(B), 'run ' + run + ': the sides disagree about how many media lines exist: ' + [count(A), count(B)]);
      ok(A.hub.current.pc.signalingState === 'stable' && B.hub.current.pc.signalingState === 'stable', 'run ' + run + ': someone is stuck mid-negotiation');
      await talk(A, B, 'after glare ' + run); closeAll(A, B);
    }
    results.push('PASS simultaneous renegotiation settles with both sides agreeing (10 randomised runs)');
  }

  // ---- an ICE restart keeps the call and changes the credentials
  {
    const net = new Net({ delay: () => 20 }); let A, B; A = peer('a', net, () => B); B = peer('b', net, () => A);
    A.hub.ensure(ids.b).start(); await until(() => connected(A) && connected(B), 'first connection');
    const ufrag = side => /a=ice-ufrag:(\\S+)/.exec(side.hub.current.pc.localDescription.sdp)[1], before = ufrag(A);
    A.hub.current.restartIce();
    await until(() => ufrag(A) !== before && A.hub.current.pc.signalingState === 'stable', 'the restart to be answered', 15000);
    await until(() => connected(A) && connected(B), 'to stay connected after the restart');
    await talk(B, A, 'after the restart'); closeAll(A, B); results.push('PASS an ICE restart changes credentials and the connection survives');
  }

  // ---- ICE restarts, alone and crossing each other, keep audio flowing both ways (not just the data channel)
  {
    const sentBytes = async side => { let bytes = 0; (await side.hub.current.pc.getStats()).forEach(r => { if (r.type === 'outbound-rtp' && r.kind === 'audio') bytes += r.bytesSent || 0; }); return bytes; };
    const sending = async side => { const before = await sentBytes(side); await sleep(700); return (await sentBytes(side)) > before; };
    for (const pattern of ['impolite alone', 'polite alone', 'both at once', 'both at once', 'both at once']) {
      const net = new Net({ delay: () => 20 + Math.random() * 40 }); let A, B; A = peer('a', net, () => B); B = peer('b', net, () => A);
      for (const side of [A, B]) side.restartMinMs = 0;
      A.hub.ensure(ids.b).start(); await until(() => connected(A) && connected(B), 'first connection');
      ok(await sending(A) && await sending(B), pattern + ': audio was not flowing before the restart');
      if (pattern !== 'polite alone') A.hub.current.restartIce();
      if (pattern !== 'impolite alone') B.hub.current.restartIce();
      await sleep(2500); await until(() => A.hub.current.pc.signalingState === 'stable' && B.hub.current.pc.signalingState === 'stable', pattern + ': settle', 15000);
      const flow = [await sending(A), await sending(B)];
      ok(flow[0] && flow[1], pattern + ': a side stopped sending audio after the restart ' + JSON.stringify(flow) + ' B:' + JSON.stringify(B.logs.slice(-6)));
      closeAll(A, B);
    }
    results.push('PASS ICE restarts, alone or crossing, keep audio flowing both ways');
  }

  // ---- no way through: the relay is requested once, and the restart carries it
  {
    const net = new Net({ delay: () => 20, loss: message => message.kind === 'candidate' });
    let asked = 0, A, B;
    const relayServers = async () => { asked++; return [{ urls: 'stun:127.0.0.1:9' }]; };
    A = peer('a', net, () => B, { escalateMs: 700, relayServers }); B = peer('b', net, () => A, { escalateMs: 700, relayServers });
    A.hub.ensure(ids.b).start();
    await until(() => asked >= 1, 'the relay to be requested when nothing connects', 10000);
    await sleep(900);
    ok(asked === 2 || asked === 1, 'the relay was requested ' + asked + ' times (once per side at most)');
    const config = A.hub.current.pc.getConfiguration();
    ok(config.iceServers.some(server => [].concat(server.urls).some(url => /127\\.0\\.0\\.1:9/.test(url))), 'the relay server was not added to the configuration');
    ok(A.hub.current.escalated, 'the link did not record the escalation');
    closeAll(A, B); results.push('PASS a connection that cannot form asks for the relay once and adds it');
  }

  // ---- failing to get a relay must not kill a connection that is only slow
  {
    const net = new Net({ delay: () => 15, loss: message => message.kind === 'candidate' });
    let asked = 0, failures = [], A, B;
    const relayServers = async () => { asked++; throw new Error('no relay credentials'); };
    A = peer('a', net, () => B, { escalateMs: 400, relayServers, link: { onfailed: reason => failures.push(reason) } }); B = peer('b', net, () => A, { escalateMs: 400, relayServers });
    A.hub.ensure(ids.b).start();
    await until(() => asked >= 1, 'the relay to be requested', 10000); await sleep(500);
    const link = A.hub.current;
    ok(!link.dead && failures.length === 0, 'a slow connection was declared dead because the relay was unavailable: ' + JSON.stringify(failures));
    ok(link.escalated === false, 'the link did not allow a later relay attempt');
    link.state = 'failed'; await link.escalate('failed');          // now the direct path has really failed
    ok(link.dead && failures.includes('no relay'), 'a failed direct path with no relay was not reported: ' + JSON.stringify(failures));
    closeAll(A, B); results.push('PASS a missing relay only becomes fatal once the direct path has failed');
  }

  // ---- a connection nobody needs is let go instead of retried
  {
    const net = new Net({ delay: () => 15 }); let wanted = true, abandoned = 0, A, B;
    A = peer('a', net, () => B, { link: { keepAlive: () => wanted, onabandon: () => abandoned++ } }); B = peer('b', net, () => A);
    A.hub.ensure(ids.b).start(); await until(() => connected(A) && connected(B), 'first connection');
    wanted = false;
    const link = A.hub.current; link.state = 'disconnected'; link._recover('disconnected');   // the connection is reported lost; nobody needs it
    await until(() => abandoned === 1, 'the idle link to be let go', 20000);
    ok(link.dead, 'an abandoned link was not marked dead');
    const sentBefore = net.sent; await sleep(3000); ok(net.sent === sentBefore, 'an abandoned link kept sending signalling messages');
    closeAll(A, B); results.push('PASS a connection nobody needs is let go instead of retried');
  }

  // ---- a stale answer must not be applied to a newer offer
  {
    const kept = []; const net = new Net({ delay: () => 15 });
    let A, B;
    const original = net.send.bind(net);
    net.send = (to, message) => { if (message.kind === 'answer') kept.push(message); return original(to, message); };
    A = peer('a', net, () => B); B = peer('b', net, () => A);
    A.hub.ensure(ids.b).start(); await until(() => connected(A) && connected(B), 'first connection');
    const firstAnswer = kept[0];
    A.hub.current.restartIce(); await until(() => A.hub.current.offerCount === 2 && A.hub.current.pc.signalingState === 'stable', 'the restart', 15000);
    A.hub.current.restartMinMs = 300; await sleep(400);
    const logsBefore = A.logs.length;
    // Put the old answer back on the wire while a newer offer is waiting for its answer.
    let held = false; const hold = net.send; net.send = (to, message) => { if (message.kind === 'answer') { held = true; return true; } return hold(to, message); };
    A.hub.current.restartIce(); await until(() => A.hub.current.pc.signalingState === 'have-local-offer', 'a new offer to be waiting', 10000);
    A.hub.receive(ids.b, firstAnswer);
    await sleep(300);
    ok(A.logs.slice(logsBefore).some(line => /older offer|not waiting/.test(line)) && A.hub.current.pc.signalingState === 'have-local-offer', 'a stale answer was applied to the new offer');
    closeAll(A, B); results.push('PASS an answer to an older offer is ignored');
  }

  return results;
})()
`;

app.whenReady().then(async () => {
  const win = new BrowserWindow({ show: false, webPreferences: { backgroundThrottling: false } });
  await win.loadURL('about:blank');
  let exit = 0;
  try {
    await win.webContents.executeJavaScript(source);
    const results = await win.webContents.executeJavaScript(harness);
    for (const line of results) console.log(line);
    console.log('ALL CALL LINK CHECKS PASSED');
  } catch (error) { console.error('FAIL', error && error.message || error); exit = 1; }
  app.exit(exit);
});
