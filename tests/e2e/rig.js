'use strict';

// Runs the REAL app twice against a local copy of the Worker, so calling can be tested the way a person
// uses it: friends in a directory, buttons clicked, state read back. Nothing here touches your real Knot:
// each instance gets its own data folder, windows stay hidden, microphones are fake and audio is muted.
// It is development-only (see TEST_RIG in main.js; packaged builds ignore every variable used here).
const { spawn } = require('child_process');
const fs = require('fs');
const http = require('http');
const os = require('os');
const path = require('path');
const WebSocket = require('ws');

const ROOT = path.join(__dirname, '..', '..');
// Normally the app under test is this checkout. E2E_APP_ROOT points at another copy (for comparing against an older build).
const APP_ROOT = process.env.E2E_APP_ROOT ? path.resolve(process.env.E2E_APP_ROOT) : ROOT;
// The rig must never touch the real Knot profile. Whatever it does, these files have to look exactly the
// same afterwards, and stop() fails loudly if they do not.
const REAL_KNOT_DIR = path.join(process.env.XDG_CONFIG_HOME || path.join(os.homedir(), '.config'), 'Knot');
function snapshotRealProfile() {
  const state = {};
  try {
    for (const name of fs.readdirSync(REAL_KNOT_DIR)) {
      if (!/^(settings|history|metrics|profile-avatar)/.test(name)) continue;
      const stat = fs.statSync(path.join(REAL_KNOT_DIR, name)); state[name] = stat.size + ':' + Math.round(stat.mtimeMs);
    }
  } catch {}
  return state;
}
const ELECTRON = path.join(ROOT, 'node_modules', 'electron', 'dist', 'electron');
const WRANGLER = path.join(ROOT, 'node_modules', '.bin', 'wrangler');
const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));

function httpGet(url, timeout = 2000) {
  return new Promise((resolve, reject) => {
    const request = http.get(url, response => { let body = ''; response.on('data', chunk => body += chunk); response.on('end', () => resolve({ status: response.statusCode, body })); });
    request.setTimeout(timeout, () => request.destroy(new Error('timeout')));
    request.on('error', reject);
  });
}

async function waitUntil(predicate, label, timeout = 30000, step = 100) {
  const stop = Date.now() + timeout;
  for (;;) {
    let value; try { value = await predicate(); } catch (error) { value = false; }
    if (value) return value;
    if (Date.now() > stop) throw new Error('timed out waiting for ' + label);
    await sleep(step);
  }
}

// Sits between an app and the Worker so a test can behave like a real network: every message arrives late (with
// jitter, never out of order), and the link can be cut for a while and restored.
class SignalProxy {
  constructor(targetPort, { delayMs = 0, jitterMs = 0, stripDirect = false } = {}) {
    this.targetPort = targetPort; this.delayMs = delayMs; this.jitterMs = jitterMs; this.stripDirect = stripDirect; this.down = false; this.pairs = new Set(); this.server = null; this.port = 0; this.counts = {};
  }
  async start() {
    this.server = http.createServer((request, response) => {
      const upstream = http.request({ host: '127.0.0.1', port: this.targetPort, path: request.url, method: request.method, headers: request.headers }, answer => { response.writeHead(answer.statusCode, answer.headers); answer.pipe(response); });
      upstream.on('error', () => { response.statusCode = 502; response.end(); }); request.pipe(upstream);
    });
    this.wss = new WebSocket.Server({ server: this.server, perMessageDeflate: false });
    this.wss.on('connection', (client, request) => {
      if (this.down) { client.close(); return; }
      const upstream = new WebSocket(`ws://127.0.0.1:${this.targetPort}${request.url}`, { perMessageDeflate: false });
      const pair = { client, upstream }; this.pairs.add(pair);
      const lane = (from, to) => { let last = 0; return (data, isBinary) => {
        const at = Math.max(last, Date.now() + this.delayMs + Math.random() * this.jitterMs); last = at;
        setTimeout(() => { if (to.readyState === 1) to.send(data, { binary: isBinary }); }, Math.max(0, at - Date.now()));
      }; };
      const pending = [];
      client.on('message', (data, isBinary) => {
        // Counts what the app sends to the Worker (these are the billed messages), by type and signalling kind.
        try { const value = JSON.parse(String(data)); const key = value.type + (value.payload?.kind ? ':' + value.payload.kind : ''); this.counts[key] = (this.counts[key] || 0) + 1; } catch {}
        if (this.stripDirect) {
          // Pretend the two networks cannot reach each other: only relay candidates may pass, so the call has to use the relay.
          try {
            const value = JSON.parse(String(data));
            if (value.type === 'signal' && value.payload) {
              const payload = value.payload;
              if (payload.kind === 'candidate') { if (!/ typ relay/.test(payload.candidate?.candidate || '')) return; }
              else if (typeof payload.sdp === 'string') payload.sdp = payload.sdp.replace(/^a=candidate:[^\r\n]* typ (?:host|srflx|prflx)[^\r\n]*\r?\n/gm, '');
              data = JSON.stringify(value);
            }
          } catch {}
        }
        const send = lane(client, upstream); if (upstream.readyState === 1) send(data, isBinary); else pending.push([data, isBinary]); });
      upstream.on('open', () => { const send = lane(client, upstream); for (const [data, isBinary] of pending.splice(0)) send(data, isBinary); });
      upstream.on('message', lane(upstream, client));
      const close = () => { this.pairs.delete(pair); try { client.close(); } catch {} try { upstream.close(); } catch {} };
      client.on('close', close); upstream.on('close', close); client.on('error', close); upstream.on('error', close);
    });
    await new Promise(resolve => this.server.listen(0, '127.0.0.1', resolve)); this.port = this.server.address().port;
  }
  resetCounts() { this.counts = {}; }
  // Cuts every live connection and refuses new ones until restore().
  cut() { this.down = true; for (const pair of [...this.pairs]) { try { pair.client.terminate(); } catch {} try { pair.upstream.terminate(); } catch {} } }
  restore() { this.down = false; }
  async blip(ms) { this.cut(); await sleep(ms); this.restore(); }
  stop() { try { this.cut(); this.wss.close(); this.server.close(); } catch {} }
}

