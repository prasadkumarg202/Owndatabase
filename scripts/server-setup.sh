#!/usr/bin/env bash
# Prepares a fresh Ubuntu 22.04 / 24.04 server for OwnDatabase (docs/deploy.md). Run as root:
#   bash scripts/server-setup.sh
# Installs Docker, opens only SSH / HTTP / HTTPS in the firewall, adds swap, turns on automatic
# security updates and fail2ban for SSH. Safe to run again.
set -euo pipefail
[ "$(id -u)" = 0 ] || { echo "run as root"; exit 1; }
export DEBIAN_FRONTEND=noninteractive

echo "→ packages"
apt-get update -q
apt-get upgrade -yq
apt-get install -yq ca-certificates curl git ufw fail2ban unattended-upgrades openssl

echo "→ docker"
if ! command -v docker >/dev/null; then
  curl -fsSL https://get.docker.com | sh
fi
systemctl enable --now docker
# container logs are rotated (otherwise they grow without limit)
if [ ! -f /etc/docker/daemon.json ]; then
  printf '{\n  "log-driver": "json-file",\n  "log-opts": { "max-size": "20m", "max-file": "5" }\n}\n' > /etc/docker/daemon.json
  systemctl restart docker
fi

echo "→ firewall: SSH, HTTP, HTTPS only"
ufw allow OpenSSH >/dev/null
ufw allow 80/tcp >/dev/null
ufw allow 443/tcp >/dev/null
ufw --force enable >/dev/null
# Docker publishes ports past ufw; only Caddy (80/443) publishes any, Postgres and the rest stay internal

echo "→ swap"
if ! swapon --show | grep -q /swapfile; then
  fallocate -l 4G /swapfile
  chmod 600 /swapfile
  mkswap /swapfile >/dev/null
  swapon /swapfile
  grep -q '^/swapfile' /etc/fstab || echo '/swapfile none swap sw 0 0' >> /etc/fstab
fi
sysctl -q -w vm.swappiness=10 && echo 'vm.swappiness=10' > /etc/sysctl.d/99-owndatabase.conf
# Redis wants overcommit for background saves
sysctl -q -w vm.overcommit_memory=1 && echo 'vm.overcommit_memory=1' >> /etc/sysctl.d/99-owndatabase.conf

echo "→ automatic security updates, fail2ban"
dpkg-reconfigure -f noninteractive unattended-upgrades >/dev/null
systemctl enable --now fail2ban >/dev/null

docker --version
docker compose version
echo "✓ server ready"
