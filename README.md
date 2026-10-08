# Knot

Knot is a small-group P2P communication app with saved friends, live presence,
direct and group DMs, and servers containing text and voice channels. It uses
WebRTC data channels and media tracks for content transport. Direct and group
messages use Web Crypto ECDH + AES-GCM on top of authenticated WSS transport;
calls use WebRTC's DTLS-SRTP encryption.

The checked-in Cloudflare Free deployment supplies only the lightweight control
plane: an encrypted text mailbox, presence, directory records, and WebRTC setup.
Opening a DM or text channel does not create a peer connection: text is
encrypted on-device; offline direct- and group-DM ciphertext is held for up to
30 days in a bounded mailbox and deleted separately for each recipient after
their device decrypts and acknowledges it.
Cloudflare never receives the message keys or readable text. Calls and screen
shares create direct WebRTC connections only when used. Files travel over a fast UDP
connection when both networks allow it and over the encrypted direct WebRTC connection
otherwise, with no port forwarding. The optional SFU and encrypted object-relay
adapters are feature-flagged off in `wrangler.jsonc`; see
[`docs/deployment-envelope.md`](docs/deployment-envelope.md). Screen shares appear beside their owners and open
into a single focused viewer; use a stream's context menu to stop watching
without making the stream undiscoverable. Fullscreen expands the selected share
stage, not the entire Knot interface.

## Group direct messages

Choose **New group DM** from Direct Messages, or open a friend's DM and choose
**Create group** to carry that friend into a new conversation. A group contains
3–20 people. Existing members can add their own friends, and leaving transfers
ownership when needed.

Group text is end-to-end encrypted with an epoch-bound key that rotates after
membership changes. Each recipient gets an independent opaque offline envelope.
Group calls form an on-demand WebRTC mesh only among members currently joined to
the group's voice room. An explicitly configured audio-only SFU pilot can replace
that mesh and automatically falls back to P2P if setup fails; it is disabled in
the normal Free deployment. If a two-person call is active while its DM is converted
to a group, Knot moves both call participants into the new group call.

## Run as a PC app

Install Node.js 20 or newer, then from this folder run:

```bash
npm install
npm start
```

To build the Linux package:

```powershell
npm run dist
```

The tarball and AppImage will be created in the `dist` folder. The AppImage is
the recommended Linux format: Knot can replace it and restart itself after an
update. A tarball installation is also updated in place when its folder is
writable. On its first graphical launch, Knot adds itself to your Linux
Applications menu; open it from there thereafter with no terminal command.

## Build a Windows release

Run these commands from a Windows machine with Node.js and Visual Studio Build
Tools installed. The first command recompiles the optional WASAPI capture addon
against Knot's current Electron version. The installer still works if that
addon is unavailable, but screen sharing stays video-only rather than using a
whole-system loopback that could send the viewer's voice back to them.

```powershell
npm install
npm run rebuild:addon
npm run dist:win
```

The installer is created as `dist\Knot Setup <version>.exe`. To make a matched
Windows + Linux release and update manifest, run `npm run dist:all` followed by
`npm run publish`. Upload the Windows installer, Linux tarball, and Linux
AppImage to the matching GitHub release before committing/pushing
`public/latest.json`.

Every packaged build checks `public/latest.json` as it opens. If the manifest
has a newer version, Knot shows its release notes under “What's changed.” It
downloads, verifies, installs, and restarts only after the person using Knot
chooses **Download & install**.

## Screen sharing architecture

Screen video, computer sound, and voice travel separately. The share dialog
selects the source, resolution, frame rate, and sound setting before Go Live;
a 4K60 share starts and stays at 3840×2160/60.

**Nothing is lowered for the connection.** Knot never changes the codec,
resolution, frame rate, or bitrate of a share because of how a link is doing.
The quality is decided by what the sharer's computer can really encode. If a
viewer's connection cannot keep up, that viewer waits behind a buffering view
(running cats over the last picture) and catches up when the link allows; the
picture is never made worse for them. The starting bitrate is sized from the
speed test and the viewer's reported capacity, and is fixed from then on.

