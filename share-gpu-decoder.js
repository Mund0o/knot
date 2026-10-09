(function installShareGpuDecoder(root, factory) {
  const api = factory(root);
  if (typeof module === 'object' && module.exports) module.exports = api;
  if (root) root.KnotShareGpuDecoder = api;
})(typeof window === 'object' ? window : typeof globalThis === 'object' ? globalThis : null, root => {
  // The part of a VideoDecoder that the share player uses, backed by the GPU decoder helper the main process runs (share-decode-nvdec.js,
  // reached through window.pairShareDecode). The player hands it encoded pictures and gets VideoFrames back in the same order, so
  // everything built on a VideoDecoder (queueing, the playout clock, the check of the first picture, the fall back to the CPU) works the same.
  //
  // The pictures come back already scaled to the size they are shown at (see GPU_MAX_PIXELS in the player), as raw NV12; a VideoFrame is
  // made from each with the stream's own size as its display size, so the page still treats it as the full picture.

  class GpuDecoder {
    constructor(bridge, { output, error }) {
      this.bridge = bridge; this.output = output; this.error = error;
      this.id = 0; this.closed = false; this.waiting = []; this.submitted = 0; this.returned = 0; this.native = { width: 0, height: 0 }; this.opening = null;
      this.hooks = [
        bridge.onFrame((id, meta, bytes) => this._frame(id, meta, bytes)),
        bridge.onError((id, message) => { if (id === this.id && !this.closed) this._fail(new Error(message)); }),
        bridge.onEnd(id => { if (id === this.id && !this.closed) this._fail(new Error('The GPU decoder stopped')); }),
      ];
    }

    // { codedWidth, codedHeight }: the stream's size; { outWidth, outHeight }: the size of the pictures wanted back.
    configure({ codedWidth, codedHeight, outWidth, outHeight }) {
      this.native = { width: codedWidth, height: codedHeight };
      this.opening = Promise.resolve(this.bridge.open({ width: codedWidth, height: codedHeight, outWidth, outHeight })).then(result => {
        if (this.closed) { if (result?.ok) this.bridge.close(result.id); return; }
        if (!result?.ok) { this._fail(new Error(result?.error || 'The GPU decoder could not start')); return; }
        this.id = result.id;
        for (const item of this.waiting.splice(0)) this._send(item);
      }, cause => { if (!this.closed) this._fail(cause instanceof Error ? cause : new Error(String(cause))); });
    }

    // chunk: { timestamp, data }. Pictures given before the helper has started wait for it.
    decode(chunk) {
      if (this.closed) return;
      this.submitted++;
      if (this.id) this._send(chunk); else this.waiting.push(chunk);
    }

    get decodeQueueSize() { return Math.max(0, this.submitted - this.returned); }

    // The helper holds nothing back, so there is nothing to wait for.
    flush() { return Promise.resolve(); }

    close() {
      if (this.closed) return;
      this.closed = true; this.waiting = [];
      for (const off of this.hooks) { try { off(); } catch {} }
      if (this.id) this.bridge.close(this.id);
    }

    _send(chunk) { if (!this.bridge.push(this.id, chunk.timestamp, chunk.data)) this._fail(new Error('The GPU decoder refused a picture')); }

    _frame(id, meta, bytes) {
      if (id !== this.id || this.closed) return;
      this.returned++;
      let frame;
      try {
        frame = new VideoFrame(bytes, { format: 'NV12', codedWidth: meta.width, codedHeight: meta.height, timestamp: meta.pts,
          displayWidth: this.native.width || meta.width, displayHeight: this.native.height || meta.height });
      } catch (cause) { this._fail(cause instanceof Error ? cause : new Error(String(cause))); return; }
      try { this.output(frame); } catch { try { frame.close(); } catch {} }
    }

    _fail(cause) { if (this.closed) return; try { this.error(cause); } catch {} }
  }

  // What the player is given. `usable()` is true once the main process has said this machine can decode on its GPU and the user has not
  // switched it off; until then (or without a bridge at all) the player decodes the way it always did.
  function createGpuDecode({ bridge = root && root.pairShareDecode, enabled = () => true, now = () => Date.now(), retryMs = 30000 } = {}) {
    const state = { info: null, checking: null, checkedAt: 0, retrying: false };
    const check = () => {
      if (!bridge || typeof bridge.info !== 'function') return Promise.resolve({ available: false, reason: 'not available in this build', permanent: true });
      if (!state.checking) state.checking = Promise.resolve(bridge.info()).then(info => (state.info = info || { available: false, reason: 'no answer' }), () => (state.info = { available: false, reason: 'the GPU decoder could not be asked' })).then(info => { state.checkedAt = now(); return info; });
      return state.checking;
    };
    // A "no" that may pass (the check timed out while the machine was busy) is asked again in the background once retryMs has gone by, so the player, which
    // looks at usable() every half second, can move to the GPU decoder when it turns out to be there. A final "no" is never asked again.
    const retryDue = () => !!state.info && !state.info.available && state.info.permanent !== true && !state.retrying && now() - state.checkedAt >= retryMs;
    return {
      check,
      get info() { return state.info; },
      usable() {
        if (enabled() && retryDue()) { state.retrying = true; state.checking = null; check().then(() => { state.retrying = false; }, () => { state.retrying = false; }); }
        return !!state.info?.available && !!enabled();
      },
      create(handlers) { return new GpuDecoder(bridge, handlers); },
    };
  }

  return { createGpuDecode, GpuDecoder };
});
