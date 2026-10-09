'use strict';

// AV1 decoding on the GPU for Linux with an NVIDIA card, where Chromium cannot do it: its hardware decoder works on this hardware
// but the pictures cannot be handed to the page (every hardware-decoded picture arrives black), so the viewer used to decode on the CPU.
// This runs NVIDIA's own decoder (NVDEC) in a small separate program, native/nvdec/knot-nvdec.c, built by scripts/build-nvdec-helper.sh:
//
//   encoded pictures -> knot-nvdec (NVDEC decodes, and scales to the size the viewer is shown at) -> raw NV12 pictures -> the page
//
// The scaling is only for display: the page would scale the picture to the size of its view anyway, and doing it on the GPU first
// keeps the copy between processes small (a 4K picture is 12 MB, the same picture at 1600x900 is 2 MB). Measured on an RTX 4090 for a
// 4K60 stream: every picture arrives about 45 ms after it was handed over, and the decode costs a third of one CPU core instead of two.
// Unlike `ffmpeg -c:v av1_cuvid` the helper holds nothing back: a picture is out the moment the GPU has it, so a screen that stops
// changing still shows its last change.
//
// Nothing here is trusted to be right: the player checks the first picture against a software decode and goes back to the CPU decoder
// on a mismatch, an error, or a helper that stops answering. If the helper is missing or the machine has no NVDEC, probeNvdec() says so
// and the viewer decodes on the CPU as before.
const { spawn } = require('child_process');
const { EventEmitter } = require('events');
const fs = require('fs');
const path = require('path');

// Two 256x144 AV1 pictures (a key picture and one that follows it): the smallest honest test that the GPU can decode AV1 here.
const PROBE_IVF = Buffer.from('REtJRgAAIABBVjAxAAGQAB4AAAABAAAAAgAAAAAAAABkAQAAAAAAAAAAAAASAAoLAgAABV3/48avmAQy0gIQAI4AgggQQE+8As2i/P1pqOCgDyFkv9O36XxvQ4/6NMHDq32tNT4PxObf6bW3QdqYRryPH37n45a0/GeJAEht8AmvmDefDpW4q+MNdEL8FA7iDCz5V4Dm1XIOgqH/XcBQx8gt+OkevOIDOVgcq5TvXRtn/v/EWwM0PYVJ2YKQRF8hIVsAiY7T7AXpSwRvXQG+RMJx3GEU8a4HG9LDIKtfCnx8ozfXq8IGn3mgBatOnUg9FMhrBIUnJE70T9esevVL96WGLEYe7DZ2BhDNoA2GdsPgklx5e8pcRnWeYWC1/UqufMjnOGMLQd0pFbheR+IRpnWYaJrabDD3DkR5LMlvl5DFIAhNcb2IRsoLJ/hOeIb3pPrcXZXjhmwxB0LbF7DIHEt9RNe8s8UhkD9zc66WqOSZL6VM/vcfDZCvxNQ7NoIrtKQIny7xvS4CXlfZRDHuoBgAAAABAAAAAAAAABIAMhQwAgAAAAA6WgAAAR8AAACCeFKCpA==', 'base64');
const HELPER_NAME = 'knot-nvdec';
const FRAME_HEADER = 16;
const MAX_QUEUED_BYTES = 48 * 1024 * 1024;       // what may wait for the helper before it is called too slow
const MAX_SESSIONS_PER_OWNER = 4;
const MAX_SIDE = 8192, MIN_SIDE = 128;           // the decoder's own limits for AV1
const MAX_PICTURE_BYTES = 64 * 1024 * 1024;
const STOP_TERM_WAIT_MS = 800;
const STOP_KILL_WAIT_MS = 2000;
const PROBE_RETRY_MS = 30000;                    // a check that failed for a reason that may pass (it timed out, it could not start) is asked again after this

const even = value => Math.max(2, Math.floor(Number(value) / 2) * 2);

// The pictures of an IVF file, for the probe's sample and for tests.
function ivfPictures(data) {
  const pictures = [];
  for (let at = data.readUInt16LE(6); at + 12 <= data.length;) { const size = data.readUInt32LE(at); pictures.push(data.subarray(at + 12, at + 12 + size)); at += 12 + size; }
  return pictures;
}