**Capture and encode** happen once per share. On Linux with a discrete NVIDIA
or AMD GPU and GPU Screen Recorder, the GPU encodes AV1 for the whole share
(NVENC or VA-API, constant bitrate, a key picture every two seconds, which at
the same bitrate buys noticeably more detail than a very short key interval).
Everywhere else (Windows, other Linux machines, or a codec the sharer asked
for), the browser captures the screen and Knot encodes it in the page with
WebCodecs: AV1, H.264 or VP9, hardware first, whichever the computer can
actually sustain at the chosen size and rate (measured at start, in about a
second or two). If the machine cannot keep up with the chosen rate, the share
says so; the network is never consulted.

**Delivery** is a numbered list of encoded pictures, delivered whole and in
order. Each viewer gets them over a data channel at once and, as soon as the
two Knots have punched a UDP path through their NATs, over an authenticated,
encrypted UDP lane (the same one-time token, mutual proof and AES-GCM framing
as the file lane). Pictures are acknowledged, resent after a lost lane, and
de-duplicated if two lanes carry the same one. The sharer keeps everything a
viewer has not yet acknowledged (capped at 384 MiB shared by all viewers); a
viewer more than 45 seconds behind is moved up to the live picture, told what
it missed, and the jump is counted. A still screen sends no pictures, so the
sharer says "still here" ten times a second and the viewer can tell a quiet
screen from a dead link.

**Hearing your own sound while sharing (Linux).** Sharing computer sound moves the chosen programs onto a private PipeWire sink that Knot records. The
sharer's speakers get PipeWire's own loopback of that sink (about 40 ms behind), faded up from silence once Knot has checked it is on the speakers; the
page plays no second copy while it is live and takes over again if it ever disappears (Settings → Screen sharing turns this off). Each session's return
stream has a name nothing has remembered, because PipeWire restores a stream's old volume and target by name. `tests/linux-share-audio-loopback.js` and
`tests/linux-share-audio-route.js` check all of it against real PipeWire on private sinks.

**Viewing** decodes with WebCodecs and draws on a canvas at the display's refresh. Where Chromium can use the GPU it does; where it cannot,
it does not pretend to: on Linux with an NVIDIA card Chromium's hardware decoder produces pictures that cannot be shown (they arrive black),
so AV1 is decoded by Knot's own small program, `knot-nvdec` (`native/nvdec/`, built by `scripts/build-nvdec-helper.sh`), which runs NVIDIA's
NVDEC directly, scales each picture on the GPU to the size it is shown at (never above 2560x1440; full screen on a 4K display decodes on the CPU
instead) and hands it back the moment it is decoded. Every hardware decoder's first picture is checked against a software decode, and a
decoder that fails, goes quiet or shows a different picture is replaced by the software one for the rest of the share. The software decoder runs
in low-latency mode, and changes to a faster mode that holds a few pictures back only while the decoder is what the viewer is waiting for on a
steady high-rate stream. The picture plays 160 ms behind the newest one, a little longer after the link has stalled, runs at most 1.15× to
catch up, and jumps to live only when it is more than four seconds behind. A group share has one host and one viewer per friend who chooses to
watch; nobody who is not watching is sent anything.

The **Optimize for** choice (Game or Desktop) is only a hint to the encoder about what it is looking at, and never changes the size or rate. Desktop turns on AV1's screen-content tools when the share is AV1 (measured: about half the bits and better quality on text); other codecs are left alone because the hint made them worse.

**Sound** keeps its own WebRTC path (a reserved stereo Opus sender per call or
per group peer). The viewer holds it back by the picture's delay so lips and
clicks stay together.

Knots before this design cannot show these shares and say so; they need to
update.

On Windows, shared computer sound comes from process-loopback capture. Both
application and display shares capture desktop playback while excluding Knot's
process tree, because browsers and games often play sound from a process that
does not own the selected window. PCM is
batched into bounded 20 ms packets and rendered through an AudioWorklet, and
all DM/server screen-audio elements follow the selected output device.

With **Hardware acceleration** enabled, Knot requests the high-performance GPU
for compositing, image and canvas rasterization, zero-copy tile presentation,
WebGL/WebGPU, and supported video encode/decode paths. Software 3D rasterization
is disabled in this mode. On Linux systems with both integrated and discrete
graphics, Knot excludes the integrated render node, pins Chromium and VA-API to
the main discrete card, and uses NVENC on NVIDIA or VA-API on AMD for the GPU
screen recorder. PipeWire capture import remains compositor-managed so Wayland
screen shares continue to produce valid frames. Audio processing, encryption,
networking, IPC, and file I/O stay on the CPU because Electron provides no
dependable GPU implementation for those jobs.

