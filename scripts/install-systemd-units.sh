#!/usr/bin/env bash
# One-time install of noahbot user-mode systemd units.
# Idempotent — safe to re-run.
set -euo pipefail

UNIT_DIR="$HOME/.config/systemd/user"
SRC_DIR="$(dirname "$(readlink -f "$0")")/systemd"

mkdir -p "$UNIT_DIR"
install -m 0644 "$SRC_DIR/noahbot-api.service" "$UNIT_DIR/noahbot-api.service"
install -m 0644 "$SRC_DIR/noahbot-web.service" "$UNIT_DIR/noahbot-web.service"

systemctl --user daemon-reload
systemctl --user enable --now noahbot-api.service noahbot-web.service

# Keep user services running across logout / start at boot before login.
if ! loginctl show-user "$USER" 2>/dev/null | grep -q "Linger=yes"; then
  echo "Enabling linger (requires sudo)…"
  sudo loginctl enable-linger "$USER"
fi

echo
echo "Installed. Status:"
systemctl --user --no-pager status noahbot-api.service noahbot-web.service || true

cat <<EOF

Useful commands:
  systemctl --user status noahbot-api noahbot-web
  systemctl --user restart noahbot-api noahbot-web
  journalctl --user -u noahbot-api -u noahbot-web -f
EOF