// A real TURN relay on loopback. It needs the small node-turn package (MIT); install it once with
//   mkdir -p /tmp/turnlab && cd /tmp/turnlab && npm init -y && npm i node-turn
// or point E2E_TURN_MODULE at it. Scenarios that need it are skipped when it is missing.
function loadTurn() { try { return require(process.env.E2E_TURN_MODULE || '/tmp/turnlab/node_modules/node-turn'); } catch { return null; } }
class TurnLab {
  constructor() { this.port = 0; this.server = null; }
  static available() { return !!loadTurn(); }
  async start() {
    const Turn = loadTurn(); this.port = 41000 + Math.floor(Math.random() * 2000);
    this.server = new Turn({ authMech: 'long-term', credentials: { knot: 'lab' }, listeningPort: this.port, listeningIps: ['127.0.0.1'], relayIps: ['127.0.0.1'], minPort: 52000, maxPort: 52999, debugLevel: 'FATAL', log: () => {} });
    this.server.start(); await sleep(300);
  }
  get iceServers() { return [{ urls: [`turn:127.0.0.1:${this.port}?transport=udp`], username: 'knot', credential: 'lab' }]; }
  stop() { try { this.server.stop(); } catch {} }
}

class Worker {
  constructor(port, stateDir) { this.port = port; this.stateDir = stateDir; this.child = null; this.log = []; }
  async start() {
    fs.mkdirSync(this.stateDir, { recursive: true });
    this.child = spawn(WRANGLER, ['dev', '--local', '--ip', '127.0.0.1', '--port', String(this.port), '--persist-to', this.stateDir, '--log-level', 'warn'], { cwd: ROOT, detached: true, stdio: ['ignore', 'pipe', 'pipe'], env: { ...process.env, NO_COLOR: '1', WRANGLER_SEND_METRICS: 'false', WRANGLER_LOG_PATH: path.join(this.stateDir, 'logs'), XDG_CONFIG_HOME: path.join(this.stateDir, 'config') } });
    for (const stream of [this.child.stdout, this.child.stderr]) stream.on('data', chunk => { this.log.push(String(chunk)); if (this.log.length > 400) this.log.shift(); });
    await waitUntil(async () => (await httpGet(`http://127.0.0.1:${this.port}/`)).body.includes('Knot control plane'), 'the local Worker', 60000, 300);
  }
  stop() {
    try { process.kill(-this.child.pid, 'SIGKILL'); } catch {}
    try { require('child_process').execSync(`pkill -9 -f "[w]orkerd serve.*${this.port}" || true`, { stdio: 'ignore' }); } catch {}
  }
}