// What goes in front of each picture on the helper's stdin.
function packetHeader(pts, size) {
  const header = Buffer.allocUnsafe(12);
  header.writeUInt32LE(size, 0); header.writeBigUInt64LE(BigInt(Math.max(0, Math.round(pts))), 4);
  return header;
}

// Where the helper is: next to the app's other native resources when packaged, in vendor/ when run from source, or where KNOT_NVDEC says.
function findHelper({ env = process.env, resourcesPath = process.resourcesPath, root = __dirname, fsImpl = fs } = {}) {
  const candidates = [];
  if (env.KNOT_NVDEC) candidates.push(env.KNOT_NVDEC);
  if (resourcesPath) candidates.push(path.join(resourcesPath, HELPER_NAME, HELPER_NAME));
  candidates.push(path.join(root, 'vendor', HELPER_NAME, HELPER_NAME));
  for (const candidate of candidates) {
    try { fsImpl.accessSync(candidate, fs.constants.X_OK); if (fsImpl.statSync(candidate).isFile()) return candidate; } catch {}
  }
  return '';
}

// One running decoder. 'frame' ({ pts, width, height, data }) fires for every decoded picture, in order; `data` is only valid during the
// call, so a listener must copy or send it before returning. 'error' (Error) then 'end' when it fails or is stopped.
class NvdecSession extends EventEmitter {
  constructor({ helper, outWidth = 0, outHeight = 0, spawnImpl = spawn, maxQueuedBytes = MAX_QUEUED_BYTES } = {}) {
    super();
    Object.assign(this, { helper, spawnImpl, maxQueuedBytes });
    this.outWidth = outWidth ? even(outWidth) : 0; this.outHeight = outHeight ? even(outHeight) : 0;
    this.child = null; this.stopping = false; this.stopped = null; this.stderr = '';
    this.inputs = 0; this.outputs = 0; this.queued = 0; this.ended = false;
    this.header = Buffer.allocUnsafe(FRAME_HEADER); this.headerFilled = 0; this.frame = null; this.frameFilled = 0; this.current = null;
  }

  get pending() { return this.inputs - this.outputs; }

  start() {
    if (this.child) return;
    const child = this.spawnImpl(this.helper, [String(this.outWidth), String(this.outHeight)], { stdio: ['pipe', 'pipe', 'pipe'] });
    this.child = child;
    child.stdin.on('error', () => {});
    child.stderr.on('data', chunk => { this.stderr = (this.stderr + chunk.toString()).slice(-2048); });
    child.stdout.on('data', chunk => this._read(chunk));
    let finished = false;
    const finish = (code, signal, spawnError) => {
      if (finished) return; finished = true; this.child = null;
      if (!this.stopping) {
        const said = this.stderr.trim().split('\n').filter(Boolean).at(-1) || '';
        const reason = spawnError?.message || said || (code ? `the GPU decoder exited with code ${code}` : signal ? `the GPU decoder was stopped by ${signal}` : 'the GPU decoder stopped');
        this.emit('error', new Error(reason));
      }
      this.ended = true; this.emit('end'); this.stopped?.resolve();
    };
    child.on('error', error => finish(null, null, error));
    child.on('close', (code, signal) => finish(code, signal));
  }

  // One encoded picture (an AV1 temporal unit; a key picture first). Returns false once the helper is no longer taking pictures.
  push(pts, data) {
    const child = this.child;
    if (!child || this.stopping || !child.stdin.writable || !data?.byteLength) return false;
    const bytes = Buffer.from(data.buffer, data.byteOffset, data.byteLength), size = bytes.length + 12;
    this.inputs++; this.queued += size;
    child.stdin.write(packetHeader(pts, bytes.length)); child.stdin.write(bytes, () => { this.queued -= size; });
    if (this.queued > this.maxQueuedBytes) { this.emit('error', new Error('The GPU decoder is not keeping up')); this.stop(); return false; }
    return true;
  }

