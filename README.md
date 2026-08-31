# Knot

Knot is a small-group P2P communication app with saved friends, live presence,
direct and group DMs, and servers containing text and voice channels. It uses
WebRTC data channels and media tracks for content transport. Direct and group
messages use Web Crypto ECDH + AES-GCM on top of authenticated WSS transport;
calls use WebRTC's DTLS-SRTP encryption.

Cloudflare supplies an encrypted text mailbox, presence, and WebRTC setup.
Opening a DM or text channel does not create a peer connection: text is
encrypted on-device; offline direct- and group-DM ciphertext is held for up to
30 days in a bounded mailbox and deleted separately for each recipient after
their device decrypts and acknowledges it.
Cloudflare never receives the message keys or readable text. Calls, screen shares, and files create direct WebRTC
connections only when used. Screen shares appear beside their owners and open
into a single focused viewer; use a stream's context menu to stop watching
without making the stream undiscoverable. Fullscreen expands the selected share
stage, not the entire Knot interface.

## Group direct messages

Choose **New group DM** from Direct Messages, or open a friend's DM and choose
**Create group** to carry that friend into a new conversation. A group contains
3–10 people. Existing members can add their own friends, and leaving transfers
ownership when needed.

Group text is end-to-end encrypted with an epoch-bound key that rotates after
membership changes. Each recipient gets an independent opaque offline envelope.
Group calls form an on-demand WebRTC mesh only among members currently joined to
the group's voice room. If a two-person call is active while its DM is converted
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

Knot keeps screen video, computer sound, and voice on separate WebRTC paths.
The share dialog explicitly selects the source, resolution, frame rate, and
sound setting before Go Live. A selected 4K60 stream starts and remains at
3840×2160/60 instead of stepping through lower resolutions; congestion is
reported and stale frames may be discarded, but the selected dimensions are
not changed. Chromium shares prefer broadly hardware-accelerated codecs and
retain retransmission/FEC support under a user-controlled bitrate ceiling.

Native AV1 keeps 3840×2160 capture at 60 fps while targeting about 9.8 Mbps so
fine motion has more detail. NVENC uses spatial adaptive quantization without
lookahead so visible block edges receive better allocation without buffering
future frames, while strict GOP rate control contains scene-change bursts.
Native capture follows changing content instead of
manufacturing duplicate frames when a heavy game misses a deadline, and emits
each encoded frame as its own live WebM cluster instead of an eight-frame burst.
Its low-priority, unordered, one-retransmit
transport uses a 1 MiB segment-aware admission budget, drops stale deltas, and
recovers at 150 ms keyframes. Mic audio remains high
priority. Congestion stays on efficient AV1; only a decoder failure or
incompatible client switches that viewer to a bandwidth-capped compatibility
codec without changing the chosen resolution.

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
the main discrete card, and uses NVENC on NVIDIA or VA-API on AMD for its native
GPU-only AV1 screen route. The 4K60 route measures segment-arrival-to-presentation
latency, targets 100 ms on WebCodecs, and caps the MediaSource safety path at
150 ms without faster-than-display playback. If a Linux driver advertises AV1
decoding but rejects or silently
stalls on the stream, Knot retries with CPU decode as the necessary compatibility
fallback while capture and encode remain on the discrete GPU. Decoded frames feed
a generated video track directly into Chromium's compositor instead of copying
every 4K frame through a renderer canvas. The sender's own preview never falls back to CPU AV1 decode;
if hardware preview decode is unavailable, Knot shows a lightweight live-share
placeholder. A receiver that cannot decode AV1 within the 100 ms target requests
H.264 rather than remaining black or accumulating stale frames.
PipeWire capture import remains compositor-managed so Wayland screen shares
continue to produce valid frames. Audio processing, encryption, networking,
IPC, and file I/O stay on the CPU because Electron provides no dependable GPU
implementation for those jobs.

`npm test` validates navigation, capture constraints, congestion-safe sender
parameters, overload recovery, isolated audio delivery, H.264 transport, live
AV1 decode, and two complete Knot app windows sharing 4K60 with voice over a
bursty constrained uplink. Set `PAIR_TEST_4K60=1` when running an individual
codec test to turn it into a strict local 4K60 hardware stress benchmark.

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

The repository includes two SQLite-backed Durable Objects. `PairDirectory`
stores authenticated device identity, friend relationships, presence, server
membership, server pictures, and text/voice channel metadata. `PairRoom`
coordinates ephemeral two-person WebRTC setup. The Worker rejects binary frames
and handles only authenticated, opaque client-encrypted text and group-key
envelopes. Direct- and group-DM ciphertext uses a bounded 256-message/8 MiB
mailbox per recipient with a 30-day TTL and is removed after recipient
acknowledgement; server text and group-key envelopes remain live-only. It never relays files, video, or screen
shares. After three failed direct attempts, it can optionally issue short-lived
Cloudflare TURN credentials for a deliberately low-bitrate audio-only call.

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
desktop app's local settings file; Cloudflare temporarily stores only unreadable
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

## TURN fallback for restrictive networks

WebRTC cannot always connect two peers on different home networks directly —
symmetric NATs and restrictive firewalls can block direct ICE candidates. Knot
tries a direct P2P connection three times. Only then does it offer a TURN
fallback. In relay mode it forces low-bitrate Opus voice (24 kbps), disables
file transfer and screen/video sharing, and uses relay-only ICE. Text remains
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
Knot uses it only after the same three direct attempts fail.

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

Files are sliced into chunks, encrypted independently, and streamed with a 128 MB in-flight window plus concurrent encrypt/decrypt work so a single direct wired peer can keep a fast SCTP link saturated. The whole file is never loaded into memory during sending. Receiving very large files requires a Chromium browser with the File System Access API (or the Knot app's disk streaming); otherwise the fallback collects chunks in memory and is suitable only for smaller files. The 200 GiB limit is enforced on both send and receive.

This is an MVP, not a production security audit. Before relying on it for sensitive data, add authenticated device identity/fingerprint verification, replay protection, a robust signaling UX, TURN support, and audited cryptographic protocol implementations.
