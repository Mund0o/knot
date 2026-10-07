#!/bin/bash
HERE="$(cd "$(dirname "$0")" && pwd)"; OUT="${RIG_OUT:-/tmp/knot-net-rig}"; SIG="$OUT/sig"; mkdir -p "$OUT"; export RIG_SIG="$SIG"
# usage: unshare -Urn bash rig2.sh <oneWayDelayMs> <lossPct> <cone|symmetric|direct> <secs>
D=${1:-40}; L=${2:-0}; MODE=${3:-cone}; SECS=${4:-12}
ip link set lo up
for n in A R1 R2 B; do unshare -n sleep 900 & eval "P_$n=$!"; done; sleep 0.6
ns(){ local pid=$1; shift; nsenter -t $pid -n "$@"; }
for n in A R1 R2 B; do p=P_$n; ns ${!p} ip link set lo up; done
ip link add a_r1 type veth peer name r1_a; ip link set a_r1 netns $P_A; ip link set r1_a netns $P_R1
ip link add r1_w type veth peer name i_w1; ip link set r1_w netns $P_R1
ip link add b_r2 type veth peer name r2_b; ip link set b_r2 netns $P_B; ip link set r2_b netns $P_R2
ip link add r2_w type veth peer name i_w2; ip link set r2_w netns $P_R2
ns $P_A sh -c 'ip addr add 10.1.0.2/24 dev a_r1; ip link set a_r1 up; ip route add default via 10.1.0.1'
ns $P_B sh -c 'ip addr add 10.2.0.2/24 dev b_r2; ip link set b_r2 up; ip route add default via 10.2.0.1'
NATRULE="masquerade"; [ "$MODE" = "symmetric" ] && NATRULE="masquerade random"
ns $P_R1 sh -c "ip addr add 10.1.0.1/24 dev r1_a; ip addr add 100.64.1.1/24 dev r1_w; ip link set r1_a up; ip link set r1_w up; ip route add default via 100.64.1.254; echo 1 > /proc/sys/net/ipv4/ip_forward; nft add table ip nat; nft add chain ip nat post '{ type nat hook postrouting priority 100; }'; nft add rule ip nat post oifname r1_w $NATRULE"
ns $P_R2 sh -c "ip addr add 10.2.0.1/24 dev r2_b; ip addr add 100.64.2.1/24 dev r2_w; ip link set r2_b up; ip link set r2_w up; ip route add default via 100.64.2.254; echo 1 > /proc/sys/net/ipv4/ip_forward; nft add table ip nat; nft add chain ip nat post '{ type nat hook postrouting priority 100; }'; nft add rule ip nat post oifname r2_w $NATRULE"
ip addr add 100.64.1.254/24 dev i_w1; ip addr add 100.64.2.254/24 dev i_w2; ip link set i_w1 up; ip link set i_w2 up; echo 1 > /proc/sys/net/ipv4/ip_forward
R=""; [ -n "$RATE" ] && R="rate ${RATE}mbit"; LIM=${LIMIT:-100000}
tc qdisc add dev i_w1 root netem delay ${D}ms loss ${L}% limit $LIM $R
tc qdisc add dev i_w2 root netem delay ${D}ms loss ${L}% limit $LIM $R
node "$HERE/stun-server.js" & STUNPID=$!
rm -rf $SIG; mkdir -p $SIG
node -e "const c=require('crypto');require('fs').writeFileSync('$SIG/secret.json',JSON.stringify({key:c.randomBytes(32).toString('hex'),token:c.randomBytes(24).toString('hex')}))"
STUNA=100.64.1.254; STUNB=100.64.2.254
ns $P_B node "$HERE/lane-bench.js" B $STUNB $SECS > $OUT/laneB.txt 2>&1 &
RB=$!; sleep 0.4
ns $P_A node "$HERE/lane-bench.js" A $STUNA $SECS > $OUT/laneA.txt 2>&1
wait $RB
if [ -n "$DUMPCT" ]; then echo "--- R1 conntrack"; ns $P_R1 cat /proc/net/nf_conntrack 2>/dev/null | grep udp | cut -c1-200; echo "--- R2 conntrack"; ns $P_R2 cat /proc/net/nf_conntrack 2>/dev/null | grep udp | cut -c1-200; fi
echo "oneWay=${D}ms (rtt $((D*2))ms) loss=${L}% nat=$MODE :: B=$(tail -1 $OUT/laneB.txt) | A=$(tail -1 $OUT/laneA.txt)"
kill $STUNPID $P_A $P_B $P_R1 $P_R2 2>/dev/null
