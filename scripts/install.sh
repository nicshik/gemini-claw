#!/usr/bin/env bash
# gemini-claw installer (idempotent) — agy + `antigravity` control-panel plugin.
#
# 1. Installs the Antigravity CLI (agy) for the OpenClaw service user if missing.
# 2. Exposes `agy` on the gateway PATH via a plain symlink /usr/local/bin/agy.
# 3. Installs the model-list cache helper + a daily refresh timer (keeps the
#    /antigravity model menu instant and fresh).
# 4. Installs the `antigravity` OpenClaw *plugin* (`openclaw plugins install`),
#    which renders the /antigravity control panel natively — navigation bypasses
#    the LLM agent, so it is instant and immune to a slow/flaky model backend.
#    The plugin lives under the service user's home and survives `openclaw update`.
# 4b. Installs two agent-facing *skills* (antigravity_ask, antigravity_image) into the
#    OpenClaw workspace, giving the LLM agent an EXPLICIT route to agy (additive to the
#    plugin, which the agent cannot invoke). Explicit-invocation only.
# 5. Removes the superseded legacy pieces (gemini->agy shim, old `antigravity`
#    agent skill).
#
# Run as root on the target server:  sudo scripts/install.sh
#
# Env overrides:
#   OPENCLAW_USER    service user that runs the gateway   (default: openclaw)
#   OPENCLAW_BIN     openclaw CLI path                    (default: /opt/openclaw/bin/openclaw)
#   AGY_LINK         where to expose agy on PATH          (default: /usr/local/bin/agy)
#   RESTART_GATEWAY  1 = restart openclaw-gateway to load the plugin (default: 0)
set -eu

log()  { printf '[gemini-claw] %s\n' "$*"; }
die()  { printf '[gemini-claw] ERROR: %s\n' "$*" >&2; exit 1; }

[ "$(id -u)" -eq 0 ] || die "run as root"

OPENCLAW_USER="${OPENCLAW_USER:-openclaw}"
OPENCLAW_BIN="${OPENCLAW_BIN:-/opt/openclaw/bin/openclaw}"
AGY_LINK="${AGY_LINK:-/usr/local/bin/agy}"
RESTART_GATEWAY="${RESTART_GATEWAY:-0}"

id "$OPENCLAW_USER" >/dev/null 2>&1 || die "user '$OPENCLAW_USER' not found (set OPENCLAW_USER=...)"
[ -x "$OPENCLAW_BIN" ] || die "openclaw CLI not found at $OPENCLAW_BIN (set OPENCLAW_BIN=...)"
OPENCLAW_HOME="$(getent passwd "$OPENCLAW_USER" | cut -d: -f6)"
[ -n "$OPENCLAW_HOME" ] || die "cannot resolve home dir for $OPENCLAW_USER"

REPO_ROOT="$(cd "$(dirname "$0")/.." && pwd)"
PLUGIN_DIR="$REPO_ROOT/plugin"
[ -f "$PLUGIN_DIR/index.js" ] || die "plugin not found at $PLUGIN_DIR/index.js"
[ -f "$PLUGIN_DIR/openclaw.plugin.json" ] || die "plugin manifest not found at $PLUGIN_DIR/openclaw.plugin.json"

AGY_BIN="$OPENCLAW_HOME/.local/bin/agy"
asu() { sudo -u "$OPENCLAW_USER" env HOME="$OPENCLAW_HOME" "$@"; }
# Trim OpenClaw's noisy doctor/migration banner from CLI output.
denoise() { grep -viE 'Doctor warnings|state-migrations|config-health|Left legacy|Left plugin install index|shared SQLite|conflicting plugin|^[[:space:]]*[│◇├╮╯─]'; }

# 1) Ensure agy is installed for the service user.
if [ -x "$AGY_BIN" ]; then
  # asu: never execute the service user's binary as root — a compromised
  # service account must not get code execution in this root script.
  log "agy present: $AGY_BIN ($(asu "$AGY_BIN" --version 2>/dev/null || echo '?'))"