`npm run test:share` covers the share engine: the wire format, the sender's and
receiver's bookkeeping under reordering, loss and lane switches, the playout
clock, real UDP lanes, the in-page encoder and decoder against bit-exact
references, the Linux recorder (including that it never outlives Knot), the
page-to-main-process bridge, and that every module loads as a plain script.
`npm run test:share:e2e` runs real Knot apps against a local Worker: a share
reaching the other window (checked against pixels from a screenshot, not just
the canvas), sound held back with the picture, a stalled link showing the
buffering view and recovering without lowering anything, data-channel-only
delivery, the Linux recorder, and a three-person group share.

Screen sharing settings include **Test isolated computer audio**. It exercises
the same OS route used by a real share and reports the capture stage, format,
and packet delivery directly instead of inferring availability from Chromium's
microphone-device list.

Computer sound never uses Chromium's whole-render-mix loopback:

- On Windows, application/window shares capture only the selected process tree.
  Full-display shares capture all render streams except Knot and its children.
  This uses the Windows process-loopback API available on Windows 10 build
  20348 and newer.
- On Linux/PipeWire, Knot creates a temporary share sink, keeps every Knot
  process on the real output, routes other applications through the share sink,
  and captures its monitor directly as stereo 48 kHz PCM. The original default
  output and moved streams are restored when sharing stops or capture fails.

This process isolation prevents Knot's incoming voice audio from entering the
screen share, so the viewer does not hear their own voice.

## Run in a browser (optional)

The browser version remains available for testing. Serve this folder over localhost or HTTPS; Web Crypto and WebRTC are restricted in insecure contexts in many browsers.

```powershell
py -m http.server 5173
```

Open `http://localhost:5173` in two browser windows. For a real friend-to-friend connection, the prototype uses manual offer/answer exchange and public STUN servers, so it works when the peers can establish a direct route but may fail across restrictive NATs. Set `PAIR_TURN` in the desktop app to use your own TURN relay; it only relays already-encrypted bytes.

## Direct pairing (default — no server)

1. Person A clicks **Create invite** and sends the pairing code to Person B.
2. Person B pastes it, clicks **Create reply**, and sends the generated code back.
3. Person A pastes the reply and clicks **Apply reply**.

This uses no Knot server. It can connect directly when the two networks permit
WebRTC peer-to-peer traffic. Some NAT/firewall combinations cannot accept a
direct connection; those require a TURN relay supplied by the people using it.

## Optional self-hosted signaling

### Cloudflare Worker (recommended)

The repository includes three SQLite-backed Durable Object classes. `PairDirectory`
stores authenticated device identity, friend relationships, presence, server
membership, content-addressed image references, and text/voice channel metadata.
`PairDirectoryShardV2` holds versioned public directory records during a gradual
dual-read/dual-write migration. `PairRoom`
is no longer used for friend calls (it stays for older clients): a call keeps no server
state beyond one presence line per person, and its WebRTC setup travels through the
directory socket's stateless relay. The Worker rejects binary frames
and handles only authenticated, opaque client-encrypted text and group-key
envelopes. Direct- and group-DM ciphertext uses a bounded 256-message/8 MiB
mailbox per recipient with a 30-day TTL and is removed after recipient
acknowledgement; server text and group-key envelopes remain live-only. It never relays files, video, or screen
shares. The normal deployment has no R2 binding and no managed SFU secrets. When a direct path has not connected a few seconds after the two sides exchanged
descriptions, the app can ask for short-lived Cloudflare TURN credentials and retry with the
relay added (a call that connects directly never touches it); a relayed call is deliberately
low-bitrate and audio-only.

Cloudflare's Git build command is:

```bash
npx wrangler deploy
```

No build output directory or static-assets directory is needed. The checked-in
`wrangler.jsonc` points directly to `worker/index.js`, preventing Wrangler from
trying to upload the Electron repository or `node_modules` as website assets.
The app keeps the Worker address internal. Five-digit friend and server invites
expire after 15 minutes. Selecting a friend with a registered device key opens
encrypted text immediately, even while that friend is offline; a private
rendezvous room is created only for direct media/files.
Server text uses the encrypted live relay, while voice channels form direct
peer meshes among currently online members. Conversation history stays in each
desktop app's encrypted local SQLite database; SQLite is built into the bundled
Node/Electron runtime and needs no account, database server, or signup. Cloudflare temporarily stores only unreadable
offline direct- and group-DM ciphertext.
Direct DMs also use this rule: text opens immediately without a WebRTC peer;
the app tries direct P2P three times only after a call or file is requested.

