'use strict';

const assert = require('assert');
const {
  RoomJoinLimiter,
  signalingJoinAddress,
  validSignalingRoom,
} = require('../signaling-policy');

assert.strictEqual(validSignalingRoom('12345'), false, 'enumerable friend codes must not become relay capabilities');
assert.strictEqual(validSignalingRoom('A'.repeat(23)), false);
assert.strictEqual(validSignalingRoom('A'.repeat(24)), true);
assert.strictEqual(validSignalingRoom('ABCDEF_0123456789-ABCDEFG:stream'), true);
assert.strictEqual(validSignalingRoom('ABCDEF_0123456789-ABCDEFG:STREAM'), true);
assert.strictEqual(validSignalingRoom('ABCDEF_0123456789-ABCDEFG:files'), false);
assert.strictEqual(validSignalingRoom('A'.repeat(65)), false);
assert.strictEqual(validSignalingRoom('A'.repeat(24) + ':stream:extra'), false);

const connection = { _socket: { remoteAddress: '127.0.0.7' } };
const proxyRequest = { headers: { 'x-forwarded-for': '203.0.113.8, 10.0.0.4' } };
assert.strictEqual(signalingJoinAddress(connection, proxyRequest, { trustProxy: false }), '127.0.0.7');
assert.strictEqual(signalingJoinAddress(connection, proxyRequest, { trustProxy: true }), '203.0.113.8');

let clock = 1000;
const limiter = new RoomJoinLimiter({
  windowMs: 100,
  maxSocketAttempts: 2,
  maxAddressAttempts: 3,
  now: () => clock,
});
const first = { _joinAddress: '198.51.100.10' };
assert.strictEqual(limiter.allow(first), true);
assert.strictEqual(limiter.allow(first), true);
assert.strictEqual(limiter.allow(first), false, 'one socket must be bounded even if it changes rooms');

const second = { _joinAddress: '198.51.100.10' };
assert.strictEqual(limiter.allow(second), true);
const third = { _joinAddress: '198.51.100.10' };
assert.strictEqual(limiter.allow(third), false, 'new sockets must not evade the address-wide cap');
const otherAddress = { _joinAddress: '198.51.100.11' };
assert.strictEqual(limiter.allow(otherAddress), true);

clock += 100;
assert.strictEqual(limiter.allow(first), true, 'socket and address windows reset at the boundary');
limiter.sweep();
assert.strictEqual(limiter.byAddress.has('198.51.100.11'), false, 'expired address counters are reclaimed');

console.log('signaling policy tests passed');
