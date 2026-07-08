#!/usr/bin/env bash
# gemini-claw uninstall.
# Removes the agy PATH symlink, the model-cache helper/timer, and the
# 'antigravity' OpenClaw plugin. Leaves agy and its login in place unless --purge.
#
#   sudo scripts/uninstall.sh [--purge]
#
# Env: OPENCLAW_USER (default: openclaw), OPENCLAW_BIN (default:
#      /opt/openclaw/bin/openclaw), AGY_LINK (default: /usr/local/bin/agy)
set -eu

log() { printf '[gemini-claw] %s\n' "$*"; }

OPENCLAW_USER="${OPENCLAW_USER:-openclaw}"
OPENCLAW_BIN="${OPENCLAW_BIN:-/opt/openclaw/bin/openclaw}"
AGY_LINK="${AGY_LINK:-/usr/local/bin/agy}"
PURGE=0
[ "${1:-}" = "--purge" ] && PURGE=1

[ "$(id -u)" -eq 0 ] || { echo "run as root" >&2; exit 1; }
OPENCLAW_HOME="$(getent passwd "$OPENCLAW_USER" | cut -d: -f6)"

# Remove the agy PATH symlink (only if it points at agy).
if [ -L "$AGY_LINK" ] && readlink "$AGY_LINK" | grep -q '/agy$'; then
  rm -f "$AGY_LINK" && log "removed agy symlink: $AGY_LINK"
fi

# Remove the model-cache helper and its refresh timer.
MODELS_HELPER="$(dirname "$AGY_LINK")/agy-models"
[ -e "$MODELS_HELPER" ] && rm -f "$MODELS_HELPER" && log "removed models helper: $MODELS_HELPER"
if command -v systemctl >/dev/null 2>&1; then
  systemctl disable --now antigravity-models-refresh.timer >/dev/null 2>&1 || true
  rm -f /etc/systemd/system/antigravity-models-refresh.timer /etc/systemd/system/antigravity-models-refresh.service
  systemctl daemon-reload 2>/dev/null || true
fi

# Remove the 'antigravity' plugin via the CLI, then ensure its files are gone.
if [ -x "$OPENCLAW_BIN" ]; then
  sudo -u "$OPENCLAW_USER" env HOME="$OPENCLAW_HOME" "$OPENCLAW_BIN" plugins uninstall antigravity --force >/dev/null 2>&1 \
    && log "uninstalled 'antigravity' plugin" || true
fi
PLUGIN_DIR_INSTALLED="$OPENCLAW_HOME/.openclaw/extensions/antigravity"
[ -d "$PLUGIN_DIR_INSTALLED" ] && rm -rf "$PLUGIN_DIR_INSTALLED" && log "removed plugin dir: $PLUGIN_DIR_INSTALLED"

# Remove any leftover legacy 'antigravity' agent skill (superseded by the plugin).
MANAGED="$OPENCLAW_HOME/.openclaw/skills/antigravity"
if [ -d "$MANAGED" ]; then
  rm -rf "$MANAGED" && log "removed legacy managed skill: $MANAGED"
fi

# Clean any legacy translation shims.
for legacy in /usr/local/bin/gemini /opt/openclaw/tools/node*/bin/gemini; do
  [ -e "$legacy" ] || continue
  if grep -qE 'gemini-(claw|agy)-shim' "$legacy" 2>/dev/null; then
    rm -f "$legacy" && log "removed legacy translation shim: $legacy"
  fi
done

if [ "$PURGE" -eq 1 ] && [ -n "$OPENCLAW_HOME" ] && [ -x "$OPENCLAW_HOME/.local/bin/agy" ]; then
  rm -f "$OPENCLAW_HOME/.local/bin/agy" && log "removed agy binary"
  log "note: agy config/login left under $OPENCLAW_HOME/.gemini (remove manually if desired)"
fi

log "done. Restart the gateway / reopen the panel to reflect the change."
