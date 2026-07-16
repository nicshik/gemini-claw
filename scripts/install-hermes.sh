#!/usr/bin/env bash
# gemini-claw installer for a HERMES host (a Python Telegram agent running
# `codex exec` under a hardened systemd unit — no OpenClaw). Idempotent; safe
# to re-run after every `git pull`. Full background: docs/hermes-deployment.md.
#
# 1. Installs the Antigravity CLI (agy) for the Hermes service user if missing
#    and exposes it on PATH (/usr/local/bin/agy).
# 2. Installs the agy-models cache helper + daily refresh timer (feeds the
#    bot's native /antigravity panel).
# 3. Opens ~/.gemini to the hardened unit via a systemd drop-in
#    (ReadWritePaths) — agy keeps its OAuth token and artifacts there.
# 4. Deploys the antigravity_ask / antigravity_image agent skills into the
#    Hermes workspace WITH the Hermes addendum (absolute wrapper paths,
#    per-task delivery, reference images).
# 5. Places absolute-path wrappers on PATH (/usr/local/bin/antigravity-*).
#    They must NOT live in workspace/bin: the Hermes deploy rsyncs it
#    with --delete.
#
# Run as root:  sudo scripts/install-hermes.sh
# The one step this script cannot do is the Google AI Pro OAuth:
#   sudo OPENCLAW_USER=<user> scripts/login.sh   (browser, once per host)
#
# Env overrides:
#   HERMES_USER       service user running the bot        (default: hermes)
#   HERMES_UNIT       systemd unit of the bot             (default: hermes-agent)
#   HERMES_WORKSPACE  codex workspace root                (default: /srv/hermes-agent/workspace)
#   AGY_LINK          where agy is exposed on PATH        (default: /usr/local/bin/agy)
#   RESTART_AGENT     1 = restart the unit (needed once, to apply the drop-in)
set -eu

log() { printf '[gemini-claw:hermes] %s\n' "$*"; }
die() { printf '[gemini-claw:hermes] ERROR: %s\n' "$*" >&2; exit 1; }

[ "$(id -u)" -eq 0 ] || die "run as root"

HERMES_USER="${HERMES_USER:-hermes}"
HERMES_UNIT="${HERMES_UNIT:-hermes-agent}"
HERMES_WORKSPACE="${HERMES_WORKSPACE:-/srv/hermes-agent/workspace}"
AGY_LINK="${AGY_LINK:-/usr/local/bin/agy}"
RESTART_AGENT="${RESTART_AGENT:-0}"

id "$HERMES_USER" >/dev/null 2>&1 || die "user '$HERMES_USER' not found (set HERMES_USER=...)"
HERMES_HOME="$(getent passwd "$HERMES_USER" | cut -d: -f6)"
[ -n "$HERMES_HOME" ] || die "cannot resolve home dir for $HERMES_USER"
[ -d "$HERMES_WORKSPACE/skills" ] || die "no skills dir at $HERMES_WORKSPACE/skills — is the Hermes stack deployed? (set HERMES_WORKSPACE=...)"

REPO_ROOT="$(cd "$(dirname "$0")/.." && pwd)"
[ -d "$REPO_ROOT/skills/antigravity_image" ] || die "skills not found in $REPO_ROOT/skills"
AGY_BIN="$HERMES_HOME/.local/bin/agy"
asu() { sudo -u "$HERMES_USER" env HOME="$HERMES_HOME" "$@"; }

# 1) agy for the service user + PATH symlink.
if [ -x "$AGY_BIN" ]; then
  # asu: never execute the service user's binary as root.
  log "agy present: $AGY_BIN ($(asu "$AGY_BIN" --version 2>/dev/null | head -1 || echo '?'))"
else
  log "installing Antigravity CLI (agy) for user '$HERMES_USER' ..."
  asu env PATH=/usr/local/bin:/usr/bin:/bin \
    bash -c 'curl -fsSL https://antigravity.google/cli/install.sh | bash' \
    || die "agy install failed"
  [ -x "$AGY_BIN" ] || die "agy not present at $AGY_BIN after install"
fi
ln -sfn "$AGY_BIN" "$AGY_LINK"
log "agy on PATH: $AGY_LINK -> $AGY_BIN"

# 2) agy-models cache helper + daily refresh timer (panel model list).
install -m 0755 "$REPO_ROOT/bin/agy-models" /usr/local/bin/agy-models
cat > /etc/systemd/system/antigravity-models-refresh.service <<EOF
[Unit]
Description=Refresh Antigravity (agy) model-list cache for the /antigravity panel
[Service]
Type=oneshot
User=$HERMES_USER
Environment=HOME=$HERMES_HOME
ExecStart=/usr/local/bin/agy-models --refresh
EOF
cat > /etc/systemd/system/antigravity-models-refresh.timer <<'EOF'
[Unit]
Description=Daily refresh of the Antigravity model-list cache
[Timer]
OnCalendar=daily
Persistent=true
RandomizedDelaySec=1h
[Install]
WantedBy=timers.target
EOF
systemctl daemon-reload
systemctl enable --now antigravity-models-refresh.timer >/dev/null 2>&1 \
  && log "model-cache refresh timer enabled (daily)" \
  || log "WARNING: could not enable model-cache refresh timer"
