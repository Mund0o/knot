# Pair

Pair is a two-person, no-account P2P chat prototype. It uses WebRTC data channels for transport and Web Crypto ECDH + AES-GCM for an application-level encryption layer on top of WebRTC's DTLS encryption.

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

The tarball will be created in the `dist` folder.

## Build a Windows release

Run these commands from a Windows machine with Node.js and Visual Studio Build
Tools installed. The first command recompiles the optional WASAPI capture addon
against Pair's current Electron version; the installer still works with its
JavaScript audio fallback if that addon is unavailable.

```powershell
npm install
npm run rebuild:addon
npm run dist:win
```

The installer is created as `dist\Pair Setup <version>.exe`. To make a matched
Windows + Linux release and update manifest, run `npm run dist:all` followed by
`npm run publish`. Upload both installers to the matching GitHub release before
committing/pushing `public/latest.json`.

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

This uses no Pair server. It can connect directly when the two networks permit
WebRTC peer-to-peer traffic. Some NAT/firewall combinations cannot accept a
direct connection; those require a TURN relay supplied by the people using it.

## Optional self-hosted signaling

## Host signaling from your own PC

Pair no longer starts a signaling server automatically. Direct pairing above is
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
4. Start Pair with the same relay credentials on both devices (the app deliberately has no baked-in TURN password):

```bash
PAIR_TURN='[{"urls":["turn:YOUR_HOST:3481?transport=udp","turn:YOUR_HOST:3481?transport=tcp"],"username":"pair","credential":"YOUR_SECRET"}]' npm start
```

To verify it's reachable from outside your network, run from any other machine:

```bash
docker logs pair-coturn          # local: should show no errors and several "allocate" lines after a call
```

To rotate the credential later: edit `coturn\turnserver.conf` (`user=pair:...` line), restart coturn, then start Pair with a matching `PAIR_TURN` value on both devices. No rebuild is needed:

```bash
set PAIR_TURN=[{"urls":"turn:YOUR_HOST:3481","username":"pair","credential":"YOUR_SECRET"}]
```

TURN only relays already-encrypted WebRTC bytes (DTLS-SRTP); it cannot read any chat, file, or voice content.

## Large files

Files are sliced into chunks, encrypted independently, and streamed with a 128 MB in-flight window plus concurrent encrypt/decrypt work so a single direct wired peer can keep a fast SCTP link saturated. The whole file is never loaded into memory during sending. Receiving very large files requires a Chromium browser with the File System Access API (or the Pair app's disk streaming); otherwise the fallback collects chunks in memory and is suitable only for smaller files. The 200 GiB limit is enforced on both send and receive.

This is an MVP, not a production security audit. Before relying on it for sensitive data, add authenticated device identity/fingerprint verification, replay protection, a robust signaling UX, TURN support, and audited cryptographic protocol implementations.