class App {
  constructor(name, { cdpPort, dataDir, workerPort, extraArgs = [], env = {} }) {
    this.name = name; this.cdpPort = cdpPort; this.dataDir = dataDir; this.workerPort = workerPort; this.signalPort = workerPort; this.extraArgs = extraArgs; this.env = env;
    this.child = null; this.ws = null; this.nextId = 1; this.pending = new Map(); this.console = []; this.stderr = [];
  }
  async start({ keepData = false } = {}) {
    if (!keepData) fs.rmSync(this.dataDir, { recursive: true, force: true }); fs.mkdirSync(this.dataDir, { recursive: true });
    this.console = []; this.stderr = []; this.pending = new Map(); this.nextId = 1;
    // --headless: the app runs with no display at all, so no window ever appears on the screen of the person running the tests (Linux ignores a
    // window's opacity, so a "transparent" window is an ordinary one). KNOT_TEST_VISIBLE=1 shows real windows, for the few checks that need a GPU; E2E_GPU=1 keeps the app's own GPU settings (the rig turns the GPU off otherwise).
    const flags = ['.', '--use-fake-device-for-media-stream', '--use-fake-ui-for-media-stream', '--mute-audio', ...(process.env.KNOT_TEST_VISIBLE === '1' ? ['--ozone-platform=x11'] : ['--headless']), `--remote-debugging-port=${this.cdpPort}`, ...(process.env.E2E_GPU === '1' ? [] : ['--disable-gpu']), ...this.extraArgs];
    this.child = spawn(ELECTRON, flags, { cwd: APP_ROOT, detached: true, stdio: ['ignore', 'pipe', 'pipe'],
      env: { ...process.env, NODE_OPTIONS: `${process.env.NODE_OPTIONS ? process.env.NODE_OPTIONS + ' ' : ''}--require ${JSON.stringify(path.join(__dirname, '..', 'quiet-windows.js'))}`, ELECTRON_RUN_AS_NODE: '', KNOT_TEST_RIG: '1', KNOT_USER_DATA: this.dataDir, KNOT_SIGNAL_SERVER: `ws://127.0.0.1:${this.signalPort}`, ...this.env } });
    delete this.child.env;
    this.laneLog = [];
    for (const stream of [this.child.stdout, this.child.stderr]) stream.on('data', chunk => { const text = String(chunk); this.stderr.push(text); if (this.stderr.length > 300) this.stderr.shift(); if (text.includes('[udx]')) for (const line of text.split('\n')) if (line.includes('[udx]')) this.laneLog.push({ at: Date.now(), line }); });
    const target = await waitUntil(async () => {
      const list = JSON.parse((await httpGet(`http://127.0.0.1:${this.cdpPort}/json/list`)).body);
      return list.find(item => item.type === 'page' && /index\.html/.test(item.url));
    }, this.name + ' window', 30000, 200);
    this.ws = new WebSocket(target.webSocketDebuggerUrl, { perMessageDeflate: false });
    await new Promise((resolve, reject) => { this.ws.once('open', resolve); this.ws.once('error', reject); });
    this.ws.on('message', data => {
      const message = JSON.parse(data);
      if (message.id && this.pending.has(message.id)) { const { resolve, reject } = this.pending.get(message.id); this.pending.delete(message.id); message.error ? reject(new Error(message.error.message)) : resolve(message.result); }
      else if (message.method === 'Runtime.consoleAPICalled') { this.console.push({ at: Date.now(), type: message.params.type, text: message.params.args.map(arg => arg.value ?? arg.description ?? '').join(' ') }); if (this.console.length > 2000) this.console.shift(); }
      else if (message.method === 'Runtime.exceptionThrown') this.console.push({ at: Date.now(), type: 'exception', text: message.params.exceptionDetails?.exception?.description || message.params.exceptionDetails?.text });
    });
    await this.cdp('Runtime.enable');
  }
  cdp(method, params = {}) { const id = this.nextId++; return new Promise((resolve, reject) => { this.pending.set(id, { resolve, reject }); this.ws.send(JSON.stringify({ id, method, params })); }); }
  // Evaluates in the page's own scope, so the app's functions and variables are reachable by name.
  async eval(expression) {
    const result = await this.cdp('Runtime.evaluate', { expression, awaitPromise: true, returnByValue: true, userGesture: true });
    if (result.exceptionDetails) throw new Error(`${this.name}: ${result.exceptionDetails.exception?.description || result.exceptionDetails.text}`);
    return result.result.value;
  }
  waitFor(expression, label, timeout = 20000) { return waitUntil(() => this.eval(expression), `${this.name}: ${label}`, timeout, 80); }
  // Closes the app the way a crash or a quit would, then starts it again on the same data folder.
  async restart() { await this.stop(); await sleep(300); await this.start({ keepData: true }); await this.waitFor("typeof directoryUserId==='string'&&!!directoryUserId&&directorySocket?.readyState===1&&directoryAuthenticatedSocket===directorySocket", 'to sign in again', 40000); }
  async stop() {
    try { this.ws?.close(); } catch {}
    try { process.kill(-this.child.pid, 'SIGKILL'); } catch {}
    // An app that relaunched itself leaves its process group; its data folder is on its command line or environment.
    try { require('child_process').execSync(`pkill -9 -f "[r]emote-debugging-port=${this.cdpPort}" || true`, { stdio: 'ignore' }); } catch {}
  }
}

