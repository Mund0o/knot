# Knot

Knot is a small-group P2P communication app with saved friends, live presence,
direct messages, and servers containing text and voice channels. It uses WebRTC
data channels and media tracks for content transport. Direct messages also use
Web Crypto ECDH + AES-GCM on top of WebRTC's DTLS encryption.

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
has a newer version, Knot downloads the appropriate package, verifies its
SHA-256 checksum, installs it, and restarts automatically.

## Screen sharing architecture

Knot sends screen video, computer sound, and voice as separate WebRTC tracks.
Screen capture defaults to 1080p60, prefers broadly hardware-accelerated H.264,
retains retransmission/FEC codecs, and keeps every video target below a 60 Mbps
user ceiling. The 4K60 profile targets 56 Mbps, leaving useful headroom on an
88 Mbps upload instead of forcing an SDP bitrate that can build latency. WebRTC
can adapt below the ceiling, and repeated encoder overload first falls back to
30 fps and then to a reduced render scale so sharing cannot make the whole app
unresponsive. The selected AV1 mode is negotiated normally and only falls back
to H.264 after the receiver confirms that AV1 packets arrive without decoded
frames.

On Linux systems with both integrated and discrete graphics, Knot excludes the
integrated render node and sends WebRTC video encode/decode work to the main
discrete GPU. PipeWire capture import remains compositor-managed so Wayland
screen shares continue to produce valid frames.

`npm test` validates navigation, capture constraints, congestion-safe sender
parameters, overload recovery, isolated audio delivery, H.264 transport, and
AV1 transport with live decode. Set `PAIR_TEST_4K60=1` when running an individual
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
and never relays messages, files, calls, or screen shares.

Cloudflare's Git build command is:

```bash
npx wrangler deploy
```

No build output directory or static-assets directory is needed. The checked-in
`wrangler.jsonc` points directly to `worker/index.js`, preventing Wrangler from
trying to upload the Electron repository or `node_modules` as website assets.
The app keeps the Worker address internal. Five-digit friend and server invites
expire after 15 minutes. Selecting an online friend automatically creates a
private rendezvous room, while server text and voice channels form direct peer
meshes among currently online members. Conversation history stays in each
desktop app's local settings file; offline content is not stored by Cloudflare.

### Host signaling from your own PC

Knot no longer starts a signaling server automatically. Direct pairing above is
the normal connection path. If you deliberately want room-code signaling for a
network you control, run it manually:

```bash
npm run signal
```

For localhost testing use `ws://localhost:8787`. For a remote peer, put this server behind a TLS reverse proxy (or supply `PAIR_TLS_KEY` and `PAIR_TLS_CERT` paths) and use `wss://YOUR_DOMAIN:8787`. Both people must use the same room code of at least 16 characters. This service only forwards WebRTC setup messages and stores no chat or file data.

If Windows Firewall asks whether Node.js can accept connections, allow it on the intended network. If your ISP uses CGNAT, port forwarding will not work; you would need a public VPS or a VPN overlay.

## TURN relay (fixes "Offer sent. Connecting…" hang across networks)

WebRTC cannot always connect two peers on different home networks directly — symmetric NAT blocks the direct ICE candidates, and without a relay the connection silently hangs even though signaling succeeded. The fix is a self-hosted TURN relay running on the host's PC via Docker.

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
