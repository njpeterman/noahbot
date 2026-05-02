#!/usr/bin/env bash
# Pull latest, restart playlist-builder dev servers, leave them running detached.
# Run from anywhere — script cd's to its own directory first.
set -euo pipefail

cd "$(dirname "$(readlink -f "$0")")"

API_PORT=3002
WEB_PORT=5173
LOG_DIR="logs"

echo "[1/4] git pull"
git pull --ff-only

echo "[2/4] stopping old playlist-builder processes (ports $API_PORT, $WEB_PORT)"
fuser -k "${API_PORT}/tcp" 2>/dev/null || true
fuser -k "${WEB_PORT}/tcp" 2>/dev/null || true
# Brief pause so the kernel actually releases the ports before we rebind.
sleep 1

echo "[3/4] npm install"
npm install --silent

echo "[4/4] starting servers"
mkdir -p "$LOG_DIR"
nohup npm run dev:playlist-api >"$LOG_DIR/playlist-api.log" 2>&1 &
api_pid=$!
nohup npm run dev:playlist-web >"$LOG_DIR/playlist-web.log" 2>&1 &
web_pid=$!
disown "$api_pid" "$web_pid"

cat <<EOF

api  pid=$api_pid  port=$API_PORT  log=$LOG_DIR/playlist-api.log
web  pid=$web_pid  port=$WEB_PORT  log=$LOG_DIR/playlist-web.log

tail -f $LOG_DIR/playlist-api.log $LOG_DIR/playlist-web.log
EOF
