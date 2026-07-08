#!/usr/bin/env bash
# gemini-claw setup — one-command onboarding orchestrator.
#
# Runs the whole flow in order, idempotently and safe to re-run:
#   1 deps  2 preflight  3 install  4 login  5 telegram buttons  6 restart  7 healthcheck
#
#   sudo scripts/setup.sh [--yes] [--skip-login] [--no-buttons]
#
#   --yes         non-interactive: don't prompt before the one host-config edit
#                 (setting the telegram inlineButtons capability).
#   --skip-login  don't run the Google AI Pro OAuth (do it later with login.sh).
#   --no-buttons  don't touch channels.telegram.capabilities.inlineButtons.
#
# The individual scripts still work standalone; this is a wrapper, not a rewrite.
# Env overrides (inherited by every step): OPENCLAW_USER, OPENCLAW_BIN, AGY_LINK.
set -eu

log() { printf '[gemini-claw] %s\n' "$*"; }
die() { printf '[gemini-claw] ERROR: %s\n' "$*" >&2; exit 1; }
step() { printf '\n===== [setup %s] %s =====\n' "$1" "$2"; }

[ "$(id -u)" -eq 0 ] || die "run as root"

YES=0; SKIP_LOGIN=0; NO_BUTTONS=0
for arg in "$@"; do
  case "$arg" in
    --yes) YES=1 ;;
    --skip-login) SKIP_LOGIN=1 ;;
    --no-buttons) NO_BUTTONS=1 ;;
    -h|--help) sed -n '2,16p' "$0"; exit 0 ;;
    *) die "unknown option: $arg (see --help)" ;;
  esac
done

export OPENCLAW_USER="${OPENCLAW_USER:-openclaw}"
export OPENCLAW_BIN="${OPENCLAW_BIN:-/opt/openclaw/bin/openclaw}"
export AGY_LINK="${AGY_LINK:-/usr/local/bin/agy}"

SCRIPTS="$(cd "$(dirname "$0")" && pwd)"
id "$OPENCLAW_USER" >/dev/null 2>&1 || die "user '$OPENCLAW_USER' not found (set OPENCLAW_USER=...)"
OPENCLAW_HOME="$(getent passwd "$OPENCLAW_USER" | cut -d: -f6)"
asu() { sudo -u "$OPENCLAW_USER" env HOME="$OPENCLAW_HOME" "$@"; }

# --- 0) auto-install the OS packages the flow needs (curl for the agy install,
#        tmux for the login). Best-effort via apt-get; skipped elsewhere. ---
ensure_deps() {
  local missing=""
  command -v curl >/dev/null 2>&1 || missing="$missing curl"
  command -v tmux >/dev/null 2>&1 || missing="$missing tmux"
  missing="${missing# }"
  [ -z "$missing" ] && return 0
  if ! command -v apt-get >/dev/null 2>&1; then
    log "missing packages: $missing — no apt-get here, install them manually and re-run."
    return 0
  fi
  if [ "$YES" -ne 1 ]; then
    printf 'Install missing packages (%s) via apt-get? [Y/n]: ' "$missing"
    local ans=""; read -r ans || true
    case "$ans" in n|N|no|NO) log "skipped; install manually: apt-get install -y $missing"; return 0 ;; esac
  fi
  log "installing: $missing"
  # shellcheck disable=SC2086
  if apt-get update -qq && apt-get install -y $missing; then log "installed: $missing"
  else log "WARN: apt-get failed for '$missing' — install manually and re-run."; fi
}
step 1/7 "dependencies"
ensure_deps

# --- 1) preflight (abort on hard FAIL) ---
step 2/7 "preflight"
"$SCRIPTS/preflight.sh" || die "preflight failed — fix the [FAIL] items above and re-run."

# --- 2) install agy + plugin (restart handled in step 5, not here) ---
step 3/7 "install agy + antigravity plugin"
RESTART_GATEWAY=0 "$SCRIPTS/install.sh"

