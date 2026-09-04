'use strict';

const assert = require('assert');
const { youtubeVideoId, watchEmbedUrl, mediaTime, drifted, watchRoom, cleanWatchMessage, newerWatch, hashPrefix } = require('../watch-together');

assert.strictEqual(youtubeVideoId('https://youtu.be/dQw4w9WgXcQ'), 'dQw4w9WgXcQ');
assert.strictEqual(youtubeVideoId('https://www.youtube.com/watch?v=dQw4w9WgXcQ'), 'dQw4w9WgXcQ');
assert.strictEqual(youtubeVideoId('https://music.youtube.com/watch?v=dQw4w9WgXcQ&list=x'), 'dQw4w9WgXcQ');
assert.strictEqual(youtubeVideoId('https://www.youtube.com/embed/dQw4w9WgXcQ'), 'dQw4w9WgXcQ');
assert.strictEqual(youtubeVideoId('https://example.com/watch?v=dQw4w9WgXcQ'), '');
assert.strictEqual(youtubeVideoId('http://youtu.be/dQw4w9WgXcQ'), 'dQw4w9WgXcQ');

const embed = watchEmbedUrl('dQw4w9WgXcQ', { start: 83, playing: true });
assert.ok(embed.startsWith('https://www.youtube-nocookie.com/embed/dQw4w9WgXcQ?'));
assert.ok(embed.includes('autoplay=1'));
assert.ok(embed.includes('start=83'));
assert.ok(embed.includes('controls=0'));
assert.strictEqual(watchEmbedUrl('bad'), '');

assert.strictEqual(mediaTime({ playing: false, time: 12, at: 0 }, 5000), 12);
assert.ok(Math.abs(mediaTime({ playing: true, time: 10, at: 1000 }, 3500) - 12.5) < 0.001);
assert.ok(drifted(10, 12));
assert.ok(!drifted(10, 10.4));

assert.strictEqual(watchRoom({ dmPeerId: 'a'.repeat(32) }), 'dm:' + 'a'.repeat(32));
assert.strictEqual(watchRoom({ entityId: 'b'.repeat(32), channelId: 'c'.repeat(32) }), 'voice:' + 'b'.repeat(32) + ':' + 'c'.repeat(32));
assert.strictEqual(watchRoom({ dmPeerId: 'nope' }), '');

assert.strictEqual(cleanWatchMessage({ t: 'watch', v: 1, action: 'close' }).action, 'close');
assert.strictEqual(cleanWatchMessage({ t: 'msg' }), null);
assert.strictEqual(cleanWatchMessage({ t: 'watch', v: 1, action: 'open', kind: 'youtube', id: 'dQw4w9WgXcQ' }).id, 'dQw4w9WgXcQ');
assert.strictEqual(cleanWatchMessage({ t: 'watch', v: 1, action: 'open', kind: 'local', hash: 'ab', size: 1 }), null);
const local = cleanWatchMessage({ t: 'watch', v: 1, action: 'open', kind: 'local', hash: 'ab'.repeat(16), size: 42, name: 'Movie.mp4' });
assert.strictEqual(local.size, 42);
assert.strictEqual(local.name, 'Movie.mp4');
assert.ok(newerWatch(null, { seq: 1, at: 1 }));
assert.ok(newerWatch({ seq: 1, at: 5 }, { seq: 2, at: 1 }));
assert.ok(!newerWatch({ seq: 3, at: 1 }, { seq: 2, at: 9 }));

(async () => {
  const hash = await hashPrefix(Buffer.from('knot-watch-prefix'));
  assert.match(hash, /^[a-f0-9]{64}$/);
  console.log('PASS watch-together protocol');
})().catch(error => { console.error(error); process.exitCode = 1; });