else
  log "installing Antigravity CLI (agy) for user '$OPENCLAW_USER' ..."
  asu env PATH=/usr/local/bin:/usr/bin:/bin \
    bash -c 'curl -fsSL https://antigravity.google/cli/install.sh | bash' \
    || die "agy install failed"
  [ -x "$AGY_BIN" ] || die "agy not present at $AGY_BIN after install"
  log "agy installed: $(asu "$AGY_BIN" --version 2>/dev/null || echo '?')"
fi

# 2) Expose agy on the gateway PATH (plain symlink, no translation).
ln -sfn "$AGY_BIN" "$AGY_LINK"
log "agy on PATH: $AGY_LINK -> $AGY_BIN"

# 2b) Install the cached model-list helper so the /antigravity model menu stays
#     fast/fresh. The plugin reads the cache file directly; this helper + timer
#     keep it populated out-of-band (never blocking the panel on a slow agy).
MODELS_HELPER="$(dirname "$AGY_LINK")/agy-models"
if [ -f "$REPO_ROOT/bin/agy-models" ]; then
  install -m 0755 "$REPO_ROOT/bin/agy-models" "$MODELS_HELPER"
  log "models helper on PATH: $MODELS_HELPER"

  if command -v systemctl >/dev/null 2>&1 && [ -d /etc/systemd/system ]; then
    cat > /etc/systemd/system/antigravity-models-refresh.service <<EOF
[Unit]
Description=Refresh Antigravity (agy) model-list cache for the /antigravity panel
[Service]
Type=oneshot
User=$OPENCLAW_USER
ExecStart=$MODELS_HELPER --refresh
EOF
    cat > /etc/systemd/system/antigravity-models-refresh.timer <<EOF
[Unit]
Description=Daily refresh of the Antigravity model-list cache
[Timer]
OnCalendar=daily
Persistent=true
RandomizedDelaySec=1h
[Install]
WantedBy=timers.target
EOF
    systemctl daemon-reload 2>/dev/null || true
    systemctl enable --now antigravity-models-refresh.timer >/dev/null 2>&1 \
      && log "model-cache refresh timer enabled (daily)" \
      || log "could not enable model-cache refresh timer"
  fi

  # Initial cache populate (bounded so a slow agy never hangs install).
  if sudo -u "$OPENCLAW_USER" env HOME="$OPENCLAW_HOME" GEMINI_AGY_BIN="$AGY_BIN" \
       timeout 30 "$MODELS_HELPER" --refresh >/dev/null 2>&1; then
    log "model cache populated"
  else
    log "initial model-cache refresh skipped (agy slow) — bootstrap list used until the timer refreshes"
  fi
fi

# 3) Remove superseded legacy pieces.
#    3a) legacy gemini->agy translation shim (marker; match the old name too so an
#        upgrade from a pre-rename install still cleans it up).
for legacy in /usr/local/bin/gemini /opt/openclaw/tools/node*/bin/gemini; do
  [ -e "$legacy" ] || continue
  if head -n2 "$legacy" 2>/dev/null | grep -qE 'gemini-(claw|agy)-shim' \
     || grep -qE 'gemini-(claw|agy)-shim' "$legacy" 2>/dev/null; then
    rm -f "$legacy" && log "removed legacy translation shim: $legacy"
  fi
done
#    3b) old `antigravity` agent skill (superseded by the plugin). OpenClaw has
#        no `skills uninstall`, so drop the managed skill dir.
LEGACY_SKILL="$OPENCLAW_HOME/.openclaw/skills/antigravity"
if [ -d "$LEGACY_SKILL" ]; then
  rm -rf "$LEGACY_SKILL" && log "removed superseded 'antigravity' skill: $LEGACY_SKILL"
fi