# --- 3) Google AI Pro login (self-skips if already authenticated) ---
if [ "$SKIP_LOGIN" -eq 1 ]; then
  step 4/7 "login (skipped: --skip-login)"
  log "run 'sudo scripts/login.sh' when ready."
else
  step 4/7 "Google AI Pro login"
  # login.sh exits 3 if onboarding is incomplete; don't abort the whole setup.
  "$SCRIPTS/login.sh" || log "login did not fully complete — re-run 'sudo scripts/login.sh' if healthcheck flags auth."
fi

# --- 4) telegram inline-button capability (the one host-config edit) ---
step 5/7 "telegram inline-button capability"
configure_buttons() {
  local key="channels.telegram.capabilities.inlineButtons"
  local cap
  cap="$(asu "$OPENCLAW_BIN" config get "$key" 2>/dev/null | tr -d ' \r\n' || true)"
  case "$cap" in
    dm|all) log "inlineButtons already '$cap' — nothing to do."; return 0 ;;
  esac
  if [ "$NO_BUTTONS" -eq 1 ]; then
    log "inlineButtons is '${cap:-unset}' — skipped (--no-buttons). The panel's buttons need 'dm' or 'all'."
    return 0
  fi
  if [ "$YES" -ne 1 ]; then
    printf 'Set %s = dm now? (edits openclaw.json) [y/N]: ' "$key"
    local ans=""; read -r ans || true
    case "$ans" in
      y|Y|yes|YES) : ;;
      *) log "left inlineButtons as '${cap:-unset}'. Set later: openclaw config set $key dm"; return 0 ;;
    esac
  fi
  local cfg="$OPENCLAW_HOME/.openclaw/openclaw.json" bak=""
  if [ -f "$cfg" ]; then
    bak="$cfg.bak-$(date +%Y%m%d-%H%M%S)"
    cp -p "$cfg" "$bak" && log "backed up openclaw.json -> $(basename "$bak")"
  fi
  if ! asu "$OPENCLAW_BIN" config set "$key" dm >/dev/null 2>&1; then
    [ -n "$bak" ] && cp -p "$bak" "$cfg"
    log "WARN: could not set inlineButtons (config set failed) — left unchanged. Set manually: openclaw config set $key dm"
    return 0
  fi
  if asu "$OPENCLAW_BIN" config validate >/dev/null 2>&1; then
    log "inlineButtons set to 'dm' (validated)."
  elif [ -n "$bak" ]; then
    cp -p "$bak" "$cfg"; log "WARN: config validate failed — restored openclaw.json from backup."
  fi
  return 0   # never let this function's exit status abort setup.sh (set -e)
}
configure_buttons

# --- 5) restart the gateway so it loads the plugin ---
step 6/7 "restart openclaw-gateway"
if command -v systemctl >/dev/null 2>&1 && systemctl cat openclaw-gateway >/dev/null 2>&1; then
  systemctl restart openclaw-gateway && log "gateway restarted; waiting for it to come up ..."
  up=0
  for _ in $(seq 1 15); do
    if systemctl is-active --quiet openclaw-gateway 2>/dev/null; then up=1; break; fi
    sleep 2
  done
  [ "$up" -eq 1 ] && log "openclaw-gateway active." || log "WARN: openclaw-gateway did not report active within ~30s."
else
  log "no openclaw-gateway systemd unit — restart the gateway manually to load the plugin."
fi

# --- 6) healthcheck (its verdict is setup.sh's exit code) ---
step 7/7 "healthcheck"
set +e
"$SCRIPTS/healthcheck.sh"; rc=$?
set -e
echo
if [ "$rc" -eq 0 ]; then
  log "setup complete. Send /antigravity in Telegram to open the control panel."
else
  log "setup finished, but healthcheck reported failures (see above). Re-run: sudo scripts/healthcheck.sh"
fi
exit "$rc"
