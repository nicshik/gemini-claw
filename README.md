# gemini-claw

[![CI](https://github.com/nicshik/gemini-claw/actions/workflows/preflight.yml/badge.svg)](https://github.com/nicshik/gemini-claw/actions/workflows/preflight.yml)
[![License: MIT](https://img.shields.io/badge/License-MIT-blue.svg)](LICENSE)

Install the **Antigravity CLI (`agy`)** on an OpenClaw server and register an
`antigravity` **control-panel plugin** for it — under a Google **AI Pro** session.

> **TL;DR** — on the OpenClaw host, one line as root:
> `curl -fsSL https://raw.githubusercontent.com/nicshik/gemini-claw/main/scripts/bootstrap.sh | sudo bash`
> — fetches the repo and runs the whole setup (deps → preflight → install → login
> → buttons → restart → healthcheck). The one human step is the Google AI Pro
> OAuth. Then send `/antigravity` in Telegram. Prerequisites and step-by-step below.

Google retired the standalone `gemini` CLI for individual tiers (it fails with
`IneligibleTierError: UNSUPPORTED_CLIENT → "migrate to Antigravity"`). The
successor is the **Antigravity CLI** (`agy`). This repo installs `agy`, puts it on
the gateway's `PATH`, and installs a native OpenClaw plugin that exposes a
`/antigravity` control panel in chat (Telegram) — no translation shims, no
pretending to be the old `gemini` CLI.

Works on any **OpenClaw host** running the gateway as a dedicated service user. It
is OpenClaw-specific glue — it installs into the OpenClaw gateway via `openclaw
plugins install`, so it does not apply to non-OpenClaw agent stacks.

## Why a plugin (not a skill)

The panel is an OpenClaw **plugin command**, so `/antigravity` is handled *before
the LLM agent*. Menu navigation, model switching, and status are drawn in code in
milliseconds — no model is invoked to render a menu, so it is instant and immune
to a slow/flaky agent backend. (An earlier version was an agent *skill*: the bot's
LLM had to interpret every tap, which was slow and stalled whenever the model
backend flapped.) The only slow parts left are the real `agy` calls (`ask` /
`image`), which are slow because `agy` itself is — with no LLM overhead on top.

The plugin is a first-class, portable OpenClaw extension: installed via
`openclaw plugins install`, it lives under the service user's home and survives
`openclaw update` — and drops into any host running a compatible OpenClaw with no
dist patching or harness wiring.

## What it does

- Installs `agy` for the OpenClaw service user (official `curl … | bash` installer).
- Symlinks `agy` onto the gateway `PATH` (`/usr/local/bin/agy`) — a stable location
  that survives `openclaw update` / node bumps.
- Installs a model-list cache helper (`agy-models`) + a daily refresh timer so the
  `/antigravity model` menu is instant and self-updating.
- Installs the **`antigravity`** plugin (`openclaw plugins install`) into
  `~/.openclaw/extensions/`, separate from the git-synced workspace.

## The `/antigravity` panel

For users, everything lives in Telegram — no setup on their side. Send
`/antigravity` for the panel, `/antigravity_ask <вопрос>` to ask, and
`/antigravity_image <описание>` to generate an image. The operator installs it
once (below).

- `/antigravity` — main menu: **Модель · Статус** buttons, plus the two action
  commands printed in the body as tap-to-copy monospace (`/antigravity_ask` /
  `/antigravity_image`). They live in the body text, not as buttons — see
  [Command & rendering model](#command--rendering-model) for why.
- **Модель** → pick from the live model list (current marked `•`); the choice is
  the default `--model` for later `ask`/`image` calls.
- **Статус** → the current default model.
- `/antigravity_ask <вопрос>` — one-shot prompt, returns the answer. Sent with no
  argument, it replies with a monospace, tap-to-copy hint. The subcommand form
  `/antigravity ask <вопрос>` also works.
- `/antigravity_image <описание>` — generates an image (`generate_image` / Nano
  Banana 2) and returns it as a photo. Subcommand form `/antigravity image <описание>`
  also works.
- `/antigravity ping` — quick auth probe. `/antigravity reset` — clear default model.

Navigation is edit-in-place: tapping a button rewrites the same panel message
instead of posting a new one (`action.type:"callback"` + a `registerInteractiveHandler`
that calls `editMessage`). Typed subcommands still work as a fallback.

## Command & rendering model

This is the non-obvious part — read it before changing how commands or the panel
text render. It is the result of testing the real Telegram behavior on prod, not
guesswork.

**Two command shapes, on purpose.**

- `/antigravity` (+ subcommands `ask`, `image`, `model`, `status`, `ping`, `reset`,
  `continue`) — the panel and its typed fallbacks.
- `/antigravity_ask` and `/antigravity_image` — single-token commands. A whole-word
  command is one clickable token, and it is registered in the Telegram command menu
  (`commandAliases` with `kind: "runtime-slash"` in `openclaw.plugin.json`). The
  point of the single token: in Telegram's `/` autocomplete list, tapping a command
  **inserts it into the input** (you then type the argument and send). With the
  two-word `/antigravity ask …`, only `/antigravity` is a token and the ` ask …`
  tail is plain text.
  - Caveat (Telegram platform behavior, not fixable here): tapping a `/command`
    **link inside a message** SENDS it immediately (bare). So a bare tap lands on
    the no-argument hint. Only the `/` autocomplete path fills-then-lets-you-type.
  - Both single-token handlers and the `ask`/`image` subcommands share `doAsk` /
    `doImage`; the argument must be sent **together with the command in one
    message** — see "capture-next-message" below for why we can't prompt-then-read.

**Two render paths, with different formatting power — this drives every panel
decision.**

| Path | How | Markdown? | Tap-to-copy monospace? |
|------|-----|-----------|------------------------|
| Command-reply | handler returns `{ text, presentation }` | **Yes** (rich/HTML pipeline) | **Yes** — `` `…` `` → Telegram `code` entity |
| Interactive edit-in-place | `ctx.respond.editMessage` / `reply` inside `registerInteractiveHandler` | **No** — sent with no `parse_mode` (plain) | No |

Verified in the OpenClaw runtime: the interactive Telegram `respond` exposes only
`reply` / `editMessage` / `editButtons` / `clearButtons` / `deleteMessage`, and all
send plain text. So **a button tap can never render a monospace/tap-to-copy
command.** Only a real command reply can.

Consequences baked into the plugin:

- The two action commands are printed **in the menu body as `code` spans**, not as
  inline buttons — so they render monospace/tap-to-copy on the `/antigravity`
  command reply. (The old "Спросить"/"Картинка" buttons were removed: they were a
  dead-end that could only ever show a non-copyable, plain hint.)
- `menuMain(defaultModel, { withCommands })`: the command lines are shown **only**
  on the command-reply path (`withCommands: true`). Edit-in-place back-navigation
  passes `withCommands: false` and omits them, so you never see a plain,
  non-monospace copy of the commands — they appear only where they are actually
  tap-to-copy.
- `plainText()` strips backticks on the edit-in-place path as a defensive measure
  (literal backticks would otherwise show through there).
- The no-argument hints have two variants: `*_HINT_MD` (backticked, for the
  command-reply path) and plain `*_HINT` (edit-in-place fallback).
- A `presentation`-only reply (no top-level `text`) is treated as "no response" —
  hint replies must set `text`.

**Investigated and deliberately NOT built: "capture-next-message"** (tap command →
"Введите запрос:" → your next bare message becomes the argument). It is not cleanly
possible for this plugin:

- Reliable interception uses the `inbound_claim` hook, which only fires for a plugin
  that **owns a conversation binding** — channel/bundled-plugin machinery, no simple
  create-on-demand API for a command plugin.
- Persistent per-chat pending state via `openKeyedStore` is gated to trusted plugins
  (`origin === "bundled" || trustedOfficialInstall === true`); this plugin is
  `Origin: global`, so it throws. (It already uses a plain JSON file for the default
  model for the same reason.)
- The one inbound hook we can register (`message_received`) is observational
  (`=> void`) — it can't stop a message reaching the LLM agent, so it can't consume
  the input.
- Telegram `force_reply` is not exposed by the plugin reply layer either.

So the argument is always sent in one message with the command; the single-token
commands + `/` autocomplete are the best native affordance available.

Buttons need `channels.telegram.capabilities.inlineButtons` set to `dm` (or
`all`); the installer leaves this to you (it is a channel policy):

```bash
openclaw config set channels.telegram.capabilities.inlineButtons dm
```

## Prerequisites

The host must be an OpenClaw gateway you administer as root:

- **OpenClaw >= 2026.6.11** on the gateway (the plugin SDK with `registerCommand` /
  `registerInteractiveHandler`). Check: `openclaw --version`.
- The gateway runs as a **dedicated service user** with a real home dir, under a
  systemd unit. Defaults assumed by the scripts: user `openclaw`, unit
  `openclaw-gateway`, CLI `/opt/openclaw/bin/openclaw`. Other hosts differ —
  override via env (see *Install on another host*).
- A **Google AI Pro** account for the agy OAuth. Login is **per host** and needs a
  browser once (`scripts/login.sh`); the token is machine-local and never copied
  between servers.
- **Inline buttons enabled** for the Telegram channel — the panel is button-driven,
  and without this the buttons silently do not render:
  ```bash
  openclaw config set channels.telegram.capabilities.inlineButtons dm
  ```
  The installer does **not** flip this — it is your channel policy.
- Host tooling: `bash`, `curl`, `tmux` (login only), `systemd`.

## Install

On the target server, as root — one line:

```bash
curl -fsSL https://raw.githubusercontent.com/nicshik/gemini-claw/main/scripts/bootstrap.sh | sudo bash
```

`bootstrap.sh` fetches the repo (git, or a tarball if git is absent) into
`/root/gemini-claw` and runs `setup.sh`. Pass setup flags after `-s --`, e.g.
`… | sudo bash -s -- --yes`. Or clone and run it yourself:

```bash
git clone https://github.com/nicshik/gemini-claw && cd gemini-claw
sudo scripts/setup.sh
```

`setup.sh` orchestrates the whole flow, idempotently and safe to re-run:
**deps** (auto-install `curl`/`tmux`) → **preflight** (fail-fast env checks) →
**install** (agy + PATH symlink + plugin) → **login** (Google AI Pro OAuth;
self-skips if already authenticated) → **telegram buttons** (sets the
`inlineButtons` capability, with a backup + `config validate`) → **restart
gateway** → **healthcheck**. Flags: `--yes` (don't prompt before the one config
edit), `--skip-login`, `--no-buttons`.

The equivalent manual step-by-step (what `setup.sh` runs, useful for debugging a
single stage):

```bash
sudo scripts/preflight.sh                     # read-only env checks, fail fast
sudo scripts/install.sh                       # agy + PATH symlink + antigravity plugin
sudo scripts/login.sh                         # one-time Google AI Pro OAuth (needs a browser)
openclaw config set channels.telegram.capabilities.inlineButtons dm
sudo RESTART_GATEWAY=1 scripts/install.sh     # restart the gateway to load the plugin
sudo scripts/healthcheck.sh                   # verify the whole chain
```

No outbound GitHub access from the server? Copy it over instead:

```bash
scp -r gemini-claw root@SERVER:/root/
ssh root@SERVER 'cd /root/gemini-claw && sudo RESTART_GATEWAY=1 scripts/install.sh'
```

### Installing via an AI coding agent

If an AI agent (Claude Code, Codex, …) with a **root shell** on the host is doing
the install, point it at one command:

```bash
sudo scripts/setup.sh --yes
```

It is idempotent and safe to re-run, auto-installs missing OS packages (`curl`,
`tmux`), and self-skips steps already done. The **one thing an agent cannot do
alone is the Google OAuth**: `login.sh` prints a URL that a *human* must open in a
browser, sign in with the AI Pro account, and paste the code back. So the agent
can drive everything except that ~30-second human step — run `--skip-login` first
if you want to do the login separately, then re-run without it.

### Install on another OpenClaw host

For another host that also runs OpenClaw (this plugin does not apply to non-OpenClaw
agents), the scripts are host-parametric via env overrides — nothing is hard-wired
to a particular host. On a host whose gateway user/paths differ from the defaults,
discover them and pass them in:

```bash
# the service user and openclaw CLI the gateway actually uses
systemctl show -p User --value openclaw-gateway                               # -> OPENCLAW_USER
command -v openclaw || systemctl show -p ExecStart --value openclaw-gateway   # -> OPENCLAW_BIN
```

Then run the same flow with those values (example — substitute what you found):

```bash
sudo OPENCLAW_USER=openclaw OPENCLAW_BIN=/opt/openclaw/bin/openclaw \
     RESTART_GATEWAY=1 scripts/install.sh
sudo OPENCLAW_USER=openclaw scripts/login.sh                    # per-host AI Pro OAuth (browser)
sudo OPENCLAW_USER=openclaw OPENCLAW_BIN=/opt/openclaw/bin/openclaw scripts/healthcheck.sh
```

Per host you still need: a **fresh AI Pro login** (`login.sh` — an OAuth token does
not transfer between hosts), the **inlineButtons** capability set for that bot, and
OpenClaw >= 2026.6.11. Where the gateway uses the default layout (user `openclaw`,
CLI `/opt/openclaw/bin/openclaw`), the env overrides can be omitted entirely.

### Login flow

`scripts/login.sh` runs `agy` in a `tmux` session, prints the Google authorization
URL, and waits. Open the URL in your **local** browser, sign in with the AI Pro
account, copy the code the page shows, and paste it back. It walks the first-run
onboarding (theme, **telemetry left OFF**, folder trust) and verifies. If the
automated onboarding can't finish, it prints a `tmux attach` command to complete it
by hand.

## Updating a live server (git pull, not scp)

Once a host is installed, keep it in sync with **git**, not by re-copying files. An
untracked `scp` copy silently drifts from the repo, and a stale copy's `install.sh`
will happily reinstall the OLD plugin over a newer one (its `cmp` self-check passes
because it compares the stale copy against what it just copied). So keep a real
clone on the host:

```bash
# one-time, on the server (as root):
git clone https://github.com/nicshik/gemini-claw /root/gemini-claw
cd /root/gemini-claw
```

Then every deploy is just:

```bash
cd /root/gemini-claw && git pull
sudo RESTART_GATEWAY=1 scripts/install.sh
sudo scripts/healthcheck.sh
```

This is a public repo, so a plain `git clone` / `git pull` needs no credentials or
deploy key.

## Using `agy` directly

The plugin shells out to `agy`; you can also use it from a shell:

- `agy -p "…"` — one-shot prompt.
- `agy --model "Gemini 3.1 Pro (High)" -p "…"` — pick the model (human names from
  `agy models`; old ids like `gemini-2.5-pro` are silently ignored).
- `agy -p "…" --output-format json` — JSON envelope; the answer is in `.response`.
- `cat file | agy -p "Summarize"` — stdin.
- Models: `Gemini 3.5 Flash (Low|Medium|High)`, `Gemini 3.1 Pro (Low|High)`,
  `Claude Sonnet/Opus 4.6 (Thinking)`, `GPT-OSS 120B (Medium)`.

> `agy` is an interactive agent: always close stdin (`agy … </dev/null`) in
> scripts, or it reads leftover stdin as a prompt and hangs. The plugin and the
> `agy-models` helper already do this.

## Image generation

`agy` includes a `generate_image` tool (model **Nano Banana 2**, fixed / not
selectable):

```bash
agy --print-timeout 3m -p 'Use your generate_image tool to create a 1:1 image:
a small matte black cube on a light gray background, no text. Save it as an artifact.'
```

Text-to-image and edit/composition (up to 3 inputs); aspect ratios
`1:1 16:9 9:16 4:3 3:4 3:2 2:3`. Caveats: `--model` does not change the image model;
output lands under `~/.gemini/antigravity-cli/brain/<uuid>/…`; it's slower (raise
`--print-timeout`) and may be geo-restricted in some eu/us regions.

**Telegram delivery.** OpenClaw only sends outbound media from an allowed root (the
workspace), not from an arbitrary local path — so the plugin cannot hand Telegram the
raw `~/.gemini/…/brain/…` file. After generation it copies the newest brain image to
`<workspace>/outputs/antigravity-images/` (`OPENCLAW_WORKSPACE_DIR` or
`~/.openclaw/workspace`) and returns *that* path as the photo. Without this, the send
is silently rejected. If the copy itself fails, the panel replies with a clear error
instead of throwing. The folder self-prunes to the newest `ANTIGRAVITY_IMAGE_KEEP`
files (default 20) on each publish, so it never grows without bound.

### Image quota (`429 Resource Exhausted`)

Image generation uses a **separate model** — Nano Banana 2, model id
`gemini-3.1-flash-image` — and Antigravity meters quota **per model**, so the image
limit is exhausted independently of the text/reasoning models. You can hit
`429 RESOURCE_EXHAUSTED` on `/antigravity image` while `/antigravity ask` (a different
model) still has plenty of quota left. The plugin detects this and shows a short
message (with the reset window if `agy` returns one) instead of the raw error, and
never sends a stale image on failure.

On Google AI Pro the quota refreshes on a ~5-hour rolling window under a weekly cap;
Google does not publish the image bucket's exact size or reset window, so the
"resets in ~N" figure comes live from the backend. This is a quota limit, not a
geo-block (a region block would be HTTP `403`, and the EU/US are supported regions).
Sources: `ai.google.dev/gemini-api/docs/{rate-limits,image-generation}`,
`antigravity.google/docs/plans`, `blog.google` (Nano Banana 2 / Antigravity rate limits).

## Recovery after `openclaw update`

`agy` and its login live under the service user's home (`~/.local/bin/agy`,
`~/.gemini/…`); the PATH symlink is in `/usr/local/bin`; the plugin is in
`~/.openclaw/extensions/` — none of which an OpenClaw update touches. If something
regresses:

```bash
sudo scripts/healthcheck.sh                  # see what broke
sudo RESTART_GATEWAY=1 scripts/install.sh    # re-place symlink + reinstall plugin + reload
```

## Files

```
plugin/index.js            the OpenClaw 'antigravity' plugin (agy control panel)
plugin/openclaw.plugin.json plugin manifest (id, command aliases, activation)
                           aliases: antigravity, antigravity_ask, antigravity_image
plugin/package.json        openclaw.extensions -> ./index.js (no build step)
bin/agy-models             cached, self-refreshing model list for the panel
scripts/bootstrap.sh       curl | sudo bash entrypoint: fetch repo + run setup.sh
scripts/setup.sh           one-command orchestrator: deps->preflight->install->login->buttons->restart->healthcheck
scripts/preflight.sh       read-only env checks (root, openclaw version, user, tmux, network, disk, buttons)
scripts/install.sh         idempotent: agy + PATH symlink + plugin install
scripts/login.sh           one-time Google AI Pro OAuth via tmux (seeds onboarding config; walk is fallback)
scripts/healthcheck.sh     end-to-end verification, non-zero exit on failure
scripts/uninstall.sh       remove plugin + symlink + helper (--purge also removes agy)
scripts/secret-scan.sh     fail if any tracked file looks like a credential
docs/onboarding-improvement-plan.md  design notes for the onboarding flow
.github/workflows/preflight.yml  CI gate: shell/plugin syntax, JSON, secret-scan, no *bak*
```

## Onboarding internals

`login.sh` is the only fiddly part, because agy has **no `login`/`auth`
subcommand** — the Google OAuth is reachable only through the interactive TUI
(`agy -i`), which `login.sh` holds in tmux to read the auth URL and inject the
code you paste back. To keep that resilient:

- **Config seeding.** Before starting agy, `login.sh` writes agy's own onboarding
  state — `~/.gemini/antigravity-cli/settings.json` (`enableTelemetry:false`,
  trusted workspace) and `.../cache/onboarding.json` (onboarding-complete) — so the
  post-auth first-run screens (telemetry / trust-folder / color scheme) ideally
  never appear. The seed is a merge (foreign keys preserved), never a blind
  overwrite.
- **Key-walk fallback.** The old screen-scrape-and-send-keys walk is kept, but only
  fires if a screen still shows despite the seed; each firing logs that the seed
  didn't suppress it. So an agy config-schema change degrades to the old (working)
  behavior instead of breaking.
- **Version gate.** `KNOWN_GOOD_AGY` in `login.sh` records the agy version the walk
  was verified on (`1.0.16`); a mismatch prints a warning, not a failure.
- **Escape hatch.** If automation stalls, the tmux session is left alive:
  `sudo -u openclaw tmux -L agy-login attach -t login` to finish by hand, then
  re-run `scripts/healthcheck.sh`.

See [`docs/onboarding-improvement-plan.md`](docs/onboarding-improvement-plan.md).

## Hardening

CI (`.github/workflows/preflight.yml`) gates every push: `bash -n` on all scripts
and `bin/agy-models`, `node --check plugin/index.js`, JSON-validates the plugin
manifests, runs `scripts/secret-scan.sh`, and rejects tracked `*bak*` files. No
credentials live in the repo — the AI Pro OAuth token stays in the service user's
home on each host. The `v1.0-hardened` tag is the recovery checkpoint: if a host is
lost, `git checkout v1.0-hardened && sudo RESTART_GATEWAY=1 scripts/install.sh`
rebuilds the panel from a known-good state (only the one-time `scripts/login.sh`
OAuth is host-local).

## Configuration (env)

| Var | Default | Meaning |
|---|---|---|
| `OPENCLAW_USER` | `openclaw` | service user that runs the gateway |
| `OPENCLAW_BIN` | `/opt/openclaw/bin/openclaw` | openclaw CLI path |
| `AGY_LINK` | `/usr/local/bin/agy` | where `agy` is exposed on PATH |
| `RESTART_GATEWAY` | `0` | `install.sh`: restart gateway to load the plugin |

Plugin-runtime env (read by the gateway process, set in the gateway's environment,
not by `install.sh`): `OPENCLAW_WORKSPACE_DIR` — workspace root for outbound image
delivery (default `~/.openclaw/workspace`); `ANTIGRAVITY_IMAGE_KEEP` — how many
published images to retain before pruning (default `20`).

## Notes

- No credentials in this repo; the AI Pro OAuth token stays in the service user's
  home on each server and is never committed.
- Requires: `bash`, `curl`, `tmux` (login only), the `openclaw` CLI, and a systemd
  `openclaw-gateway` unit for the plugin reload.

## Installing via OpenClaw's native plugin CLI

There is no `openclaw plugins install <this repo>` one-liner, and that is
deliberate: native plugin install copies **only** the plugin JS. This plugin is
inert without the `agy` binary, its Google AI Pro OAuth login, the `PATH` symlink,
and the model-cache helper — all of which `scripts/install.sh` sets up. So the
supported install is always **clone + `scripts/install.sh`** (a bootstrap script is
the norm for plugins that ship an external binary/service). The script itself calls
`openclaw plugins install` under the hood to register the plugin.

## License

[MIT](LICENSE) © nicshik. No credentials are included in this repository; the
Google AI Pro OAuth token is created per host by `scripts/login.sh` and stays in the
service user's home — it is never committed.