# 4) Install/refresh the antigravity plugin.
#    Stage into a dir the service user can read (the repo may live under /root,
#    which the openclaw user cannot traverse).
log "installing 'antigravity' plugin ..."
STAGE="$(mktemp -d "${TMPDIR:-/tmp}/gemini-claw-plugin.XXXXXX")"
trap 'rm -rf "$STAGE"' EXIT
cp "$PLUGIN_DIR/index.js" "$PLUGIN_DIR/package.json" "$PLUGIN_DIR/openclaw.plugin.json" "$STAGE"/
[ -f "$PLUGIN_DIR/README.md" ] && cp "$PLUGIN_DIR/README.md" "$STAGE"/ || true
# The service user needs to read the stage; ownership is enough. The mktemp dir
# is 0700, so keep it owner-only (no world-read of a shared /tmp path).
chown -R "$OPENCLAW_USER":"$OPENCLAW_USER" "$STAGE" 2>/dev/null || true
chmod -R go-rwx "$STAGE" 2>/dev/null || true
asu "$OPENCLAW_BIN" plugins install --force "$STAGE" 2>&1 | denoise | sed 's/^/[plugins] /'
rm -rf "$STAGE"; trap - EXIT
# The pipeline above cannot fail the script (no pipefail) — verify the install
# actually landed instead of trusting exit codes. Byte-compare the installed
# entry against our source so a failed re-install that left an OLD copy in place
# is caught, not reported as success.
INSTALLED_PLUGIN="$OPENCLAW_HOME/.openclaw/extensions/antigravity/index.js"
[ -f "$INSTALLED_PLUGIN" ] || die "plugin install failed: $INSTALLED_PLUGIN not found"
cmp -s "$PLUGIN_DIR/index.js" "$INSTALLED_PLUGIN" \
  || die "plugin install did not land the current index.js (old copy left in place?)"
if asu "$OPENCLAW_BIN" plugins list 2>/dev/null | grep -iE 'antigravity' | grep -qi 'enabled'; then
  log "plugin 'antigravity' installed and enabled"
else
  die "plugin installed on disk but not enabled — check 'openclaw plugins inspect antigravity'"
fi

