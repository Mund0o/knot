const WebSocket = require('ws');
const http = require('http');
const https = require('https');
const fs = require('fs');
const path = require('path');
const {
  DEFAULT_JOIN_WINDOW_MS,
  RoomJoinLimiter,
  signalingJoinAddress,
  validSignalingRoom,
} = require('./signaling-policy');

const requestedPort = Number(process.env.PORT || 8787);
const port = Number.isInteger(requestedPort)&&requestedPort>=1&&requestedPort<=65535?requestedPort:8787;
const rooms = new Map();

// --- HTTP static server (update feed) ----------------------------------------
// Serves ./public on the SAME port as the WebSocket signaling server, so a
// single forwarded port (8787) handles both. Clients fetch /latest.json and the
// installers (.exe / .tar.gz) from here. Everything outside ./public is blocked.
const PUBLIC_DIR = path.join(__dirname, 'public');
const MIME = { '.json': 'application/json', '.exe': 'application/octet-stream', '.gz': 'application/gzip', '.blockmap': 'application/octet-stream', '.txt': 'text/plain', '.yaml': 'text/plain', '.yml': 'text/plain' };
function safeDownloadUrl(value) {
  try {
    const url = new URL(String(value));
    return url.protocol === 'https:' ? url.href : '';
  } catch {
    return '';
  }
}
// Read the current update manifest (latest.json) if present.
function readManifest() {
  try {
    const file = path.join(PUBLIC_DIR, 'latest.json');
    if (!fs.existsSync(file)) return null;
    return JSON.parse(fs.readFileSync(file, 'utf8'));
  } catch { return null; }
}

