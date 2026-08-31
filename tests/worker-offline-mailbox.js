const fs = require('fs');
const path = require('path');
const assert = require('assert');

class Storage {
  constructor() { this.values = new Map(); }
  async get(key) { return this.values.get(key); }
  async put(key, value) { this.values.set(key, structuredClone(value)); }
  async delete(key) { this.values.delete(key); }
  async list({ prefix = '' } = {}) { return new Map([...this.values].filter(([key]) => key.startsWith(prefix)).sort(([a], [b]) => a.localeCompare(b))); }
  async transaction(callback) { return callback(this); }
}

(async () => {
  const source = fs.readFileSync(path.join(__dirname, '..', 'worker', 'index.js'), 'utf8');
  const module = await import(`data:text/javascript;base64,${Buffer.from(source).toString('base64')}`);
  const storage = new Storage(), sockets = [];
  const state = { storage, getWebSockets: () => sockets };
  const directory = new module.PairDirectory(state, {});
  const senderId = 'a'.repeat(32), recipientId = 'b'.repeat(32), messageId = 'c'.repeat(32);
  const sender = { id: senderId, friends: [recipientId], servers: [] };
  const recipient = { id: recipientId, friends: [senderId], servers: [] };
  await storage.put(`user:${senderId}`, sender);await storage.put(`user:${recipientId}`, recipient);
  await directory.relayText(sender, { scope: 'dm', peerId: recipientId, id: messageId, cipher: { iv: 'A'.repeat(16), data: 'B'.repeat(32) } });
  assert.strictEqual((await storage.list({ prefix: `mail:${recipientId}:` })).size, 1, 'offline ciphertext was not queued');
  const delivered = [], socket = { readyState: 1, deserializeAttachment: () => ({ authed: true, userId: recipientId }), send: value => delivered.push(JSON.parse(value)) };
  sockets.push(socket);await directory.deliverMailbox(recipientId);
  assert(delivered.some(value => value.type === 'relay-text' && value.id === messageId && value.offline), 'queued ciphertext was not delivered after reconnect');
  await directory.ackRelayText(recipient, { id: messageId });
  assert.strictEqual((await storage.list({ prefix: `mail:${recipientId}:` })).size, 0, 'acknowledged ciphertext was not deleted');

  const thirdId = 'e'.repeat(32), fourthId = 'd'.repeat(32), outsiderId = 'f'.repeat(32);
  sender.friends = [recipientId, thirdId, fourthId];sender.groupDms = [];
  recipient.friends = [senderId, fourthId];recipient.groupDms = [];
  const third = { id: thirdId, friends: [senderId], servers: [], groupDms: [] }, fourth = { id: fourthId, friends: [senderId, recipientId], servers: [], groupDms: [] }, outsider = { id: outsiderId, friends: [], servers: [], groupDms: [] };
  await storage.put(`user:${senderId}`, sender);await storage.put(`user:${recipientId}`, recipient);await storage.put(`user:${thirdId}`, third);await storage.put(`user:${fourthId}`, fourth);await storage.put(`user:${outsiderId}`, outsider);
  const supersededInvite = await directory.createInvite('friend', fourthId, fourthId);
  const friendInvite = await directory.createInvite('friend', fourthId, fourthId);
  assert.strictEqual(await storage.get(`invite:${supersededInvite}`), undefined, 'creating a replacement left an obsolete invite active');
  await assert.rejects(() => directory.redeemInvite(fourth, friendInvite), /own invite/, 'an inviter could redeem their own friend code');
  assert(await storage.get(`invite:${friendInvite}`), 'an invalid redeemer burned a valid invite code');
  await directory.redeemInvite(third, friendInvite);
  assert((await storage.get(`user:${thirdId}`)).friends.includes(fourthId) && (await storage.get(`user:${fourthId}`)).friends.includes(thirdId), 'friend invite redemption did not update both users');
  assert.strictEqual(await storage.get(`invite:${friendInvite}`), undefined, 'a successfully redeemed invite remained reusable');
  const makeVoiceSocket = userId => { const attachment = { authed: true, userId };const sent = [];return { attachment, sent, socket: { readyState: 1, deserializeAttachment: () => attachment, serializeAttachment: value => Object.assign(attachment, value), send: value => sent.push(JSON.parse(value)) } }; };
  const creatorVoice = makeVoiceSocket(senderId), recipientVoice = makeVoiceSocket(recipientId);sockets.push(creatorVoice.socket, recipientVoice.socket);
  creatorVoice.attachment.dmCallActive = true;creatorVoice.attachment.dmCallPeerId = recipientId;creatorVoice.attachment.dmCallSession='call-session';
  await directory.webSocketMessage(creatorVoice.socket, JSON.stringify({ type: 'create-group-dm', memberIds: [recipientId, thirdId], migrateCallPeerId: recipientId }));
  assert(creatorVoice.sent.some(value => value.type === 'error' && value.action === 'create-group-dm' && /no longer active/.test(value.message)), 'the Worker trusted a one-sided direct-call migration claim');
  recipientVoice.attachment.dmCallActive = true;recipientVoice.attachment.dmCallPeerId = senderId;recipientVoice.attachment.dmCallSession='call-session';
  assert(directory.directCallPairActive(creatorVoice.attachment, senderId, recipientId), 'a mutual direct call was not eligible for group-call migration');
  recipientVoice.attachment.dmCallSession='different-session';assert(!directory.directCallPairActive(creatorVoice.attachment,senderId,recipientId),'mismatched call sessions were eligible for migration');recipientVoice.attachment.dmCallSession='call-session';
  assert(!directory.directCallPairActive(creatorVoice.attachment, senderId, outsiderId), 'a user outside the mutual direct call was eligible for migration');
  await assert.rejects(() => directory.createGroupDm(sender, { memberIds: [recipientId] }), /at least two friends/, 'a two-person DM was incorrectly created as a group');
  await assert.rejects(() => directory.createGroupDm(sender, { memberIds: [recipientId, thirdId], migrateCallPeerId: fourthId }), /active call member must be included/, 'call migration could target someone outside the new group');
  const group = await directory.createGroupDm(sender, { name: 'Test crew', memberIds: [recipientId, thirdId], migrateCallPeerId: recipientId });
  assert.strictEqual(group.kind, 'group-dm', 'group record was not separated from servers');
  assert.strictEqual(group.members.length, 3, 'group creator and selected friends were not indexed');
  assert.deepStrictEqual(group.callMigration?.members, [senderId, recipientId], 'the two active-call participants were not bound to the group migration');
  assert(group.callMigration.expiresAt > Date.now(), 'group-call migration metadata did not have a live expiry');
  assert(group.channels.some(channel => channel.type === 'text') && group.channels.some(channel => channel.type === 'voice'), 'group synthetic text/voice channels are missing');
  assert((await storage.get(`user:${thirdId}`)).groupDms.includes(group.id), 'group membership was not added to a recipient index');
  await assert.rejects(() => directory.addGroupMembers(sender, { groupId: group.id, memberIds: [outsiderId] }), /only add your friends|no longer available/, 'a non-friend was added to a group DM');
  await directory.addGroupMembers(await storage.get(`user:${recipientId}`), { groupId: group.id, memberIds: [fourthId] });
  const expandedGroup = await storage.get(`group:${group.id}`);
  assert.strictEqual(expandedGroup.members.length, 4, 'transactional multi-member add did not update the group');
  assert.strictEqual(expandedGroup.keyEpoch, 2, 'membership change did not rotate the group key epoch');
  assert.strictEqual(expandedGroup.keySteward, recipientId, 'the online non-owner who changed membership was not assigned the new key epoch');
  const groupSnapshot = await directory.snapshot(recipientId);
  assert(groupSnapshot.groupDms.some(value => value.id === group.id), 'group DM was not included in member snapshots');
  assert(groupSnapshot.members[thirdId], 'group member profiles were not included in snapshots');
  const oversized={type:'snapshot',self:{id:senderId,image:'A'.repeat(2*1024*1024)},friends:[{id:recipientId,image:'B'.repeat(2*1024*1024)}],servers:[{id:group.id,picture:'C'.repeat(2*1024*1024),members:[senderId,recipientId]}],members:{[recipientId]:{id:recipientId,image:'D'.repeat(2*1024*1024)}}};directory.boundedSnapshot(oversized);assert(new TextEncoder().encode(JSON.stringify(oversized)).byteLength<=4*1024*1024&&oversized.servers[0].members.includes(recipientId)&&oversized.profileImagesTruncated,'oversized snapshots were not bounded without dropping membership metadata');

  const groupMessageId = '9'.repeat(32), textChannel = expandedGroup.channels.find(channel => channel.type === 'text');
  await directory.relayText(await storage.get(`user:${senderId}`), { scope: 'group-dm', groupId: group.id, channelId: textChannel.id, keyEpoch: expandedGroup.keyEpoch, id: groupMessageId, cipher: { iv: 'C'.repeat(16), data: 'D'.repeat(32) } });
  assert.strictEqual((await storage.list({ prefix: `mail:${thirdId}:` })).size, 1, 'offline group ciphertext was not queued for each member');
  assert(delivered.some(value => value.scope === 'group-dm' && value.groupId === group.id), 'online group ciphertext was not delivered live');
  await directory.ackRelayText(await storage.get(`user:${recipientId}`), { id: groupMessageId });
  assert.strictEqual((await storage.list({ prefix: `mail:${recipientId}:` })).size, 0, 'group acknowledgement did not delete that recipient envelope');

  const keyRequestId = '8'.repeat(32), keyBefore = delivered.length;
  await directory.relayGroupKey(await storage.get(`user:${recipientId}`), { scope: 'group-dm', mode: 'request', groupId: group.id, keyEpoch: expandedGroup.keyEpoch, id: keyRequestId });
  await assert.rejects(async () => directory.relayGroupKey(await storage.get(`user:${senderId}`), { scope: 'group-dm', mode: 'deliver', groupId: group.id, keyEpoch: expandedGroup.keyEpoch + 1, id: keyRequestId, peerId: recipientId, cipher: { iv: 'E'.repeat(16), data: 'F'.repeat(32) } }), /invalid group-key relay|out of date/, 'a mismatched group key epoch was delivered');
  await directory.relayGroupKey(await storage.get(`user:${senderId}`), { scope: 'group-dm', mode: 'deliver', groupId: group.id, keyEpoch: expandedGroup.keyEpoch, id: keyRequestId, peerId: recipientId, cipher: { iv: 'E'.repeat(16), data: 'F'.repeat(32) } });
  assert(delivered.slice(keyBefore).some(value => value.type === 'relay-key' && value.id === keyRequestId && value.keyEpoch === expandedGroup.keyEpoch), 'request-bound group key was not delivered');
  const replacementRequestId = '7'.repeat(32);
  await directory.relayGroupKey(await storage.get(`user:${recipientId}`), { scope: 'group-dm', mode: 'request', groupId: group.id, keyEpoch: expandedGroup.keyEpoch, id: replacementRequestId });
  const activeKeyRequests = await storage.list({ prefix: `group-key-request:${group.id}:` });
  assert.strictEqual(activeKeyRequests.size, 1, 'a group-key retry accumulated stale requests against the requester cap');
  assert(activeKeyRequests.has(`group-key-request:${group.id}:${replacementRequestId}`), 'the newest group-key retry did not supersede its old request');

  const voiceChannel = expandedGroup.channels.find(channel => channel.type === 'voice');
  await directory.updateVoiceState(creatorVoice.socket, creatorVoice.attachment, await storage.get(`user:${senderId}`), { groupId: group.id, channelId: voiceChannel.id, joined: true });
  await directory.updateVoiceState(recipientVoice.socket, recipientVoice.attachment, await storage.get(`user:${recipientId}`), { groupId: group.id, channelId: voiceChannel.id, joined: true });
  await assert.rejects(async () => directory.relayPeerControl(creatorVoice.socket, creatorVoice.attachment, await storage.get(`user:${senderId}`), { type: 'signal', peerId: recipientId, context: { type: 'group-dm', groupId: group.id, channelId: voiceChannel.id }, payload: { kind: 'offer', sdp: 'v=0\r\n' } }), /out of date/, 'group call signaling without its current key epoch was accepted');
  await directory.relayPeerControl(creatorVoice.socket, creatorVoice.attachment, await storage.get(`user:${senderId}`), { type: 'signal', peerId: recipientId, context: { type: 'group-dm', groupId: group.id, channelId: voiceChannel.id, keyEpoch: expandedGroup.keyEpoch }, payload: { kind: 'offer', sdp: 'v=0\r\n' } });
  assert(recipientVoice.sent.some(value => value.type === 'peer-signal' && value.context.type === 'group-dm'), 'group voice signaling did not reach a joined participant');
  const capacityServer={id:'6'.repeat(32),owner:senderId,members:[senderId],channels:[{id:'5'.repeat(32),type:'voice',name:'Capacity'}]};for(let index=0;index<17;index++){const id=index.toString(16).padStart(32,'0');capacityServer.members.push(id);await storage.put(`user:${id}`,{id,friends:[],servers:[capacityServer.id],groupDms:[]});const live=makeVoiceSocket(id);live.attachment.voiceServerId=capacityServer.id;live.attachment.voiceChannelId=capacityServer.channels[0].id;sockets.push(live.socket)}await storage.put(`server:${capacityServer.id}`,capacityServer);const overflowId=capacityServer.members.at(-1),overflowSocket=sockets.at(-1),overflowAttachment=overflowSocket.deserializeAttachment();delete overflowAttachment.voiceServerId;delete overflowAttachment.voiceChannelId;await assert.rejects(()=>directory.updateVoiceState(overflowSocket,overflowAttachment,{id:overflowId,servers:[capacityServer.id]}, {serverId:capacityServer.id,channelId:capacityServer.channels[0].id,joined:true}),/voice channel is full/,'a P2P voice channel exceeded its bounded mesh capacity');
  await assert.rejects(async () => directory.relayPeerControl(creatorVoice.socket, creatorVoice.attachment, await storage.get(`user:${senderId}`), { type: 'signal', peerId: outsiderId, context: { type: 'dm-persistent' }, payload: { kind: 'offer' } }), /limited to friends/, 'server or group proximity authorized an unsolicited direct signal');

  await directory.removeGroupMember(await storage.get(`user:${senderId}`), { groupId: group.id, memberId: fourthId });
  assert(!(await storage.get(`user:${fourthId}`)).groupDms.includes(group.id), 'removed group member kept a stale index');
  assert.strictEqual((await storage.list({ prefix: `mail:${fourthId}:` })).size, 0, 'removed member kept undeliverable group envelopes in their mailbox');
  const beforeLeave = structuredClone(await storage.get(`group:${group.id}`));await directory.leaveGroupDm(await storage.get(`user:${senderId}`), { groupId: group.id });
  const afterLeave = await storage.get(`group:${group.id}`);
  assert(afterLeave && afterLeave.owner !== senderId && afterLeave.keyEpoch === beforeLeave.keyEpoch + 1, 'owner leave did not transfer ownership and rotate the epoch');

  const accountMessages = [], accountAttachment = { securityKey: '1'.repeat(64) }, accountSocket = { readyState: 1, send: value => accountMessages.push(JSON.parse(value)), serializeAttachment: value => Object.assign(accountAttachment,value) };
  const passwordSalt = Buffer.from('0123456789abcdef').toString('base64url');
  const passwordKey = await crypto.subtle.importKey('raw', new TextEncoder().encode('correct horse battery staple'), 'PBKDF2', false, ['deriveBits']);
  const verifierBits = await crypto.subtle.deriveBits({ name: 'PBKDF2', hash: 'SHA-256', salt: Buffer.from(passwordSalt, 'base64url'), iterations: 600000 }, passwordKey, 256);
  const verifier = Buffer.from(verifierBits).toString('base64url');
  const savedAccountImage = 'data:image/png;base64,AA==', savedAccountProfile = { name: 'Saved Mundo', image: savedAccountImage, frame: { zoom: 125, x: 42, y: 61 } };
  const accountOwner = await storage.get(`user:${senderId}`);accountOwner.name='Saved Mundo';accountOwner.image='';accountOwner.frame=savedAccountProfile.frame;await storage.put(`user:${senderId}`,accountOwner);
  await directory.createAccount(accountSocket, accountOwner, { username: 'mundo_test', passwordSalt, verifier, profile: savedAccountProfile }, accountAttachment);
  assert.strictEqual((await storage.get('account:mundo_test')).userId, senderId, 'account did not retain the existing friend identity');
  assert.deepStrictEqual((await storage.get('account:mundo_test')).profile, savedAccountProfile, 'account did not retain its private recovery name, photo, and frame');
  assert(!(await storage.get('account:mundo_test')).password, 'account stored a plaintext password');
  assert(!(await storage.get('account:mundo_test')).verifier, 'account stored a reusable password verifier');
  assert(/^[a-f0-9]{64}$/.test((await storage.get('account:mundo_test')).verifierHash), 'account did not hash the client-derived verifier');
  const duplicate = { id: fourthId, friends: [], servers: [], groupDms: [] };await storage.put(`user:${duplicate.id}`, duplicate);
  await assert.rejects(() => directory.createAccount(accountSocket, duplicate, { username: 'MUNDO_TEST', passwordSalt, verifier }, accountAttachment), /already taken/, 'case-insensitive duplicate username was accepted');
  assert.strictEqual((await storage.get('account:mundo_test')).userId, senderId, 'duplicate signup replaced the original username owner');
  const challengeMessages = [];
  await directory.accountChallenge({ readyState: 1, send: value => challengeMessages.push(JSON.parse(value)) }, { securityKey: '5'.repeat(64) }, { username: 'MUNDO_TEST' });
  assert.strictEqual(challengeMessages[0]?.passwordSalt, passwordSalt, 'sign-in challenge did not return the account salt');
  const unknownChallenges = [], unknownAttachment = { securityKey: '6'.repeat(64) }, unknownSocket = { readyState: 1, send: value => unknownChallenges.push(JSON.parse(value)), serializeAttachment: value => Object.assign(unknownAttachment, value) };
  await directory.accountChallenge(unknownSocket, unknownAttachment, { username: 'unknown_account' });await directory.accountChallenge(unknownSocket, unknownAttachment, { username: 'unknown_account' });
  assert(/^[A-Za-z0-9_-]{22}$/.test(unknownChallenges[0]?.passwordSalt) && unknownChallenges[0].passwordSalt === unknownChallenges[1]?.passwordSalt, 'unknown-account challenges did not use a stable same-shape private dummy salt');
  const loginMessages = [], attachment = { securityKey: '2'.repeat(64) }, loginSocket = { readyState: 1, send: value => loginMessages.push(JSON.parse(value)), serializeAttachment: value => Object.assign(attachment, value), close: () => {} };
  await directory.loginAccount(loginSocket, attachment, { username: 'mundo_test', verifier });
  const session = loginMessages.find(value => value.type === 'account-session');
  assert(session && session.userId === senderId && /^[a-f0-9]{64}$/.test(session.token), 'account login did not recover the original identity');
  assert.deepStrictEqual(session.profile, { id: senderId, ...savedAccountProfile }, 'account login did not return the saved name, photo, and frame');
  assert.strictEqual(session.profileMigrated, false, 'a current account profile was incorrectly marked as legacy');
  assert.strictEqual(attachment.authed, true, 'account login socket was not authenticated');
  assert((await storage.get(`user:${senderId}`)).sessions.some(value => value.accountLogin === true), 'password login did not create a profile-protected recovery session');

  const reconnectMessages=[],reconnectAttachment={},reconnectSocket={readyState:1,send:value=>reconnectMessages.push(JSON.parse(value)),serializeAttachment:value=>Object.assign(reconnectAttachment,value),deserializeAttachment:()=>reconnectAttachment,close:()=>{}};sockets.push(reconnectSocket);
  const beforeReconnect=structuredClone(await storage.get(`user:${senderId}`));
  await directory.authenticate(reconnectSocket,reconnectAttachment,{type:'hello',userId:senderId,token:session.token,name:'You',image:'data:image/png;base64,AQ==',frame:{zoom:100,x:50,y:50}});
  const afterReconnect=await storage.get(`user:${senderId}`);
  assert(reconnectMessages.some(value=>value.type==='authenticated'),'the recovered account session did not authenticate');
  assert.deepStrictEqual({name:afterReconnect.name,image:afterReconnect.image,frame:afterReconnect.frame},{name:beforeReconnect.name,image:beforeReconnect.image,frame:beforeReconnect.frame},'a new computer handshake overwrote the recovered public profile with local defaults');

  const updatedPrivateImage='data:image/png;base64,Ag==',updatedPrivateProfile={name:'Updated Mundo',image:updatedPrivateImage,frame:{zoom:140,x:35,y:70}};
  await directory.webSocketMessage(reconnectSocket,JSON.stringify({type:'update-profile',name:'Updated Mundo',image:'',frame:updatedPrivateProfile.frame,accountProfile:updatedPrivateProfile}));
  const updatedPublicUser=await storage.get(`user:${senderId}`),updatedAccount=await storage.get('account:mundo_test');
  assert.deepStrictEqual({name:updatedPublicUser.name,image:updatedPublicUser.image,frame:updatedPublicUser.frame},{name:'Updated Mundo',image:'',frame:updatedPrivateProfile.frame},'an explicit authenticated profile update did not change the public profile');
  assert.deepStrictEqual(updatedAccount.profile,updatedPrivateProfile,'a hidden profile photo was not retained in the private account recovery record');

  delete updatedAccount.profile;await storage.put('account:mundo_test',updatedAccount);const migrationMessages=[],migrationAttachment={securityKey:'7'.repeat(64)},migrationSocket={readyState:1,send:value=>migrationMessages.push(JSON.parse(value)),serializeAttachment:value=>Object.assign(migrationAttachment,value),close:()=>{}};await directory.loginAccount(migrationSocket,migrationAttachment,{username:'mundo_test',verifier});const migratedSession=migrationMessages.find(value=>value.type==='account-session');assert(migratedSession?.profileMigrated===true&&migratedSession.profile.name==='Updated Mundo'&&migratedSession.profile.image==='','a legacy account did not migrate its last public profile during sign-in');assert((await storage.get('account:mundo_test')).profile,'legacy profile migration was not persisted');
  const storedAccount=await storage.get('account:mundo_test');storedAccount.login={windowStarted:Date.now(),failures:10,blockedUntil:Date.now()+15*60*1000};await storage.put('account:mundo_test',storedAccount);const legacyMessages=[],legacyAttachment={securityKey:'3'.repeat(64)},legacySocket={readyState:1,send:value=>legacyMessages.push(JSON.parse(value)),serializeAttachment:value=>Object.assign(legacyAttachment,value),close:()=>{}};await directory.loginAccount(legacySocket,legacyAttachment,{username:'mundo_test',verifier});assert(legacyMessages.some(value=>value.type==='account-session'),'a legacy account-level lockout still blocked the rightful user');assert(!(await storage.get('account:mundo_test')).login,'legacy account lockout metadata was not removed after a valid login');
  const badAttachment={securityKey:'4'.repeat(64)},badMessages=[],badSocket={readyState:1,send:value=>badMessages.push(JSON.parse(value)),serializeAttachment:value=>Object.assign(badAttachment,value),close:()=>{}};for(let attempt=0;attempt<12;attempt++)await directory.loginAccount(badSocket,badAttachment,{username:'mundo_test',verifier:'A'.repeat(43)});assert.strictEqual(badAttachment.loginFailures,10,'per-connection login failure state exceeded its bound');assert(!(await storage.get('account:mundo_test')).login,'failed sign-ins recreated a username-wide lockout');
  assert(!source.includes("name: 'PBKDF2'"), 'Worker still performs PBKDF2 and can exceed Cloudflare limits');
  console.log('PASS encrypted offline mailbox, group DMs, group calls, and recoverable account profiles');
})().catch(error => { console.error(error);process.exitCode = 1; });
