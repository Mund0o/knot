#!/bin/bash
# The real share stack across an emulated internet path, without root (throwaway namespaces).
#   unshare -Urn bash scripts/net-rig/rig-share.sh <oneWayDelayMs> <lossPct> <clip.ivf> [seconds] [rateMbit|0]
# e.g. 40 ms each way is an 80 ms round trip. Prints one JSON line per side; both sha256 values must match.
HERE="$(cd "$(dirname "$0")" && pwd)"; OUT="${RIG_OUT:-/tmp/knot-share-rig}"; SIG="$OUT/sig"
D=${1:-40}; L=${2:-0}; CLIP=${3:?clip.ivf}; SECS=${4:-12}; R=${5:-0}
mkdir -p "$OUT"; rm -rf "$SIG"; mkdir -p "$SIG"
ip link set lo up
unshare -n sleep 300 & NSPID=$!; sleep 0.4
ip link add vA type veth peer name vB; ip link set vB netns $NSPID
ip addr add 10.9.0.1/24 dev vA; ip link set vA up
nsenter -t $NSPID -n sh -c 'ip link set lo up; ip addr add 10.9.0.2/24 dev vB; ip link set vB up'
RATE=""; [ "$R" != "0" ] && RATE="rate ${R}mbit"
NETEM="delay ${D}ms loss ${L}% limit 200000 $RATE"
tc qdisc add dev vA root netem $NETEM
nsenter -t $NSPID -n tc qdisc add dev vB root netem $NETEM
( nsenter -t $NSPID -n node "$HERE/share-bench.js" recv 10.9.0.2 10.9.0.1 $SECS "$CLIP" "$SIG" > "$OUT/recv.txt" 2>&1 ) & RP=$!
sleep 0.5
node "$HERE/share-bench.js" send 10.9.0.1 10.9.0.2 $SECS "$CLIP" "$SIG" > "$OUT/send.txt" 2>&1
wait $RP
S=$(grep -o '"sha256":"[0-9a-f]*"' "$OUT/send.txt" | tail -1); V=$(grep -o '"sha256":"[0-9a-f]*"' "$OUT/recv.txt" | tail -1)
if [ -n "$S" ] && [ "$S" = "$V" ]; then MATCH="IDENTICAL"; else MATCH="DIFFERENT"; fi
echo "rtt=$((D*2))ms loss=${L}% rate=${R} : bytes $MATCH"
tail -1 "$OUT/recv.txt"; tail -1 "$OUT/send.txt"
kill $NSPID 2>/dev/null