// Render the landing page. Highlights the installer that matches the visitor's
// OS (best guess from User-Agent); the page also re-checks client-side via
// navigator.platform so the right button is pre-selected even on ambiguous UAs.
function buildLandingPage(manifest) {
  const version = escapeHtml(manifest && manifest.version ? manifest.version : '—');
  const notes = manifest && manifest.notes ? manifest.notes : '';
  const winUrl = safeDownloadUrl(manifest && manifest.winUrl);
  const linuxUrl = safeDownloadUrl(manifest && manifest.linuxUrl);
  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>Knot — download</title>
<style>
  body{font-family:system-ui,Segoe UI,Roboto,Arial,sans-serif;background:#f4f1eb;color:#2a2a2a;margin:0;display:flex;min-height:100vh;align-items:center;justify-content:center}
  .card{background:#fff;border:1px solid #e3ddd0;border-radius:14px;padding:34px 38px;max-width:460px;width:100%;box-shadow:0 6px 24px rgba(0,0,0,.06)}
  h1{margin:0 0 4px;font-size:22px}
  .ver{color:#8a8a8a;font-size:13px;margin-bottom:18px}
  .notes{background:#f7f4ec;border-radius:8px;padding:10px 12px;font-size:13px;color:#5a554a;margin-bottom:18px}
  .btn{display:block;width:100%;box-sizing:border-box;text-align:center;text-decoration:none;font-weight:600;font-size:15px;padding:13px 16px;border-radius:9px;margin:8px 0;color:#fff;background:#4f46e5;transition:transform .05s ease,opacity .15s ease}
  .btn:hover{opacity:.92}
  .btn:active{transform:translateY(1px)}
  .btn.alt{background:#2f3136}
  .btn[hidden]{display:none}
  .muted{color:#9a958a;font-size:12px;text-align:center;margin-top:14px}
  .other{text-align:center;margin-top:10px;font-size:12px}
  .other a{color:#4f46e5}
</style>
</head>
<body>
  <div class="card">
    <h1>Knot — private P2P chat</h1>
    <div class="ver">Latest version: ${version}</div>
    ${notes ? `<div class="notes">${escapeHtml(notes)}</div>` : ''}
    <a class="btn" id="win" href="${escapeHtml(winUrl || '#')}" download>Download for Windows</a>
    <a class="btn alt" id="linux" href="${escapeHtml(linuxUrl || '#')}" download>Download for Linux</a>
    <div class="other" id="other"></div>
    <div class="muted">Your system was detected automatically. Pick the other link if that's wrong.</div>
  </div>
  <script>
    (function(){
      var isLinux = /linux|x11/i.test(navigator.platform) || /linux/i.test(navigator.userAgent);
      var win = document.getElementById('win');
      var linux = document.getElementById('linux');
      var other = document.getElementById('other');
      function showAlternate(prefix, link, label) {
        var anchor = document.createElement('a');
        anchor.href = link.getAttribute('href') || '#';
        anchor.setAttribute('download', '');
        anchor.textContent = label;
        other.replaceChildren(document.createTextNode(prefix), anchor, document.createTextNode('.'));
      }
      if (isLinux) {
        win.hidden = true;
        showAlternate('Not on Linux? ', win, 'Get Windows instead');
      } else {
        linux.hidden = true;
        showAlternate('Not on Windows? ', linux, 'Get Linux instead');
      }
    })();
  </script>
</body>
</html>`;
}

function escapeHtml(s) {
  return String(s).replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
}

function requestHandler(req, res) {
  try {
    res.setHeader('X-Content-Type-Options', 'nosniff');
    res.setHeader('Referrer-Policy', 'no-referrer');
    res.setHeader('X-Frame-Options', 'DENY');
    res.setHeader('Content-Security-Policy', "default-src 'none'; style-src 'unsafe-inline'; script-src 'unsafe-inline'; img-src 'self'; base-uri 'none'; frame-ancestors 'none'");
    if (req.method !== 'GET' && req.method !== 'HEAD') { res.writeHead(405, { 'Content-Type': 'text/plain', Allow: 'GET, HEAD' });res.end('Method not allowed');return; }
    const head=req.method==='HEAD';
    const urlPath = decodeURIComponent((req.url || '/').split('?')[0]);
    if (urlPath === '/' || urlPath === '/index.html') {
      const manifest = readManifest();
      // Human-facing landing page: lists both installers and auto-highlights the
      // one matching the visitor's OS (the page also re-checks client-side).
      const page = buildLandingPage(manifest);
      res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8', 'Cache-Control': 'no-store' });
      res.end(head?'':page);
      return;
    }
    if (urlPath === '/download') {
      const manifest = readManifest();
      const ua = (req.headers['user-agent'] || '').toLowerCase();
      const isLinux = /linux|x11/.test(ua);
      const url = manifest ? safeDownloadUrl(isLinux ? manifest.linuxUrl : manifest.winUrl) : null;
      if (!url) {
        res.writeHead(404, { 'Content-Type': 'text/plain' });
        res.end('No update published yet.');
        return;
      }
      res.writeHead(302, { 'Location': url });
      res.end();
      return;
    }
    const rel = path.normalize(urlPath).replace(/^(\.\.[\/\\])+/, '');
    const file = path.join(PUBLIC_DIR, rel);
    // Contain path traversal: the resolved file must live inside PUBLIC_DIR and
    // not in a same-prefix sibling (e.g. PUBLIC_DIR="…/public" must not match
    // "…/public_notes"). Require a path separator after the resolved base.
    const base = path.resolve(PUBLIC_DIR);
    const resolved = path.resolve(file);
    let stat,realBase,realFile;try{stat=fs.statSync(file);realBase=fs.realpathSync(PUBLIC_DIR);realFile=fs.realpathSync(file)}catch{}
    if ((resolved !== base && !resolved.startsWith(base + path.sep)) || !stat || !stat.isFile() || (realFile!==realBase&&!realFile?.startsWith(realBase+path.sep))) {
      res.writeHead(404, { 'Content-Type': 'text/plain' });
      res.end('Not found');
      return;
    }
    const ext = path.extname(file).toLowerCase(),headers={ 'Content-Type': MIME[ext] || 'application/octet-stream', 'Accept-Ranges': 'bytes', 'Cache-Control': urlPath==='/latest.json'?'no-store':'public, max-age=3600' };
    let start=0,end=Math.max(0,stat.size-1),status=200;const range=String(req.headers.range||'');
    if(range){const match=/^bytes=(\d*)-(\d*)$/.exec(range);if(!match||(!match[1]&&!match[2])){res.writeHead(416,{...headers,'Content-Range':`bytes */${stat.size}`});res.end();return}if(match[1]){start=Number(match[1]);end=match[2]?Number(match[2]):end}else{const suffix=Number(match[2]);start=Math.max(0,stat.size-suffix)}if(!Number.isSafeInteger(start)||!Number.isSafeInteger(end)||start<0||start>=stat.size||end<start){res.writeHead(416,{...headers,'Content-Range':`bytes */${stat.size}`});res.end();return}end=Math.min(end,stat.size-1);status=206;headers['Content-Range']=`bytes ${start}-${end}/${stat.size}`}
    headers['Content-Length']=stat.size?end-start+1:0;res.writeHead(status,headers);
    if(head){res.end();return}
    const rs=fs.createReadStream(file,stat.size?{start,end}:undefined);rs.on('error',()=>{try{res.end()}catch{}});res.on('close',()=>rs.destroy());rs.pipe(res);
  } catch (e) {
    res.writeHead(500, { 'Content-Type': 'text/plain' });
    res.end('Error');
  }
}

// Public deployments must provide a certificate so clients can use wss://.
// Plain HTTP is retained only for a loopback development server.
const tlsKey = process.env.PAIR_TLS_KEY;
const tlsCert = process.env.PAIR_TLS_CERT;
const tlsEnabled = !!(tlsKey && tlsCert);
const httpServer = tlsEnabled
  ? https.createServer({ key: fs.readFileSync(tlsKey), cert: fs.readFileSync(tlsCert) }, requestHandler)
  : http.createServer(requestHandler);

// The relay only carries setup/control data and bounded file frames. TLS belongs
// at a reverse proxy; Knot clients require wss:// for non-local signaling.
const wss = new WebSocket.Server({ server: httpServer, maxPayload: 2 * 1024 * 1024, perMessageDeflate: false });
const MAX_ROOM_PEERS = 2;
const MAX_SOCKET_BYTES_PER_SECOND = 128 * 1024 * 1024;
const MAX_SOCKET_MESSAGES_PER_SECOND = 240;
const MAX_LIVE_CLIENTS = 4096;
const RELAY_BUFFER_HIGH = 16 * 1024 * 1024;
const RELAY_BUFFER_LOW = 4 * 1024 * 1024;
const roomJoinLimiter = new RoomJoinLimiter();
function withinRate(socket, bytes) {
  const now = Date.now();
  if (!socket._rateAt || now - socket._rateAt >= 1000) { socket._rateAt = now; socket._rateBytes = 0;socket._rateMessages=0; }
  socket._rateBytes = (socket._rateBytes || 0) + bytes;
  socket._rateMessages = (socket._rateMessages || 0) + 1;
  return socket._rateBytes <= MAX_SOCKET_BYTES_PER_SECOND&&socket._rateMessages<=MAX_SOCKET_MESSAGES_PER_SECOND;
}

function leave(socket) {
  if (!socket.room) return;
  const peers = rooms.get(socket.room) || [];
  const remaining = peers.filter(peer => peer !== socket);
  if (remaining.length) rooms.set(socket.room, remaining);
  else rooms.delete(socket.room);
  socket.room = null;
  if(socket._relayPauseTimer){clearInterval(socket._relayPauseTimer);socket._relayPauseTimer=null}
  try{socket._socket?.resume()}catch{}
}

function relaySend(source,peer,data,isBinary=false){
  try{
    peer.send(data,{binary:isBinary},error=>{if(error)try{peer.terminate()}catch{}});
    if(peer.bufferedAmount<=RELAY_BUFFER_HIGH||source._relayPauseTimer)return true;
    try{source._socket?.pause()}catch{}
    source._relayPauseTimer=setInterval(()=>{if(peer.readyState!==WebSocket.OPEN||peer.bufferedAmount<=RELAY_BUFFER_LOW){clearInterval(source._relayPauseTimer);source._relayPauseTimer=null;try{source._socket?.resume()}catch{}}},25);source._relayPauseTimer.unref?.();
    return true;
  }catch{try{peer.terminate()}catch{};return false}
}

// Sweep rooms that have only a non-open socket left (covers the rare case where
// a 'close' event never fired, e.g. a dropped TCP connection). Without this the
// rooms map could retain a single-member entry indefinitely.
setInterval(() => {
  for (const [name, peers] of rooms) {
    const live = peers.filter(p => p.readyState === WebSocket.OPEN);
    if (live.length) rooms.set(name, live);
    else rooms.delete(name);
  }
}, 60000).unref();
setInterval(() => roomJoinLimiter.sweep(), DEFAULT_JOIN_WINDOW_MS).unref();

wss.on('connection', (socket, request) => {
  if(wss.clients.size>MAX_LIVE_CLIENTS){try{socket.close(1013,'server busy')}catch{};return}
  socket._joinAddress = signalingJoinAddress(socket, request);
  socket._alive=true;socket.on('pong',()=>{socket._alive=true});
  socket.on('message', (raw, isBinary) => {
    if (!withinRate(socket, raw.length || 0)) { try { socket.close(1008, 'rate limit'); } catch {} return; }
    // Binary frames are file-stream chunks; relay them verbatim to the peer.
    if (isBinary) {
      if (!socket.room || !socket.room.toLowerCase().endsWith(':stream')) return;
      for (const peer of rooms.get(socket.room) || []) {
        if (peer !== socket && peer.readyState === WebSocket.OPEN) relaySend(socket,peer,raw,true);
      }
      return;
    }
    let message;
    try { message = JSON.parse(raw.toString()); } catch { return; }
    if (message.type === 'join' && typeof message.room === 'string') {
      if (!roomJoinLimiter.allow(socket)) { try { socket.close(1008, 'join rate limit'); } catch {} return; }
      leave(socket);
      const room = message.room.trim().toUpperCase();
      if (!validSignalingRoom(room)) { socket.send(JSON.stringify({ type: 'error', message: 'Signaling sessions require a private 24–64 character capability.' })); return; }
      const peers = (rooms.get(room) || []).filter(peer=>peer.readyState===WebSocket.OPEN);
      if (peers.length >= MAX_ROOM_PEERS) { try{socket.send(JSON.stringify({ type: 'full' }),()=>socket.close(1008,'room full'))}catch{try{socket.close(1008,'room full')}catch{}}return; }
      socket.room = room;
      peers.push(socket);
      rooms.set(room, peers);
      socket.send(JSON.stringify({ type: 'joined', count: peers.length }));
      if (peers.length === 2) peers.forEach(peer => peer.send(JSON.stringify({ type: 'peer-ready' })));
      return;
    }
    if (socket.room && message.type === 'signal') {
      // Relay signaling + any other JSON control messages to the peer.
      for (const peer of rooms.get(socket.room) || []) {
        if (peer !== socket && peer.readyState === WebSocket.OPEN) relaySend(socket,peer,JSON.stringify(message),false);
      }
    }
  });
  socket.on('close', () => leave(socket));
  socket.on('error', () => leave(socket));
});

// WebSocket readyState can remain OPEN for a severed Wi-Fi/TCP path until the
// operating system times it out. Ping once per 30 seconds so abandoned rooms
// and their buffers are reclaimed promptly.
setInterval(()=>{for(const socket of wss.clients){if(socket._alive===false){leave(socket);try{socket.terminate()}catch{};continue}socket._alive=false;try{socket.ping()}catch{leave(socket);try{socket.terminate()}catch{}}}},30000).unref();

httpServer.on('error', err => {
  if (err.code === 'EADDRINUSE') {
    console.warn(`Port ${port} is already in use — another Knot server or process is listening. Signaling will rely on that instance; this app will not start its own.`);
    return;
  }
  // Any other listen error is logged, not thrown, so it can't crash the whole
  // Electron app (server.js is required by main.js). The app still runs; it
  // just won't serve signaling/update files on this port.
  console.error(`Knot server failed to start on port ${port}:`, err.message);
});

// Non-TLS signaling is intentionally loopback-only. Remote peers must use TLS
// (or a TLS reverse proxy), which keeps room codes and signaling metadata off a
// local network observer.
const requestedBind=String(process.env.PAIR_BIND||''),loopback=/^(?:localhost|127(?:\.\d{1,3}){3}|::1)$/i.test(requestedBind);
const bindHost = !tlsEnabled&&requestedBind&&!loopback?'127.0.0.1':requestedBind||(tlsEnabled?'0.0.0.0':'127.0.0.1');
if(!tlsEnabled&&requestedBind&&!loopback)console.warn('PAIR_BIND requested a non-loopback address without TLS; Knot is binding to 127.0.0.1 instead.');
httpServer.listen(port, bindHost, () => {
  console.log(`Knot server listening on ${tlsEnabled ? 'https' : 'http'}://${bindHost}:${port} (signaling + update feed)`);
});
console.log(`Knot signaling server ready for ${tlsEnabled ? 'wss' : 'ws'} connections on ${bindHost}:${port}`);
