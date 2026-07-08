#!/usr/bin/env bash
# gemini-claw login helper (v2).
#
# Drives the one-time Antigravity CLI (agy) OAuth login for the OpenClaw service
# user on a headless server. agy has no `login`/`auth` subcommand — OAuth is only
# reachable through the interactive TUI (`agy -i`), so we hold it in tmux, read
# the authorization URL agy prints (it detects the SSH session and prints a URL
# instead of opening a browser), you sign in with the Google account that has
# AI Pro, and paste the code back.
#
# The post-auth first-run screens (telemetry / trust-folder / color scheme) are
# PRE-SEEDED into agy's config below so they ideally never appear. The interactive
# key-walk that handled them is kept as a FALLBACK: if a screen still shows (e.g.
# agy changed its config schema), the walk still dismisses it, so nothing
# regresses. See docs/onboarding-improvement-plan.md.
#
# Requires: tmux. Run as root:  sudo scripts/login.sh
#
# Env overrides:
#   OPENCLAW_USER  service user (default: openclaw)
set -eu

log()  { printf '[gemini-claw] %s\n' "$*"; }
warn() { printf '[gemini-claw] WARN: %s\n' "$*" >&2; }
die()  { printf '[gemini-claw] ERROR: %s\n' "$*" >&2; exit 1; }

[ "$(id -u)" -eq 0 ] || die "run as root"
command -v tmux >/dev/null 2>&1 || die "tmux is required (apt install tmux)"

OPENCLAW_USER="${OPENCLAW_USER:-openclaw}"
# agy version the onboarding automation was verified against. A mismatch is only a
# warning — the URL/code exchange is version-agnostic; only the TUI key-walk is
# version-coupled, and the seed makes it a no-op on the happy path.
KNOWN_GOOD_AGY="1.1.0"

id "$OPENCLAW_USER" >/dev/null 2>&1 || die "user '$OPENCLAW_USER' not found"
OPENCLAW_HOME="$(getent passwd "$OPENCLAW_USER" | cut -d: -f6)"
[ -n "$OPENCLAW_HOME" ] || die "cannot resolve home for $OPENCLAW_USER"
AGY_BIN="$OPENCLAW_HOME/.local/bin/agy"
[ -x "$AGY_BIN" ] || die "agy not installed; run scripts/install.sh first"

GEMINI_DIR="$OPENCLAW_HOME/.gemini"
CLI_SETTINGS="$GEMINI_DIR/antigravity-cli/settings.json"
ONBOARDING_CACHE="$GEMINI_DIR/antigravity-cli/cache/onboarding.json"

SOCK="agy-login"
SESSION="login"
as_user() { sudo -u "$OPENCLAW_USER" env HOME="$OPENCLAW_HOME" "$@"; }
tm()   { as_user tmux -L "$SOCK" "$@"; }
pane() { tm capture-pane -J -p -t "$SESSION" 2>/dev/null; }

# --- version gate (warn-only) ---
# as_user: don't execute the service user's binary as root (privilege boundary).
AGY_VER="$(as_user "$AGY_BIN" --version 2>/dev/null | head -1 | tr -d ' \r' || echo '?')"
case "$AGY_VER" in
  *"$KNOWN_GOOD_AGY"*) : ;;
  *) warn "agy version is '$AGY_VER'; onboarding was verified on $KNOWN_GOOD_AGY. If the"
     warn "automated first-run walk stalls, attach and finish manually (command shown on failure)." ;;
esac

# --- already authenticated? (cd $HOME: readable cwd; timeout: a cold token
#     refresh or a hung agy must not stall the script) ---
if as_user bash -c 'cd "$HOME" && exec timeout 90 "$0" -p "Reply with exactly: OK" </dev/null' "$AGY_BIN" >/dev/null 2>&1; then
  log "already authenticated - nothing to do."
  exit 0
fi

