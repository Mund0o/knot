const test = require('node:test');
const assert = require('node:assert/strict');

// Lightweight call/share generation guards — mirrors abort semantics used in app.js.
function makeShareSession() {
  let screenGen = 0;
  let screenActive = false;
  let screenStarting = false;
  let captureStopped = false;
  return {
    start() {
      if (screenActive || screenStarting) return false;
      screenStarting = true;
      const gen = ++screenGen;
      return {
        gen,
        activate() {
          if (gen !== screenGen) return false;
          screenActive = true;
          screenStarting = false;
          return true;
        },
        abort() {
          return gen !== screenGen;
        }
      };
    },
    stop() {
      screenGen++;
      screenStarting = false;
      screenActive = false;
      captureStopped = true;
    },
    state: () => ({ screenGen, screenActive, screenStarting, captureStopped })
  };
}

test('share start/stop generation aborts stale attaches', () => {
  const share = makeShareSession();
  const a = share.start();
  assert.equal(!!a, true);
  assert.equal(a.activate(), true);
  share.stop();
  assert.equal(a.abort(), true);
  assert.equal(share.state().captureStopped, true);
  assert.equal(share.state().screenActive, false);
});

test('second share start is blocked while active', () => {
  const share = makeShareSession();
  const a = share.start();
  a.activate();
  assert.equal(share.start(), false);
});

test('call starting guard prevents overlapping starts', () => {
  let callStarting = false;
  let callActive = false;
  let starts = 0;
  async function startCall() {
    if (callActive || callStarting) return false;
    callStarting = true;
    starts++;
    await Promise.resolve();
    callActive = true;
    callStarting = false;
    return true;
  }
  return Promise.all([startCall(), startCall()]).then(results => {
    assert.deepEqual(results, [true, false]);
    assert.equal(starts, 1);
    assert.equal(callActive, true);
  });
});