### Host signaling from your own PC

Knot no longer starts a signaling server automatically. Direct pairing above is
the normal connection path. If you deliberately want room-code signaling for a
network you control, run it manually:

```bash
npm run signal
```

For localhost testing use `ws://localhost:8787`. For a remote peer, put this server behind a TLS reverse proxy (or supply `PAIR_TLS_KEY` and `PAIR_TLS_CERT` paths) and use `wss://YOUR_DOMAIN:8787`. Both people must use the same room code of at least 16 characters. This service only forwards WebRTC setup messages and stores no chat or file data.

If Windows Firewall asks whether Node.js can accept connections, allow it on the intended network. If your ISP uses CGNAT, port forwarding will not work; you would need a public VPS or a VPN overlay.

## How a DM call connects

- **Ringing is presence, not a connection.** Pressing Call publishes one short
  presence line (`call-presence`) to your friend and repeats it every 8 seconds
  while you are in the call. Their Knot rings immediately, whether or not the
  audio connection can be built yet, and whether or not they have your DM open.
  Pressing Call while your friend is already in a call joins it. If you both
  press at the same moment, the two calls merge into one.
- **The connection is built while it rings.** Your Knot offers a WebRTC
  connection straight away (voice, chat and files together) and your friend's
  Knot answers it in the background, so by the time they press Join the
  microphone only has to be attached. Network candidates are sent as they are
  found instead of waiting for all of them.
- **Either side can change the call at any time.** Offers and answers follow
  the "perfect negotiation" pattern, so two changes at once (both starting a
  share, both reconnecting) settle on their own, and every message is safe to
  receive twice. Anything lost while Knot was offline is sent again when it
  reconnects.
- **Direct first, relay only if needed.** If nothing has connected about six
  seconds after the two sides exchanged descriptions, the TURN relay is added
  and ICE restarts once.
- **No call state on the server.** Signalling uses the directory socket's
  stateless relay; the Worker keeps nothing about the call. Between calls the
  connection stays up for an instant redial but sends no audio.

## TURN fallback for restrictive networks

WebRTC cannot always connect two peers on different home networks directly —
symmetric NATs and restrictive firewalls can block direct ICE candidates. Knot
tries a direct P2P connection first and sends its network candidates as they are
found. If nothing has connected after about six seconds it adds the TURN relay and
restarts ICE once. When the connection that results goes through the relay it forces
low-bitrate Opus voice (24 kbps) and disables file transfer and screen/video sharing. Text remains
on the separately encrypted Cloudflare mailbox/relay.

### Cloudflare Realtime TURN (recommended optional fallback)

Create a TURN key in Cloudflare Realtime, then give the deployed Worker only
the key ID and a narrowly scoped API token. Never put either secret in the app:

```bash
npx wrangler secret put TURN_KEY_ID
npx wrangler secret put TURN_API_TOKEN
npx wrangler deploy
```

The Worker exchanges those secrets for a one-hour, per-client ICE credential
only after direct P2P has failed. Without both secrets, Knot remains fully
usable for encrypted text and direct P2P media/files; it simply reports that
the voice relay is unavailable.

