#!/usr/bin/env bash
# Pull latest, install deps, restart noahbot services.
# Replaces fresh_deploy.sh for systemd-managed setups.
set -euo pipefail

cd "$(dirname "$(readlink -f "$0")")/.."

echo "[1/3] git pull"
git pull --ff-only

echo "[2/3] npm install"
npm install --silent

echo "[3/3] restart services"
systemctl --user restart noahbot-api.service noahbot-web.service

echo
echo "Done. Status:"
systemctl --user --no-pager --lines=0 status noahbot-api.service noahbot-web.service || true
echo
echo "Tail logs:  journalctl --user -u noahbot-api -u noahbot-web -f"