# --- seed onboarding config so the post-auth TUI walk is (ideally) a no-op ---
# Additive and safe: merges into existing files (never blind-overwrites foreign
# keys), and the interactive walk below still handles any screen that appears.
seed_agy_config() {
  as_user mkdir -p "$GEMINI_DIR/antigravity-cli/cache"
  if as_user command -v python3 >/dev/null 2>&1; then
    as_user env CLI_SETTINGS="$CLI_SETTINGS" HOME_DIR="$OPENCLAW_HOME" python3 - <<'PY'
import json, os
p = os.environ["CLI_SETTINGS"]
home = os.environ["HOME_DIR"]
try:
    with open(p) as f:
        d = json.load(f)
    if not isinstance(d, dict):
        d = {}
except Exception:
    d = {}
d["enableTelemetry"] = False
tw = d.get("trustedWorkspaces")
if not isinstance(tw, list):
    tw = []
if home not in tw:
    tw.append(home)
d["trustedWorkspaces"] = tw
os.makedirs(os.path.dirname(p), exist_ok=True)
with open(p, "w") as f:
    json.dump(d, f, indent=1)
PY
  elif [ ! -f "$CLI_SETTINGS" ]; then
    # No python3 for a safe merge: only create fresh, never clobber an existing file.
    as_user bash -c 'cat > "$0"' "$CLI_SETTINGS" <<EOF
{"enableTelemetry": false, "trustedWorkspaces": ["$OPENCLAW_HOME"]}
EOF
  else
    warn "python3 not found; leaving existing $CLI_SETTINGS untouched (telemetry not force-disabled)."
  fi
  # onboarding-complete flag: create only if missing.
  if [ ! -f "$ONBOARDING_CACHE" ]; then
    as_user bash -c 'cat > "$0"' "$ONBOARDING_CACHE" <<'EOF'
{"consumerOnboardingComplete": true, "enterpriseOnboardingComplete": false, "onboardingComplete": true}
EOF
  fi
  chmod 600 "$CLI_SETTINGS" "$ONBOARDING_CACHE" 2>/dev/null || true
  log "seeded agy onboarding config (telemetry off, workspace trusted)."
}
seed_agy_config

cleanup() { tm kill-server >/dev/null 2>&1 || true; }
trap cleanup EXIT

# Start an interactive agy session in tmux (SSH_CONNECTION forces the URL flow).
cleanup
tm new-session -d -s "$SESSION" -x 200 -y 50 \
  "cd '$OPENCLAW_HOME' && SSH_CONNECTION='${SSH_CONNECTION:-1.1.1.1 1 2.2.2.2 22}' TERM=xterm-256color PATH='$OPENCLAW_HOME/.local/bin:/usr/bin:/bin' '$AGY_BIN' -i 'Say OK'"

log "starting agy login session ..."

# Wait for the login menu, then choose Google OAuth (option 1, already selected).
for _ in $(seq 1 15); do
  sleep 2
  if pane | grep -qi "Select login method"; then
    tm send-keys -t "$SESSION" Enter
    break
  fi
done

# Wait for the authorization URL.
URL=""
for _ in $(seq 1 15); do
  sleep 2
  URL="$(pane | grep -Eo 'https://accounts\.google\.com/o/oauth2/auth[^ ]*' | head -1 || true)"
  # The URL wraps across the pane; stitch fragment lines just in case.
  if [ -z "$URL" ]; then
    URL="$(pane | grep -E 'oauth2/auth|code_challenge_method|googleapis|experimentsandconfigs|state=' | tr -d ' \r\n' || true)"
  fi
  [ -n "$URL" ] && break
done
if [ -z "$URL" ]; then
  trap - EXIT   # keep the tmux session alive so the attach below actually works
  warn "did not get an auth URL automatically. Full session pane:"
  pane || true
  die "attach to read the URL / finish manually: sudo -u $OPENCLAW_USER tmux -L $SOCK attach -t $SESSION"
fi

cat <<EOF

================================ ACTION REQUIRED ================================
1. Open this URL in a browser on your local machine and sign in with the
   Google account that has AI Pro:

$URL

2. Approve access. The page will show an AUTHORIZATION CODE.
3. Paste that code below and press Enter.
================================================================================
EOF

