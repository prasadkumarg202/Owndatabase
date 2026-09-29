#!/bin/sh
# Firewall for function processes (uids 20000-29999), then start the runtime
# without NET_ADMIN so nothing started later can change these rules.
#
# Functions may reach: Docker DNS, the platform gateway, and the public
# internet. Everything private / internal is rejected.
set -eu

UIDS=20000-29999
ipt() { iptables -w "$@"; }

ipt -F OUTPUT
# Docker's embedded DNS. Its NAT rules rewrite port 53 to a random port before
# the filter table sees the packet, so allow the address, not the port.
ipt -A OUTPUT -m owner --uid-owner "$UIDS" -d 127.0.0.11 -j ACCEPT

# The platform gateway (FUNCTIONS_GATEWAY_HOST, default "gateway"), port 80 only
GATEWAY_HOST="${FUNCTIONS_GATEWAY_HOST:-gateway}"
for i in $(seq 1 30); do
  GATEWAY_IPS=$(getent ahostsv4 "$GATEWAY_HOST" 2>/dev/null | awk '{print $1}' | sort -u) || true
  [ -n "$GATEWAY_IPS" ] && break
  sleep 1
done
for ip in ${GATEWAY_IPS:-}; do
  ipt -A OUTPUT -m owner --uid-owner "$UIDS" -d "$ip" -p tcp --dport 80 -j ACCEPT
  echo "functions-runtime: gateway $GATEWAY_HOST -> $ip:80 allowed"
done
[ -z "${GATEWAY_IPS:-}" ] && echo "functions-runtime: WARNING gateway '$GATEWAY_HOST' not resolvable; functions cannot call the platform"

for net in 0.0.0.0/8 10.0.0.0/8 100.64.0.0/10 127.0.0.0/8 169.254.0.0/16 172.16.0.0/12 \
           192.0.0.0/24 192.168.0.0/16 198.18.0.0/15 224.0.0.0/4 240.0.0.0/4; do
  ipt -A OUTPUT -m owner --uid-owner "$UIDS" -d "$net" -j REJECT
done

# No IPv6 for functions (the Docker networks are IPv4); fail closed if ip6tables works
if ip6tables -w -L OUTPUT >/dev/null 2>&1; then
  ip6tables -w -F OUTPUT
  ip6tables -w -A OUTPUT -m owner --uid-owner "$UIDS" -j REJECT
fi

mkdir -p "${WORK_DIR:-/work}"
chmod 0711 "${WORK_DIR:-/work}"

exec setpriv --bounding-set -net_admin,-net_raw --inh-caps -all -- node /app/server.mjs