# 4b) Install/refresh the antigravity agent skills (antigravity_ask, antigravity_image).
#     These give the LLM agent an EXPLICIT route to agy, complementing the /antigravity
#     plugin (which bypasses the agent). Deployed into the OpenClaw workspace skills/bin
#     dirs, mirroring the other workspace skills (antic, firecrawl_web, ...). Additive
#     and best-effort: a skill-deploy hiccup must never fail the (already-done) plugin
#     install, so this block runs with errexit relaxed.
SKILLS_SRC="$REPO_ROOT/skills"
WORKSPACE_DIR="$OPENCLAW_HOME/.openclaw/workspace"
if [ -d "$SKILLS_SRC" ] && [ -d "$WORKSPACE_DIR" ]; then
  log "installing agent skills (antigravity_ask, antigravity_image) ..."
  set +e
  skills_ok=1
  # Stage where the service user can read (the repo may live under /root, which the
  # openclaw user cannot traverse) — same trick as the plugin stage above. Trap-clean
  # the stage so an interrupt mid-block does not leak it.
  SKILL_STAGE="$(mktemp -d "${TMPDIR:-/tmp}/gemini-claw-skills.XXXXXX")"
  if [ -n "$SKILL_STAGE" ] && [ -d "$SKILL_STAGE" ]; then
    trap 'rm -rf "$SKILL_STAGE"' EXIT
    cp -r "$SKILLS_SRC/." "$SKILL_STAGE"/
    chown -R "$OPENCLAW_USER":"$OPENCLAW_USER" "$SKILL_STAGE" 2>/dev/null
    chmod -R go-rwx "$SKILL_STAGE" 2>/dev/null
  else
    skills_ok=0
  fi
  # The service user must be able to traverse AND read the stage; chowning the leaf is
  # not enough if a root-owned TMPDIR parent (e.g. libpam-tmpdir) blocks traversal.
  # Probe an actually-DEPLOYED file (not a doc that could be renamed) so a readable
  # stage is never misjudged. An unreadable stage must NOT reach the destructive swap.
  if [ "$skills_ok" = 1 ] && asu test -r "$SKILL_STAGE/antigravity_ask/SKILL.md"; then
    asu mkdir -p "$WORKSPACE_DIR/skills" "$WORKSPACE_DIR/bin"
    for skill in antigravity_ask antigravity_image; do
      [ -d "$SKILL_STAGE/$skill" ] || { skills_ok=0; continue; }
      # Atomic swap: build the new copy alongside, then replace. Never remove the
      # working skill before the fresh copy is confirmed on disk.
      asu rm -rf "$WORKSPACE_DIR/skills/.$skill.new"
      if asu cp -r "$SKILL_STAGE/$skill" "$WORKSPACE_DIR/skills/.$skill.new"; then
        asu find "$WORKSPACE_DIR/skills/.$skill.new/scripts" -type f -name '*.py' -exec chmod 0755 {} + 2>/dev/null
        asu rm -rf "$WORKSPACE_DIR/skills/$skill"
        asu mv "$WORKSPACE_DIR/skills/.$skill.new" "$WORKSPACE_DIR/skills/$skill"
      else
        log "WARNING: could not stage skill '$skill'; leaving any existing copy untouched"
        asu rm -rf "$WORKSPACE_DIR/skills/.$skill.new"
        skills_ok=0
      fi
    done
    for w in antigravity-ask antigravity-image; do
      [ -f "$SKILL_STAGE/bin/$w" ] || { skills_ok=0; continue; }
      if asu cp "$SKILL_STAGE/bin/$w" "$WORKSPACE_DIR/bin/$w"; then
        asu chmod 0755 "$WORKSPACE_DIR/bin/$w"
      else
        log "WARNING: could not install wrapper '$w'"
        skills_ok=0
      fi
    done
    # Verify by CONTENT, not mere existence — mirrors the plugin block's cmp so a stale
    # prior install (old files left in place by a failed copy) cannot read as success.
    for f in antigravity_ask/scripts/ask.py antigravity_image/scripts/gen.py; do
      asu cmp -s "$SKILL_STAGE/$f" "$WORKSPACE_DIR/skills/$f" || skills_ok=0
    done
    for w in antigravity-ask antigravity-image; do
      asu cmp -s "$SKILL_STAGE/bin/$w" "$WORKSPACE_DIR/bin/$w" || skills_ok=0
      asu test -x "$WORKSPACE_DIR/bin/$w" || skills_ok=0
    done
    if [ "$skills_ok" = 1 ]; then
      log "agent skills installed: antigravity_ask, antigravity_image (visible after gateway restart)"
    else
      log "WARNING: agent-skill deploy did not fully land — check $WORKSPACE_DIR/skills and $WORKSPACE_DIR/bin"
    fi
  else
    log "skill stage unusable/unreadable by $OPENCLAW_USER (TMPDIR traversal?); skipping agent-skill install"
  fi
  [ -n "$SKILL_STAGE" ] && rm -rf "$SKILL_STAGE"; trap - EXIT
  set -e
else
  log "workspace ($WORKSPACE_DIR) or skills source missing; skipping agent-skill install"
fi

# 5) Report auth state (does NOT log in; use scripts/login.sh for that).
if asu bash -c 'cd "$HOME" && exec timeout 90 "$0" -p "Reply with exactly: OK" </dev/null' "$AGY_LINK" >/dev/null 2>&1; then
  log "auth OK - agy answers prompts."
else
  log "agy installed but NOT authenticated yet."
  log "  -> run: sudo scripts/login.sh   (Google AI Pro OAuth, needs a browser once)"
fi

# 6) Restart the gateway so it loads the plugin (required for a live gateway).
if [ "$RESTART_GATEWAY" = "1" ]; then
  if systemctl is-active --quiet openclaw-gateway 2>/dev/null; then
    log "restarting openclaw-gateway to load the plugin ..."
    systemctl restart openclaw-gateway
    log "gateway restarted."
  else
    log "openclaw-gateway not active; skipping restart."
  fi
else
  log "note: restart the gateway (RESTART_GATEWAY=1) to load the plugin into the live bot."
fi

log "done. Send /antigravity in Telegram to open the control panel."
