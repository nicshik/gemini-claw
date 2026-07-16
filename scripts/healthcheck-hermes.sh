#!/usr/bin/env bash
# End-to-end verification of the gemini-claw install on a HERMES host (no
# OpenClaw). Read-only except one tiny agy text prompt (the auth probe).
# Non-zero exit on any failure. Companion to scripts/install-hermes.sh.
#
# Run as root:  sudo scripts/healthcheck-hermes.sh
# Env overrides: HERMES_USER, HERMES_UNIT, HERMES_WORKSPACE, AGY_LINK (as in install-hermes.sh)
set -u

HERMES_USER="${HERMES_USER:-hermes}"
HERMES_UNIT="${HERMES_UNIT:-hermes-agent}"
HERMES_WORKSPACE="${HERMES_WORKSPACE:-/srv/hermes-agent/workspace}"
AGY_LINK="${AGY_LINK:-/usr/local/bin/agy}"

FAIL=0
ok()   { printf '[ok]   %s\n' "$*"; }
bad()  { printf '[FAIL] %s\n' "$*"; FAIL=1; }
info() { printf '[info] %s\n' "$*"; }

[ "$(id -u)" -eq 0 ] || { bad "run as root"; exit 1; }
id "$HERMES_USER" >/dev/null 2>&1 || { bad "user '$HERMES_USER' not found"; exit 1; }
HERMES_HOME="$(getent passwd "$HERMES_USER" | cut -d: -f6)"
asu() { sudo -u "$HERMES_USER" env HOME="$HERMES_HOME" "$@"; }

# 1) agy binary + PATH symlink
if [ -x "$AGY_LINK" ]; then ok "agy on PATH: $AGY_LINK ($(asu "$AGY_LINK" --version 2>/dev/null | head -1 || echo '?'))"
else bad "agy missing/not executable at $AGY_LINK"; fi

# 2) auth probe (one tiny text prompt)
if asu bash -c 'cd "$HOME" && exec timeout 90 "$0" -p "Reply with exactly: OK" </dev/null' "$AGY_LINK" 2>/dev/null | grep -q "OK"; then
  ok "agy authenticated (answers prompts)"
else
  bad "agy does not answer — not authenticated? run: sudo OPENCLAW_USER=$HERMES_USER scripts/login.sh"
fi

# 3) wrappers + dry-run (no quota spent)
for w in antigravity-image antigravity-ask; do
  [ -x "/usr/local/bin/$w" ] && ok "wrapper present: /usr/local/bin/$w" || bad "wrapper missing: /usr/local/bin/$w"
done
if asu /usr/local/bin/antigravity-image --dry-run "healthcheck" >/dev/null 2>&1; then
  ok "antigravity-image --dry-run passes"
else
  bad "antigravity-image --dry-run failed"
fi

# 4) skills deployed with the Hermes addendum
for skill in antigravity_ask antigravity_image; do
  md="$HERMES_WORKSPACE/skills/$skill/SKILL.md"
  if [ -f "$md" ] && grep -q '^## Hermes' "$md"; then ok "skill deployed with Hermes addendum: $skill"
  else bad "skill missing or without Hermes addendum: $md"; fi
done

# 5) hardened unit can write ~/.gemini
if systemctl show "$HERMES_UNIT" -p ReadWritePaths --value 2>/dev/null | grep -q "$HERMES_HOME/.gemini"; then
  ok "$HERMES_UNIT has ReadWritePaths=$HERMES_HOME/.gemini"
else
  bad "$HERMES_UNIT lacks ReadWritePaths for ~/.gemini — run install-hermes.sh, then RESTART_AGENT=1"
fi
systemctl is-active --quiet "$HERMES_UNIT" && ok "$HERMES_UNIT active" || bad "$HERMES_UNIT not active"

# 6) model-list cache helper (panel)
if [ -x /usr/local/bin/agy-models ] && [ -n "$(asu /usr/local/bin/agy-models 2>/dev/null | head -1)" ]; then
  ok "agy-models returns a model list"
else
  bad "agy-models missing or returns nothing"
fi
systemctl is-enabled --quiet antigravity-models-refresh.timer 2>/dev/null \
  && ok "model-cache refresh timer enabled" \
  || info "model-cache refresh timer not enabled (panel falls back to the bootstrap list)"

[ "$FAIL" -eq 0 ] && { echo "healthcheck-hermes: ALL OK"; exit 0; }
echo "healthcheck-hermes: FAILURES above"; exit 1