  _read(chunk) {
    let at = 0;
    while (at < chunk.length) {
      if (!this.frame) {
        const take = Math.min(FRAME_HEADER - this.headerFilled, chunk.length - at);
        chunk.copy(this.header, this.headerFilled, at, at + take); this.headerFilled += take; at += take;
        if (this.headerFilled < FRAME_HEADER) break;
        const width = this.header.readUInt32LE(0), height = this.header.readUInt32LE(4), bytes = width * height * 3 / 2;
        if (!width || !height || bytes > MAX_PICTURE_BYTES) { this.emit('error', new Error('The GPU decoder sent a picture of impossible size')); this.stop(); return; }
        this.current = { width, height, pts: Number(this.header.readBigUInt64LE(8)) };
        this.frame = Buffer.allocUnsafe(bytes); this.frameFilled = 0; this.headerFilled = 0;
      }
      const take = Math.min(this.frame.length - this.frameFilled, chunk.length - at);
      chunk.copy(this.frame, this.frameFilled, at, at + take); this.frameFilled += take; at += take;
      if (this.frameFilled === this.frame.length) {
        const picture = { ...this.current, data: this.frame };
        this.frame = null; this.outputs++;
        if (!this.stopping) this.emit('frame', picture);
      }
    }
  }

  stop() {
    if (this.stopped) return this.stopped.promise;
    let resolve; const promise = new Promise(done => { resolve = done; });
    this.stopped = { promise, resolve };
    const child = this.child;
    if (!child) { resolve(); return promise; }
    this.stopping = true;
    try { child.stdin.end(); } catch {}
    const term = setTimeout(() => { try { child.kill('SIGTERM'); } catch {} }, STOP_TERM_WAIT_MS);
    const kill = setTimeout(() => { try { child.kill('SIGKILL'); } catch {} resolve(); }, STOP_KILL_WAIT_MS);
    promise.then(() => { clearTimeout(term); clearTimeout(kill); });
    return promise;
  }
}

// Can this machine decode AV1 on its GPU? Asks the helper about the GPU, then really decodes the sample through it.
// Never throws: a machine without it just gets { available: false, reason }.
async function probeNvdec({ helper = findHelper(), spawnImpl = spawn, timeoutMs = 10000, platform = process.platform } = {}) {
  if (platform !== 'linux') return { available: false, reason: 'GPU decoding through NVDEC is only used on Linux', helper: '', permanent: true };
  if (!helper) return { available: false, reason: 'the GPU decoder helper (knot-nvdec) is not installed', helper: '', permanent: true };
  const run = (args, input) => new Promise(resolve => {
    const out = []; let err = '', done = false, child;
    const finish = result => { if (done) return; done = true; clearTimeout(timer); try { child?.kill('SIGKILL'); } catch {} resolve(result); };
    const timer = setTimeout(() => finish({ ok: false, why: 'it did not answer in time', out: Buffer.concat(out), err }), timeoutMs);
    try { child = spawnImpl(helper, args, { stdio: ['pipe', 'pipe', 'pipe'] }); } catch (error) { return finish({ ok: false, why: error.message, spawnFailed: true, out: Buffer.alloc(0), err }); }
    child.on('error', error => finish({ ok: false, why: error.message, spawnFailed: true, out: Buffer.alloc(0), err }));
    child.stdout.on('data', chunk => { out.push(chunk); if (input && Buffer.concat(out).length >= 256 * 144 * 3 / 2 + FRAME_HEADER) finish({ ok: true, out: Buffer.concat(out), err }); });
    child.stderr.on('data', chunk => { err = (err + chunk).slice(-1024); });
    child.stdin.on('error', () => {});
    child.on('close', code => finish({ ok: code === 0, out: Buffer.concat(out), err }));
    if (input) { for (const picture of input) { child.stdin.write(packetHeader(0, picture.length)); child.stdin.write(picture); } } else child.stdin.end();
  });
  const said = result => result.err.trim().split('\n').filter(Boolean).at(-1) || result.why || 'unknown error';
  const caps = await run(['--probe']);
  // Only an answer from the GPU itself ("no AV1 here") is final. A helper that could not start or did not answer in time (a machine busy with a game
  // at launch) is asked again later: caching that for the whole run left the viewer on the CPU decoder until Knot was restarted.
  if (caps.spawnFailed) return { available: false, reason: `the GPU decoder helper could not start (${caps.why})`, helper, permanent: false };
  if (!caps.ok) return { available: false, reason: `this GPU cannot decode AV1 (${said(caps)})`, helper, permanent: !/did not answer in time/.test(caps.why || '') };
  const gpu = caps.out.toString().trim().replace(/^ok\s+/, '');
  const test = await run(['0', '0'], ivfPictures(PROBE_IVF).slice(0, 1));
  if (test.out.length < FRAME_HEADER || test.out.readUInt32LE(0) !== 256 || test.out.readUInt32LE(4) !== 144) return { available: false, reason: `the GPU could not decode a test picture (${said(test)})`, helper, permanent: false };
  return { available: true, reason: '', helper, gpu };
}