# Read the code with light validation + retry, so a typo/empty paste re-prompts
# instead of aborting the whole login.
CODE=""
for attempt in 1 2 3; do
  printf 'Authorization code: '
  read -r CODE || true
  CODE="$(printf '%s' "$CODE" | tr -d ' \t\r\n')"
  if [ -z "$CODE" ]; then warn "empty code — try again ($attempt/3)."; CODE=""; continue; fi
  if [ "${#CODE}" -lt 8 ]; then warn "that looks too short for an auth code — try again ($attempt/3)."; CODE=""; continue; fi
  break
done
[ -n "$CODE" ] || die "no valid code entered after 3 attempts"

tm send-keys -t "$SESSION" -l -- "$CODE"
tm send-keys -t "$SESSION" Enter

# FALLBACK first-run walk (seed above should make these a no-op). Each stage is
# handled at most once — a stale pane capture must not re-send keys (a second
# Enter on the consent screen would toggle telemetry back ON). Each fired stage
# logs that the seed did NOT suppress it, so a transcript shows what happened.
theme_done=0; consent_done=0; trust_done=0
for _ in $(seq 1 20); do
  sleep 2
  P="$(pane)"
  if printf '%s' "$P" | grep -qi "IneligibleTierError\|not supported for Gemini Code Assist"; then
    die "Google rejected this account tier for agy. Use an account with an eligible AI Pro session."
  fi
  if printf '%s' "$P" | grep -qi "color scheme"; then
    [ "$theme_done" = 1 ] && continue
    log "onboarding: color-scheme screen shown (seed did not suppress it) — Enter"
    tm send-keys -t "$SESSION" Enter; theme_done=1; continue
  fi
  if printf '%s' "$P" | grep -qi "agree to help improve"; then
    [ "$consent_done" = 1 ] && continue
    log "onboarding: telemetry screen shown (seed did not suppress it) — disabling telemetry"
    # Uncheck telemetry (privacy default), then navigate to [Done].
    tm send-keys -t "$SESSION" Enter; sleep 1
    tm send-keys -t "$SESSION" Down; sleep 1
    tm send-keys -t "$SESSION" Right; sleep 1
    tm send-keys -t "$SESSION" Enter; consent_done=1; continue
  fi
  if printf '%s' "$P" | grep -qi "trust the contents\|trust this folder"; then
    [ "$trust_done" = 1 ] && continue
    log "onboarding: trust-folder screen shown (seed did not suppress it) — Enter"
    tm send-keys -t "$SESSION" Enter; trust_done=1; continue
  fi
  # Reached the prompt / got an answer -> onboarding complete.
  if printf '%s' "$P" | grep -qiE "Google AI Pro|Say OK|^ *OK *$|for shortcuts"; then
    break
  fi
done

# Verify with a fresh non-interactive process.
if as_user bash -c 'cd "$HOME" && exec timeout 90 "$0" -p "Reply with exactly: OK" </dev/null' "$AGY_BIN" >/dev/null 2>&1; then
  # Post-login audit: agy may rewrite settings during login. Warn (not fatal) if
  # our telemetry-off seed got flipped back on.
  if as_user command -v python3 >/dev/null 2>&1 && [ -f "$CLI_SETTINGS" ]; then
    TEL="$(as_user python3 -c 'import json,sys; print(json.load(open(sys.argv[1])).get("enableTelemetry"))' "$CLI_SETTINGS" 2>/dev/null || true)"
    if [ "$TEL" = "True" ]; then
      warn "agy re-enabled telemetry after login. To disable: set enableTelemetry:false in $CLI_SETTINGS"
    fi
  fi
  log "login successful - agy is authenticated for '$OPENCLAW_USER'."
  exit 0
fi

log "code accepted but automated onboarding may be incomplete."
log "Attach and finish any remaining prompts manually, then re-run healthcheck.sh:"
log "  sudo -u $OPENCLAW_USER tmux -L $SOCK attach -t $SESSION"
trap - EXIT   # leave the session up for manual completion
exit 3
