const { parentPort, workerData } = require('worker_threads');
const emojiCatalog = require('./emoji-catalog');

emojiCatalog.init(null, { cacheRoot: workerData?.root, readOnly: true });

const METHODS = new Set(['search', 'get', 'stats']);
parentPort.on('message', message => {
  const id = Number(message?.id), method = String(message?.method || '');
  if (!Number.isSafeInteger(id)) return;
  if (!METHODS.has(method)) {
    parentPort.postMessage({ id, error: 'Emoji catalog method is not allowed' });
    return;
  }
  try {
    const args = Array.isArray(message.args) ? message.args : [];
    parentPort.postMessage({ id, value: emojiCatalog[method](...args) });
  } catch (error) {
    parentPort.postMessage({ id, error: error?.message || String(error) });
  }
});
