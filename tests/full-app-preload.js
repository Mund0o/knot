const { ipcRenderer } = require('electron');

// Keep the endurance test self-contained. The real directory connection is not
// part of the screen-share workload and would make the test depend on internet
// state, but the complete renderer/UI still boots and runs normally.
class OfflineWebSocket {
  static CONNECTING = 0;
  static OPEN = 1;
  static CLOSING = 2;
  static CLOSED = 3;
  constructor(url) {
    this.url = String(url || '');
    this.readyState = OfflineWebSocket.CLOSED;
    this.bufferedAmount = 0;
  }
  send() {}
  close() { this.readyState = OfflineWebSocket.CLOSED; }
  addEventListener() {}
  removeEventListener() {}
}

window.WebSocket = OfflineWebSocket;
ipcRenderer.on('knot-full-segment', async (_event, item, ackId) => {
  try {
    await window.__knotFullSegment?.(item);
    ipcRenderer.send('knot-full-segment-ack', { ackId, ok: true });
  } catch (error) {
    ipcRenderer.send('knot-full-segment-ack', { ackId, ok: false, error: String(error?.message || error) });
  }
});
ipcRenderer.on('knot-full-finish', () => window.__knotFullFinish?.());
