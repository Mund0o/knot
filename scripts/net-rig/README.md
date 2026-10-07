# Network rig

Measures file-transfer transports over an emulated internet path, without root and without
touching your real network. Everything runs in throwaway network namespaces created with
`unshare -Urn`, so it needs only Linux with `ip`, `tc` (netem), `nft`, `nsenter`, `node`, and for
the WebRTC runs an Electron binary (`npm i` provides one).

```sh
# The Knot UDP lane through two NAT routers (each side behind its own NAT, a STUN server in the middle).
#   args: one-way delay ms, loss %, cone|symmetric, seconds
COORD=1 LOWTTL='[2]' unshare -Urn bash scripts/net-rig/rig-nat.sh 40 1 cone 12
RATE=20 LIMIT=400 COORD=1 LOWTTL='[2]' unshare -Urn bash scripts/net-rig/rig-nat.sh 40 0.5 cone 12   # 20 Mbit uplink

# WebRTC data channels vs UDX on one emulated link, no NAT.
#   args: one-way delay ms, loss %, rate Mbit (0 = unlimited), webrtc|udx, parallel connections
SECS=12 unshare -Urn bash scripts/net-rig/rig-link.sh 40 1 0 webrtc 1
SECS=12 unshare -Urn bash scripts/net-rig/rig-link.sh 40 1 0 udx 1
```

* `COORD=1` runs the same coordinated punch the app uses (the receiver starts first and holds,
  the sender releases at once and says it is armed). Without it both sides use the fixed hold.
* `LOWTTL='[2]'` suits this rig, whose path is three hops. The app's default is `[2, 3]`.
* `SKEW=<ms>` delays the sender's start to test how much start-time difference is tolerated.
* `symmetric` makes both NATs pick a new source port per destination: punching must fail and the
  app falls back to WebRTC.
* Do not add jitter to the emulated link. Out-of-order packets make a data channel's transport
  read reordering as loss and collapse, which is not what this rig is for.

Results are printed as one JSON line per side (`steadyMbit` is goodput after a 3-4 second warm-up).
The README at the project root has the numbers these produced.