if asu timeout 60 /usr/local/bin/agy-models --refresh >/dev/null 2>&1; then
  log "model cache populated"
else
  log "initial model-cache refresh skipped (agy slow/unauthenticated) — bootstrap list used until the timer refreshes"
fi

# 3) systemd drop-in: the hardened unit needs write access to ~/.gemini.
asu mkdir -p "$HERMES_HOME/.gemini"
mkdir -p "/etc/systemd/system/$HERMES_UNIT.service.d"
cat > "/etc/systemd/system/$HERMES_UNIT.service.d/antigravity.conf" <<EOF
[Service]
# agy (Antigravity CLI) keeps its OAuth token and artifacts in ~/.gemini
ReadWritePaths=$HERMES_HOME/.gemini
EOF
systemctl daemon-reload
log "drop-in installed: $HERMES_UNIT.service.d/antigravity.conf (ReadWritePaths=$HERMES_HOME/.gemini)"

# 4) Agent skills into the workspace, with the Hermes addendum. Atomic swap:
#    build the new copy alongside, then replace — never leave a half-copied skill.
for skill in antigravity_ask antigravity_image; do
  src="$REPO_ROOT/skills/$skill"
  dst="$HERMES_WORKSPACE/skills/$skill"
  rm -rf "$dst.new"
  cp -r "$src" "$dst.new"
  if [ "$skill" = "antigravity_image" ]; then
    cat >> "$dst.new/SKILL.md" <<EOF

## Hermes

- Запускай обёртку по абсолютному пути: \`/usr/local/bin/antigravity-image …\`
  (путь \`~/.openclaw/workspace/bin/...\` выше — для OpenClaw, здесь его нет).
- Hermes доставляет в Telegram только файлы из каталога задачи (он передан в
  промпте строкой «Каталог для файлов этой задачи: <путь>»). После генерации
  скопируй каждый файл из строк \`IMAGE: <путь>\` в этот каталог:
  \`cp "<путь из IMAGE:>" "<каталог задачи>/"\`.
- Если в промпте задачи указан референс-файл (строка «Референс-изображение:
  <путь>») — передай его через \`--reference <путь>\`.
- Не утверждай, что картинка готова и отправлена, пока файл не лежит в
  каталоге задачи.
EOF
  else
    cat >> "$dst.new/SKILL.md" <<EOF

## Hermes

- Запускай обёртку по абсолютному пути: \`/usr/local/bin/antigravity-ask …\`
  (путь \`~/.openclaw/workspace/bin/...\` выше — для OpenClaw, здесь его нет).
EOF
  fi
  rm -rf "$dst"
  mv "$dst.new" "$dst"
  chown -R "$HERMES_USER":"$HERMES_USER" "$dst"
  grep -q '^## Hermes' "$dst/SKILL.md" || die "Hermes addendum missing in $dst/SKILL.md after deploy"
  log "skill deployed: $skill (with Hermes addendum)"
done

# 5) Absolute-path wrappers on PATH (NOT in workspace/bin — deploy --delete).
cat > /usr/local/bin/antigravity-image <<EOF
#!/usr/bin/env bash
set -euo pipefail
export OPENCLAW_WORKSPACE_DIR="\${OPENCLAW_WORKSPACE_DIR:-$HERMES_WORKSPACE}"
exec python3 $HERMES_WORKSPACE/skills/antigravity_image/scripts/gen.py "\$@"
EOF
cat > /usr/local/bin/antigravity-ask <<EOF
#!/usr/bin/env bash
set -euo pipefail
exec python3 $HERMES_WORKSPACE/skills/antigravity_ask/scripts/ask.py "\$@"
EOF
chmod 0755 /usr/local/bin/antigravity-image /usr/local/bin/antigravity-ask
log "wrappers on PATH: /usr/local/bin/antigravity-image, /usr/local/bin/antigravity-ask"

# 6) Restart the unit (required ONCE after the drop-in first appears).
if [ "$RESTART_AGENT" = "1" ]; then
  if systemctl is-active --quiet "$HERMES_UNIT" 2>/dev/null; then
    log "restarting $HERMES_UNIT to apply the drop-in ..."
    systemctl restart "$HERMES_UNIT"
    systemctl is-active --quiet "$HERMES_UNIT" || die "$HERMES_UNIT did not come back after restart"
    log "$HERMES_UNIT restarted."
  else
    log "$HERMES_UNIT not active; skipping restart."
  fi
else
  if ! systemctl show "$HERMES_UNIT" -p ReadWritePaths --value 2>/dev/null | grep -q "$HERMES_HOME/.gemini"; then
    log "note: the running unit does not have the drop-in yet — re-run with RESTART_AGENT=1 to apply it."
  fi
fi

# 7) Auth state (does NOT log in; login.sh does).
if asu bash -c 'cd "$HOME" && exec timeout 90 "$0" -p "Reply with exactly: OK" </dev/null' "$AGY_LINK" >/dev/null 2>&1; then
  log "auth OK - agy answers prompts."
else
  log "agy installed but NOT authenticated yet."
  log "  -> run: sudo OPENCLAW_USER=$HERMES_USER scripts/login.sh   (Google AI Pro OAuth, needs a browser once)"
fi

log "done. Bot-side routing (skills registry, /antigravity panel, photo references) lives in the Hermes repo — see docs/hermes-deployment.md, step 7."
