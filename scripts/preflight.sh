#!/usr/bin/env bash
# gemini-claw preflight — read-only environment checks with actionable fixes.
#
# Run this before install/login on a new host to fail fast with a clear reason
# instead of failing deep inside a step. It changes nothing. setup.sh runs it as
# its first step; it is also useful standalone.
#
#   sudo scripts/preflight.sh
#
# Exit non-zero if any hard requirement (FAIL) is missing. WARN items don't block
# but are worth knowing (e.g. a missing browser-reachable network for login).
#
# Env: OPENCLAW_USER (default: openclaw), OPENCLAW_BIN (default: /opt/openclaw/bin/openclaw)
set -eu

OPENCLAW_USER="${OPENCLAW_USER:-openclaw}"
OPENCLAW_BIN="${OPENCLAW_BIN:-/opt/openclaw/bin/openclaw}"
MIN_OPENCLAW="2026.6.11"   # plugin SDK floor (registerCommand / registerInteractiveHandler)

fail=0; warns=0
ok()  { printf '  [ OK ] %s\n' "$*"; }
bad() { printf '  [FAIL] %s\n' "$1"; if [ "$#" -ge 2 ]; then printf '         fix: %s\n' "$2"; fi; fail=$((fail+1)); }
wrn() { printf '  [WARN] %s\n' "$*"; warns=$((warns+1)); }

echo "gemini-claw preflight (user=$OPENCLAW_USER)"

# --- hard requirements (FAIL) ---
if [ "$(id -u)" -eq 0 ]; then ok "running as root"
else bad "not running as root" "run with sudo"; fi

if id "$OPENCLAW_USER" >/dev/null 2>&1; then
  OPENCLAW_HOME="$(getent passwd "$OPENCLAW_USER" | cut -d: -f6)"
  if [ -n "$OPENCLAW_HOME" ] && [ -d "$OPENCLAW_HOME" ]; then
    ok "service user '$OPENCLAW_USER' (home $OPENCLAW_HOME)"
  else
    bad "service user '$OPENCLAW_USER' has no usable home dir" "check the account, or set OPENCLAW_USER="
    OPENCLAW_HOME=""
  fi
else
  bad "service user '$OPENCLAW_USER' not found" "set OPENCLAW_USER=<the gateway's user>"
  OPENCLAW_HOME=""
fi

if [ -x "$OPENCLAW_BIN" ]; then
  ok "openclaw CLI at $OPENCLAW_BIN"
  VER="$("$OPENCLAW_BIN" --version 2>/dev/null | grep -Eo '[0-9]{4}\.[0-9]+\.[0-9]+' | head -1 || true)"
  if [ -z "$VER" ]; then
    wrn "could not read openclaw version (continuing)"
  elif [ "$(printf '%s\n%s\n' "$MIN_OPENCLAW" "$VER" | sort -V | head -1)" = "$MIN_OPENCLAW" ]; then
    ok "openclaw version $VER (>= $MIN_OPENCLAW)"
  else
    bad "openclaw $VER is older than $MIN_OPENCLAW (plugin SDK too old)" "openclaw update"
  fi
else
  bad "openclaw CLI not found at $OPENCLAW_BIN" "set OPENCLAW_BIN=/path/to/openclaw"
fi

# --- soft requirements (WARN) ---
command -v curl >/dev/null 2>&1 && ok "curl present" \
  || wrn "curl missing — needed to install agy on a fresh host (apt install curl)"
command -v tmux >/dev/null 2>&1 && ok "tmux present" \
  || wrn "tmux missing — needed for scripts/login.sh (apt install tmux)"

if command -v systemctl >/dev/null 2>&1; then
  if systemctl cat openclaw-gateway >/dev/null 2>&1; then
    if systemctl is-active --quiet openclaw-gateway 2>/dev/null; then ok "openclaw-gateway unit present and active"
    else wrn "openclaw-gateway unit present but not active"; fi
  else
    wrn "no 'openclaw-gateway' systemd unit — the plugin reload/restart step needs one"
  fi
else
  wrn "systemctl not found — model-cache timer and gateway restart will be skipped"
fi

# Network reachability for the login OAuth + agy install (WARN only).
if command -v curl >/dev/null 2>&1; then
  curl -sI --max-time 5 https://accounts.google.com >/dev/null 2>&1 \
    && ok "reachable: accounts.google.com (needed for login)" \
    || wrn "cannot reach accounts.google.com — login OAuth will fail from this host"
fi

# Disk headroom in the service user's home (agy is ~170 MB + a growing brain dir).
if [ -n "${OPENCLAW_HOME:-}" ] && [ -d "$OPENCLAW_HOME" ]; then
  FREE_KB="$(df -Pk "$OPENCLAW_HOME" 2>/dev/null | awk 'NR==2{print $4}' || echo 0)"
  if [ "${FREE_KB:-0}" -ge 1048576 ]; then ok "disk: $((FREE_KB/1024)) MB free in $OPENCLAW_HOME"
  else wrn "only $(((${FREE_KB:-0})/1024)) MB free in $OPENCLAW_HOME (agy needs ~170 MB + brain growth)"; fi
fi

# Telegram inline-button capability (the panel's buttons need it).
if [ -x "$OPENCLAW_BIN" ] && [ -n "${OPENCLAW_HOME:-}" ]; then
  CAP="$(sudo -u "$OPENCLAW_USER" env HOME="$OPENCLAW_HOME" "$OPENCLAW_BIN" \
         config get channels.telegram.capabilities.inlineButtons 2>/dev/null | tr -d ' \r\n' || true)"
  case "$CAP" in
    dm|all) ok "telegram inlineButtons capability: $CAP" ;;
    *) wrn "telegram inlineButtons is '${CAP:-unset}' — set it: openclaw config set channels.telegram.capabilities.inlineButtons dm" ;;
  esac
fi

echo "---- $((fail)) failed, $warns warned ----"
[ "$fail" -eq 0 ]
