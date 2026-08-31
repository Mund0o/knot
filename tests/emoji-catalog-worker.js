const assert = require('assert');
const fs = require('fs');
const path = require('path');
const { Worker } = require('worker_threads');

const root = path.join(__dirname, '..');
const catalogRoot = path.join(root, 'emoji-catalog');
const database = path.join(catalogRoot, 'manifest', 'catalog.db');

if (!fs.existsSync(database)) {
  console.log('SKIP emoji worker checks (no catalog yet)');
  process.exit(0);
}

const worker = new Worker(path.join(root, 'emoji-catalog-worker.js'), { workerData: { root: catalogRoot } });
let sequence = 0;
const pending = new Map();
worker.on('message', message => {
  const request = pending.get(message.id);
  if (!request) return;
  pending.delete(message.id);
  message.error ? request.reject(new Error(message.error)) : request.resolve(message.value);
});
worker.on('error', error => {
  for (const request of pending.values()) request.reject(error);
  pending.clear();
});
function call(method, ...args) {
  const id = ++sequence;
  return new Promise((resolve, reject) => {
    pending.set(id, { resolve, reject });
    worker.postMessage({ id, method, args });
  });
}

(async () => {
  try {
    // "smile" generally exercises the bounded fuzzy scan over the complete
    // catalog. A timer must continue firing while that CPU work happens.
    let eventLoopTicks = 0;
    const ticker = setInterval(() => eventLoopTicks++, 1);
    const result = await Promise.race([
      call('search', { q: 'smile', limit: 60 }),
      new Promise((_, reject) => setTimeout(() => reject(new Error('emoji worker timed out')), 5000)),
    ]);
    clearInterval(ticker);
    assert(Array.isArray(result.items) && Number.isInteger(result.total), 'worker search payload malformed');
    assert(eventLoopTicks > 0, 'emoji fuzzy search blocked the caller event loop');
    const stats = await call('stats');
    assert(stats.total > 0, 'worker did not open the collected catalog');
    await assert.rejects(call('not-allowed'), /not allowed|timed out/i);
    console.log(`PASS emoji catalog search stays off the UI thread (${eventLoopTicks} caller ticks)`);
  } finally {
    await worker.terminate();
  }
})().catch(error => {
  console.error(error);
  process.exitCode = 1;
});
