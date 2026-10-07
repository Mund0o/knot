#!/bin/bash
HERE="$(cd "$(dirname "$0")" && pwd)"; OUT="${RIG_OUT:-/tmp/knot-net-rig}"; SIG="$OUT/sig"; mkdir -p "$OUT"
# usage (run via: unshare -Urn bash rig.sh <delayMs> <lossPct> <rateMbit|0> <proto> [streams])
D=${1:-40}; L=${2:-0}; R=${3:-0}; PROTO=${4:-udx}; N=${5:-1}; SECS=${SECS:-14}
ELECTRON="${ELECTRON:-$HERE/../../node_modules/electron/dist/electron}"
ip link set lo up
unshare -n sleep 600 & NSPID=$!; sleep 0.4
ip link add vA type veth peer name vB; ip link set vB netns $NSPID
ip addr add 10.9.0.1/24 dev vA; ip link set vA up
nsenter -t $NSPID -n sh -c 'ip link set lo up; ip addr add 10.9.0.2/24 dev vB; ip link set vB up'
RATE=""; [ "$R" != "0" ] && RATE="rate ${R}mbit"
NETEM="delay ${D}ms loss ${L}% limit 200000 $RATE"
tc qdisc add dev vA root netem $NETEM
nsenter -t $NSPID -n tc qdisc add dev vB root netem $NETEM
rm -rf $SIG && mkdir -p $SIG
if [ "$PROTO" = "udx" ]; then
  ( nsenter -t $NSPID -n node "$HERE/udx-bench.js" recv 10.9.0.2 10.9.0.1 $SECS $N > $OUT/out.txt 2>&1 ) &
  RP=$!; sleep 0.5; node "$HERE/udx-bench.js" send 10.9.0.1 10.9.0.2 $SECS $N > /dev/null 2>&1; wait $RP
else
  ( nsenter -t $NSPID -n env ROLE=answer SIGDIR=$SIG SECS=$SECS CONNS=$N "$ELECTRON" --no-sandbox --ozone-platform=x11 "$HERE/webrtc-bench.js" > $OUT/out.txt 2>&1 ) &
  RP=$!; sleep 1; env ROLE=offer SIGDIR=$SIG SECS=$SECS CONNS=$N "$ELECTRON" --no-sandbox --ozone-platform=x11 "$HERE/webrtc-bench.js" > $OUT/offer.txt 2>&1; wait $RP
fi
echo "rtt=$((D*2))ms loss=${L}% rate=${R:-0}: $(grep -E '^(RESULT )?\{' $OUT/out.txt | sed 's/^RESULT //' | tail -1)"
kill $NSPID 2>/dev/null