class Rig {
  constructor({ workerPort = 8811, base = path.join(os.tmpdir(), 'knot-e2e'), names = ['alice', 'bob'], appOptions = {}, latencyMs = 0, jitterMs = 0, turn = false, stripDirect = false } = {}) {
    this.base = base; this.worker = new Worker(workerPort, path.join(base, 'worker-state')); this.latency = { delayMs: latencyMs, jitterMs, stripDirect }; this.proxies = {}; this.turn = turn ? new TurnLab() : null;
    this.apps = {}; names.forEach((name, index) => { this.apps[name] = new App(name, { cdpPort: 9301 + index, dataDir: path.join(base, name), workerPort, ...(appOptions[name] || {}) }); });
  }
  async start() {
    this.realProfile = snapshotRealProfile();
    fs.rmSync(this.base, { recursive: true, force: true }); fs.mkdirSync(this.base, { recursive: true });
    await this.worker.start();
    if (this.turn) { await this.turn.start(); for (const app of Object.values(this.apps)) app.env = { ...app.env, PAIR_TURN: JSON.stringify(this.turn.iceServers) }; }
    for (const [name, app] of Object.entries(this.apps)) { const proxy = this.proxies[name] = new SignalProxy(this.worker.port, this.latency); await proxy.start(); app.signalPort = proxy.port; }
    await Promise.all(Object.values(this.apps).map(app => app.start()));
    for (const app of Object.values(this.apps)) await app.waitFor("typeof directoryUserId==='string'&&!!directoryUserId&&directorySocket?.readyState===1&&directoryAuthenticatedSocket===directorySocket", 'to sign in to the directory', 40000);
    // A fresh app gets a throwaway identity that changes on every launch. Storing it (exactly what the app does for a
    // signed-in or device-identity user) makes an app that is restarted the same person, with the same friends.
    for (const app of Object.values(this.apps)) {
      await app.eval("(async()=>{await ssSet('directoryUserId',directoryUserId);await ssSet('directoryToken',directoryToken);transientDirectorySession=false})()");
      await app.waitFor("window.pairSettings.has('directoryToken')", 'to keep its identity', 20000);
    }
  }
  // Makes two apps friends the way the UI does: one creates a code, the other redeems it.
  async befriend(a, b) {
    const A = this.apps[a], B = this.apps[b];
    await A.eval("(()=>{$('#roomCode').value='';const ok=directorySend({type:'create-invite',kind:'friend'});return ok})()");
    const code = await A.waitFor("/^\\d{5}$/.test($('#roomCode').value)&&$('#roomCode').value", 'a friend code', 15000);
    const bId = await B.eval('directoryUserId'), aId = await A.eval('directoryUserId');
    await B.eval(`directorySend({type:'redeem-invite',code:${JSON.stringify(code)}})`);
    await A.waitFor(`!!directoryUser(${JSON.stringify(bId)})&&friendReachable(${JSON.stringify(bId)})`, 'to see the new friend online', 20000);
    await B.waitFor(`!!directoryUser(${JSON.stringify(aId)})&&friendReachable(${JSON.stringify(aId)})`, 'to see the new friend online', 20000);
    return { aId, bId };
  }
  async stop() {
    await Promise.all(Object.values(this.apps).map(app => app.stop())); Object.values(this.proxies).forEach(proxy => proxy.stop()); this.turn?.stop(); this.worker.stop();
    await sleep(400);
    const after = snapshotRealProfile(), changed = Object.keys({ ...this.realProfile, ...after }).filter(name => this.realProfile?.[name] !== after[name]);
    if (changed.length) throw new Error('THE E2E RIG CHANGED YOUR REAL KNOT PROFILE: ' + changed.join(', '));
  }
}

module.exports = { Rig, App, Worker, SignalProxy, TurnLab, sleep, waitUntil, ROOT };