// Sessions that belong to a document (the renderer that asked for them) and end with it, like the share lanes and the recorder.
class ShareDecodeRuntime {
  constructor({ sameOwner, onFrame, onError, onEnd, helper = '', spawnImpl = spawn, probe = probeNvdec, makeSession = options => new NvdecSession(options), now = Date.now, retryMs = PROBE_RETRY_MS } = {}) {
    Object.assign(this, { sameOwner, onFrame, onError, onEnd, spawnImpl, probe, makeSession, now, retryMs });
    this.helper = helper; this.info = null; this.infoRetryAt = 0; this.sessions = new Map(); this.nextId = 1;
  }

  // Cached, because asking costs a process start: a yes, and a no that is final (this GPU cannot decode AV1, there is no helper). A no that may pass
  // (the helper timed out or could not start) is asked again once retryMs has gone by.
  availability() {
    if (this.info && this.infoRetryAt && this.now() >= this.infoRetryAt) { this.info = null; this.infoRetryAt = 0; }
    if (!this.info) {
      this.info = this.probe({ helper: this.helper || findHelper(), spawnImpl: this.spawnImpl }).then(result => {
        if (result.available) this.helper = result.helper;
        else if (result.permanent !== true) this.infoRetryAt = this.now() + this.retryMs;
        return result;
      });
    }
    return this.info;
  }

  async open(owner, { width, height, outWidth, outHeight } = {}) {
    const sides = [width, height, outWidth, outHeight];
    if (!sides.every(value => Number.isInteger(value) && value >= MIN_SIDE && value <= MAX_SIDE)) throw new Error('invalid decode size');
    if (outWidth > width || outHeight > height) throw new Error('the decoder only makes pictures smaller');
    const mine = [...this.sessions.values()].filter(entry => this.sameOwner(entry.owner, owner));
    if (mine.length >= MAX_SESSIONS_PER_OWNER) throw new Error('too many decoders open');
    const info = await this.availability();
    if (!info.available) throw new Error(info.reason);
    const id = this.nextId++;
    const session = this.makeSession({ helper: this.helper, outWidth, outHeight, spawnImpl: this.spawnImpl });
    const entry = { owner, session };
    this.sessions.set(id, entry);
    session.on('frame', picture => { if (this.sessions.get(id) === entry) this.onFrame({ owner, id, picture }); });
    session.on('error', error => { if (this.sessions.get(id) === entry) this.onError({ owner, id, error }); });
    session.on('end', () => { if (this.sessions.get(id) === entry) { this.sessions.delete(id); this.onEnd({ owner, id }); } });
    session.start();
    return { id, outWidth: session.outWidth, outHeight: session.outHeight };
  }

  push(owner, id, pts, data) {
    const entry = this.sessions.get(id);
    return !!entry && this.sameOwner(entry.owner, owner) && entry.session.push(pts, data);
  }

  close(owner, id) {
    const entry = this.sessions.get(id);
    if (!entry || !this.sameOwner(entry.owner, owner)) return Promise.resolve(false);
    this.sessions.delete(id);
    return entry.session.stop().then(() => true);
  }

  async closeAll() {
    const all = [...this.sessions.values()]; this.sessions.clear();
    await Promise.all(all.map(entry => entry.session.stop()));
  }
}

module.exports = { NvdecSession, ShareDecodeRuntime, probeNvdec, findHelper, ivfPictures, packetHeader, even, PROBE_IVF, HELPER_NAME, MAX_SIDE, MIN_SIDE };
