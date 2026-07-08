#!/usr/bin/env bash
# gemini-claw health check (agy + antigravity plugin).
# Verifies: agy installed -> on PATH -> authenticated -> answers, and that the
# `antigravity` OpenClaw plugin is installed and enabled. Exits non-zero if
# anything is broken. Safe to run after an `openclaw update`.
#
#   sudo scripts/healthcheck.sh
#
# Env: OPENCLAW_USER (default: openclaw), OPENCLAW_BIN (default: /opt/openclaw/bin/openclaw),
#      AGY_LINK (default: /usr/local/bin/agy)
set -eu

OPENCLAW_USER="${OPENCLAW_USER:-openclaw}"
OPENCLAW_BIN="${OPENCLAW_BIN:-/opt/openclaw/bin/openclaw}"
AGY_LINK="${AGY_LINK:-/usr/local/bin/agy}"

pass=0; fail=0
ok()   { printf '  [ OK ] %s\n' "$*"; pass=$((pass+1)); }
bad()  { printf '  [FAIL] %s\n' "$*"; fail=$((fail+1)); }
info() { printf '         %s\n' "$*"; }

echo "gemini-claw healthcheck (agy + antigravity plugin; user=$OPENCLAW_USER)"

id "$OPENCLAW_USER" >/dev/null 2>&1 || { echo "user '$OPENCLAW_USER' not found"; exit 1; }
OPENCLAW_HOME="$(getent passwd "$OPENCLAW_USER" | cut -d: -f6)"
[ -n "$OPENCLAW_HOME" ] || { echo "cannot resolve home dir for $OPENCLAW_USER"; exit 1; }
AGY_BIN="$OPENCLAW_HOME/.local/bin/agy"
asu() { sudo -u "$OPENCLAW_USER" env HOME="$OPENCLAW_HOME" "$@"; }

# 1) agy binary
if [ -x "$AGY_BIN" ]; then ok "agy present ($("$AGY_BIN" --version 2>/dev/null || echo '?'))"
else bad "agy missing at $AGY_BIN"; fi

# 2) agy on the default system PATH (what the gateway sees)
if [ -L "$AGY_LINK" ] || [ -x "$AGY_LINK" ]; then ok "agy exposed at $AGY_LINK"
else bad "agy not exposed at $AGY_LINK"; fi
RESOLVED="$(env -i PATH=/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin bash -c 'command -v agy' 2>/dev/null || true)"
if [ -n "$RESOLVED" ]; then ok "'agy' resolves on default PATH -> $RESOLVED"
else bad "'agy' not found on default system PATH"; fi

# 3) authenticated + answers (from a readable cwd, with timeout; retry once)
if [ -x "$AGY_BIN" ]; then
  authed=0
  for _attempt in 1 2; do
    ANS="$(asu bash -c 'cd "$HOME" && exec timeout 90 "$0" -p "Reply with exactly: OK" </dev/null' "$AGY_BIN" 2>/dev/null \
          | tr -d '\r\n[:space:]' || true)"
    if printf '%s' "$ANS" | grep -qi 'OK'; then authed=1; break; fi
  done
  if [ "$authed" -eq 1 ]; then ok "authenticated: 'agy -p' answered"
  else bad "agy not authenticated or prompt failed (run scripts/login.sh)"; fi
fi

# 4) 'antigravity' plugin installed on disk + enabled in OpenClaw
if [ -f "$OPENCLAW_HOME/.openclaw/extensions/antigravity/index.js" ]; then
  ok "plugin files present (~/.openclaw/extensions/antigravity/index.js)"
else
  bad "plugin not installed (run scripts/install.sh)"
fi
if [ -x "$OPENCLAW_BIN" ]; then
  LIST="$(asu "$OPENCLAW_BIN" plugins list 2>/dev/null || true)"
  # The antigravity row spans lines; match the id column then confirm 'enabled'.
  ROW="$(printf '%s\n' "$LIST" | grep -iE 'antigravity' | head -1)"
  if [ -z "$ROW" ]; then
    bad "'antigravity' plugin not registered (run scripts/install.sh)"
  elif printf '%s' "$ROW" | grep -qi 'enabled'; then
    ok "OpenClaw plugin 'antigravity' is enabled"
  elif printf '%s' "$ROW" | grep -qi 'disabled'; then
    bad "'antigravity' plugin present but disabled (openclaw plugins enable antigravity)"
  else
    info "'antigravity' plugin registered; enabled-state unclear — check 'openclaw plugins inspect antigravity'"
  fi
fi

# 4b) sanity: model-list cache the panel reads (informational)
if [ -s "$OPENCLAW_HOME/.gemini/antigravity-models.txt" ]; then
  info "model cache present ($(wc -l <"$OPENCLAW_HOME/.gemini/antigravity-models.txt" 2>/dev/null | tr -d ' ') models)"
else
  info "model cache empty — /antigravity model will use the bootstrap list until the timer refreshes"
fi

# 5) gateway (informational)
if command -v systemctl >/dev/null 2>&1; then
  if systemctl is-active --quiet openclaw-gateway 2>/dev/null; then info "openclaw-gateway: active"
  else info "openclaw-gateway: not active"; fi
fi

echo "---- $pass passed, $fail failed ----"
[ "$fail" -eq 0 ]
