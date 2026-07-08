#!/usr/bin/env bash
# gemini-claw one-line installer. Downloads the repo and runs setup.sh.
#
#   curl -fsSL https://raw.githubusercontent.com/nicshik/gemini-claw/main/scripts/bootstrap.sh | sudo bash
#
# Pass setup.sh flags after `-s --`:
#   curl -fsSL https://raw.githubusercontent.com/nicshik/gemini-claw/main/scripts/bootstrap.sh | sudo bash -s -- --yes
#
# Env: GEMINI_CLAW_DIR (clone target, default /root/gemini-claw),
#      GEMINI_CLAW_BRANCH (default main).
set -eu

REPO="nicshik/gemini-claw"
BRANCH="${GEMINI_CLAW_BRANCH:-main}"
DEST="${GEMINI_CLAW_DIR:-/root/gemini-claw}"

log() { printf '[gemini-claw] %s\n' "$*"; }
die() { printf '[gemini-claw] ERROR: %s\n' "$*" >&2; exit 1; }

[ "$(id -u)" -eq 0 ] || die "run as root — pipe into 'sudo bash'"
command -v curl >/dev/null 2>&1 || die "curl is required"

log "fetching $REPO@$BRANCH -> $DEST"
if command -v git >/dev/null 2>&1; then
  if [ -d "$DEST/.git" ]; then
    git -C "$DEST" fetch --depth 1 origin "$BRANCH" \
      && git -C "$DEST" reset --hard "origin/$BRANCH"
  else
    rm -rf "$DEST"
    git clone --depth 1 -b "$BRANCH" "https://github.com/$REPO" "$DEST"
  fi
else
  # No git: fall back to the source tarball.
  rm -rf "$DEST"; mkdir -p "$DEST"
  curl -fsSL "https://github.com/$REPO/archive/refs/heads/$BRANCH.tar.gz" \
    | tar xz -C "$DEST" --strip-components=1 \
    || die "download/extract failed"
fi
[ -f "$DEST/scripts/setup.sh" ] || die "setup.sh missing after fetch — check the repo/branch"

# When invoked as `curl | bash`, stdin is the piped script, not the keyboard — so
# setup.sh's interactive steps (dep/buttons prompts, the login code paste) must read
# from the controlling terminal. Reconnect it; if there is no tty (cron/CI), run
# non-interactively and skip the human-only login, which can be done later.
if [ -e /dev/tty ] && (: >/dev/tty) 2>/dev/null; then
  log "running setup.sh $*"
  exec bash "$DEST/scripts/setup.sh" "$@" </dev/tty
else
  log "no interactive terminal — running non-interactively (--yes --skip-login);"
  log "finish the Google login later with: sudo $DEST/scripts/login.sh"
  exec bash "$DEST/scripts/setup.sh" --yes --skip-login "$@"
fi
