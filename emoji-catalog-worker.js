const { parentPort, workerData } = require('worker_threads');
const emojiCatalog = require('./emoji-catalog');

if (typeof workerData?.root === 'string' && workerData.root) process.env.KNOT_EMOJI_CATALOG = workerData.root;
emojiCatalog.init({ isPackaged: false, getPath: () => '' });

const METHODS = new Set(['search', 'get', 'attributions', 'stats']);
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