Cloudflare currently includes the first 1,000 GB/month of Realtime TURN usage;
standalone TURN is then $0.05 per GB of Cloudflare-to-client egress. Check the
[Cloudflare TURN pricing FAQ](https://developers.cloudflare.com/realtime/turn/faq/)
before enabling it and set a billing alert. TURN still sees only encrypted
WebRTC transport bytes, not chat plaintext or file contents.

### Self-hosted coturn alternative

If you prefer not to use Cloudflare Realtime TURN, run a self-hosted TURN relay
on the host's PC via Docker. Set `PAIR_TURN` in the desktop app on both devices;
Knot uses it only after the direct attempt has not connected.

**One-time setup:**

1. Forward these ports on your router to this PC's LAN IP (replace `YOUR_LAN_IP` with your actual LAN IP, e.g. `YOUR_LAN_IP`):
   - TCP `3481` → internal `3478` (port 3478 was already taken by another device on this router)
   - UDP `3481` → internal `3478`
   - UDP `50100–50200` → internal `50100–50200` (the relay port range coturn uses; the 49152–49551 range is reserved by Windows)
2. Start Docker Desktop, then double-click `coturn\start-coturn.bat` (or run `docker compose -f coturn\docker-compose.yml up -d`). coturn auto-restarts across reboots while Docker is running, so TURN stays available whenever either peer opens the app.
3. Replace `YOUR_PUBLIC_IP`, `YOUR_LAN_IP`, and `CHANGE_THIS_TO_A_LONG_RANDOM_SECRET` in `turnserver.conf` before starting. Generate the password with a password manager or `openssl rand -hex 32`.
4. Start Knot with the same relay credentials on both devices (the app deliberately has no baked-in TURN password):

```bash
PAIR_TURN='[{"urls":["turn:YOUR_HOST:3481?transport=udp","turn:YOUR_HOST:3481?transport=tcp"],"username":"pair","credential":"YOUR_SECRET"}]' npm start
```

To verify it's reachable from outside your network, run from any other machine:

```bash
docker logs pair-coturn          # local: should show no errors and several "allocate" lines after a call
```

To rotate the credential later: edit `coturn\turnserver.conf` (`user=pair:...` line), restart coturn, then start Knot with a matching `PAIR_TURN` value on both devices. No rebuild is needed:

```bash
set PAIR_TURN=[{"urls":"turn:YOUR_HOST:3481","username":"pair","credential":"YOUR_SECRET"}]
```

TURN only relays already-encrypted WebRTC bytes (DTLS-SRTP); it cannot read any chat, file, or voice content.

## Large files

Files are sliced into independently authenticated chunks. WebRTC uses an adaptive
8–48 MiB send window with a bounded 32 MiB encryption look-ahead; receiving is
capped at 64 MiB per transfer and 96 MiB across active transfers before
backpressure stops the sender. Files no longer use a TCP lane: it needed a forwarded
router port and delayed every first transfer, so Knot refuses a TCP offer from an older
version and carries on over the direct connection.

### Fast UDP lane

A WebRTC data channel is window-limited: over an 80 ms path it tops out near 14 Mbit/s
and falls to about 1 Mbit/s at 1% packet loss, however fast the connection is. When both
Knots support it, a transfer therefore runs over a UDX stream (reliable, congestion
controlled UDP, `udx-native`) instead. The two Knots swap UDP endpoints over their
authenticated WebRTC session, find their public addresses with STUN, punch through their
NATs, and then run the same one-time-token handshake and AES-GCM framing as before over the
stream, so UDX itself is trusted with nothing. The lane is probed while the receiver is
still choosing whether to accept, and a transfer uses the WebRTC connection when the lane
does not come up (a symmetric NAT, a blocked UDP path, an older Knot) or when **Settings →
File transfers → Fast direct transfer (UDP)** is off.

Measured through two emulated NAT routers at 80 ms round trip: 385 Mbit/s clean, 267 at
2% loss and 147 at 5%, against 14, 0.8 and 0.6 for one WebRTC data channel. The first
punches carry a TTL of 2 or 3 so they open each side's own router without reaching the
other, and normal punches are released only once both sides have said they are armed;
without that, a punch that arrives early makes a Linux NAT remap the sender's port and
neither side reaches the other. The STUN servers' addresses are looked up with a resolver that retries a lost packet after 0.6 s (the system lookup
waits 5 s), in parallel, capped, cached and refreshed in the background shortly after Knot starts, so a lost DNS packet can no longer hold a
lane up for seconds; the lane also asks for 8 MiB UDP socket buffers (the kernel grants what `net.core.rmem_max` / `wmem_max` allow). The whole file is never loaded into memory during a normal direct send or desktop
receive. Receiving very large files requires a Chromium browser with the File
System Access API or the Knot app's durable temporary-file/atomic-rename path;
the in-memory browser fallback is limited to 64 MiB. The 200 GiB direct-transfer
limit is enforced on both endpoints. The optional object relay is separately
capped at 64 MiB, encrypts locally, uses direct exact-size presigned requests,
and remains disabled unless the operator confirms automatic lifecycle deletion.

Knot has automated adversarial tests for transfer framing, replay/reordering,
IPC ownership, memory bounds, cancellation, durable saves, and update signatures.
It is still not a third-party security audit; verify device identities out of
band before treating a new friend/account as trusted, and keep the app updated.
