'use strict';

const assert = require('assert');
const dgram = require('dgram');
const {
  privateIpv4, deviceFingerprint, encodeBeacon, decodeBeacon, rewriteSdpHostnames,
  packFrame, readFrame, LanHouse, MULTICAST,
} = require('../lan-house');

assert.strictEqual(privateIpv4('192.168.1.20'), true);
assert.strictEqual(privateIpv4('10.0.0.4'), true);
assert.strictEqual(privateIpv4('172.16.9.1'), true);
assert.strictEqual(privateIpv4('127.0.0.1'), true);
assert.strictEqual(privateIpv4('8.8.8.8'), false);
assert.strictEqual(privateIpv4('1.2.3'), false);

const fp = deviceFingerprint({ kty: 'EC', crv: 'P-256', x: 'a'.repeat(43), y: 'b'.repeat(43) });
assert.match(fp, /^[a-f0-9]{32}$/);
assert.strictEqual(deviceFingerprint({ kty: 'RSA' }), '');

const beacon = encodeBeacon({ fp, port: 18788, nonce: 'ab'.repeat(8) });
assert.ok(beacon.length < 256);
assert.deepStrictEqual(decodeBeacon(beacon, '192.168.0.12'), { fp, port: 18788, nonce: 'ab'.repeat(8), host: '192.168.0.12' });
assert.strictEqual(decodeBeacon(beacon, '1.1.1.1'), null);
assert.strictEqual(encodeBeacon({ fp, port: 80, nonce: 'ab'.repeat(8) }), null);

const sdp = 'a=candidate:1 1 UDP 2122260223 abcdef.local 54321 typ host\r\n';
assert.ok(rewriteSdpHostnames(sdp, '192.168.1.9').includes('192.168.1.9'));
assert.ok(rewriteSdpHostnames(sdp, '8.8.8.8').includes('abcdef.local'));

const packed = packFrame({ t: 'hello', fp });
const read = readFrame(packed);
assert.deepStrictEqual(read.value, { t: 'hello', fp });
assert.strictEqual(read.rest.length, 0);
assert.strictEqual(readFrame(Buffer.from([0, 0, 0, 1, 1])), null);

(async () => {
  const houseA = new LanHouse({ udpPort: 0, loopback: true });
  const houseB = new LanHouse({ udpPort: 0, loopback: true });
  // Use an ephemeral UDP port shared by both by starting A first then rebinding B
  // to A's UDP port is awkward. Instead, test TCP signaling on loopback and
  // decode/encode separately. Direct connect is the internet-down path.
  await houseA.start();
  await houseB.start();
  const nonce = 'cd'.repeat(8);
  assert.strictEqual(houseA.setBeacon(fp, nonce), true);
  const seen = [];
  houseB.onPeer = peer => seen.push(peer);
  const peer = await houseB.connect('127.0.0.1', houseA.tcpPort);
  assert.strictEqual(peer.host, '127.0.0.1');
  const received = new Promise(resolve => {
    houseA.onPeer = incoming => {
      incoming.onFrame = value => resolve(value);
    };
  });
  // The accept path already fired onPeer before we assigned it. Send from B;
  // attach onFrame on the accepted peer via houseA.peers.
  const incoming = [...houseA.peers.values()][0];
  const got = new Promise(resolve => { incoming.onFrame = value => resolve(value); });
  assert.strictEqual(peer.send({ t: 'hello', fp }), true);
  assert.deepStrictEqual(await got, { t: 'hello', fp });
  houseA.close();
  houseB.close();

  const house = new LanHouse({ udpPort: 0, multicast: MULTICAST, loopback: true });
  const heard = new Promise(resolve => { house.onBeacon = value => resolve(value); });
  await house.start();
  const udp = dgram.createSocket({ type: 'udp4', reuseAddr: true });
  await new Promise((resolve, reject) => {
    udp.once('error', reject);
    udp.bind(0, '127.0.0.1', () => { udp.off('error', reject); resolve(); });
  });
  udp.send(encodeBeacon({ fp, port: 23456, nonce }), house.udpPort, '127.0.0.1');
  const value = await Promise.race([
    heard,
    new Promise((_, reject) => setTimeout(() => reject(new Error('loopback beacon not received')), 4000)),
  ]);
  assert.strictEqual(value.fp, fp);
  assert.ok(privateIpv4(value.host));
  udp.close();
  house.close();
  console.log('PASS lan-house discovery and signaling', JSON.stringify({ tcp: true, beacon: true, seen: seen.length }));
})().catch(error => { console.error(error); process.exitCode = 1; });
