# gemini-claw

[![CI](https://github.com/nicshik/gemini-claw/actions/workflows/preflight.yml/badge.svg)](https://github.com/nicshik/gemini-claw/actions/workflows/preflight.yml)
[![License: MIT](https://img.shields.io/badge/License-MIT-blue.svg)](LICENSE)

Install the **Antigravity CLI (`agy`)** on an OpenClaw server and register an
`antigravity` **control-panel plugin** for it — under a Google **AI Pro** session.

🇷🇺 [Читать на русском](README.ru.md)

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

- `/antigravity` — main menu: **Модель · Статус · Формат картинок** buttons, plus
  the two action commands printed in the body as tap-to-copy monospace
  (`/antigravity_ask` / `/antigravity_image`). They live in the body text, not as
  buttons — see [Command & rendering model](#command--rendering-model) for why.
- **Модель** → pick from the live model list (current marked `•`); the choice is
  the default `--model` for later `ask`/`image` calls.
- **Статус** → the current default model and image aspect ratio.
- **Формат картинок** → pick the persistent default aspect ratio for
  `/antigravity_image` (current marked `•`; «авто» clears it). Stored in the same
  state file as the model choice, survives restarts, until changed.
- `/antigravity_ask <вопрос>` — one-shot prompt, returns the answer. Sent with no
  argument, it replies with a monospace, tap-to-copy hint. The subcommand form
  `/antigravity ask <вопрос>` also works.
- `/antigravity_image <описание>` — generates an image (`generate_image` / Nano
  Banana 2) and returns it as a photo. Subcommand form `/antigravity image <описание>`
  also works.
  - **Aspect ratio**: one-off as the first word — `/antigravity_image 16:9 закат
    над морем` (accepted: `1:1 2:3 3:2 3:4 4:3 9:16 16:9`), or a persistent
    default via **Формат картинок** in the panel (`/antigravity aspect [значение|auto]`).
    The plugin can't pass tool args to `agy`, so the ratio rides as a prompt
    instruction and the reasoning model fills `generate_image`'s `AspectRatio`
    parameter (verified live: `16:9` → 1376×768).
  - **Under every photo**: two inline buttons. **🔁 Ещё раз** regenerates with the
    same prompt + ratio and posts a new photo; **✏️ Изменить** sends the full
    command as tap-to-copy monospace so you can tweak and resend. The caption
    itself also carries the tap-to-copy command (kept ≤1024 chars so the buttons
    stay attached to the photo). Prompts are stored by short id in
    `~/.gemini/antigravity-image-prompts.json` (callback_data is capped at 64
    bytes; newest 100 kept), so buttons on very old photos may expire.
- `/antigravity ping` — quick auth probe. `/antigravity reset` — clear default model.

Navigation is edit-in-place: tapping a button rewrites the same panel message
instead of posting a new one (`action.type:"callback"` + a `registerInteractiveHandler`
that calls `editMessage`). Typed subcommands still work as a fallback.

## Command & rendering model

The panel is built around two non-obvious Telegram/OpenClaw constraints: two
command shapes (single-token `/antigravity_ask` for `/` autocomplete, plus the
panel subcommands) and two render paths with different formatting power (a command
reply can do markdown and tap-to-copy, an interactive edit-in-place cannot). That
is what decides where copyable commands appear and why "capture-next-message" is
not built. Full walk-through with examples, and the outbound-adapter escape hatch:
[`docs/plugin-internals.md`](docs/plugin-internals.md).

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
onboarding (theme, telemetry, folder trust) and verifies. If the
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

Caveat: on a 429/503 the reasoning model sometimes "handles" the error itself —
schedules its own retry timer, writes a status artifact — and returns an **empty**
answer, so there is nothing in `agy`'s stdout to detect. When an attempt produces
no image and no output, the plugin therefore also scans the brain transcripts
touched by that run for `RESOURCE_EXHAUSTED`/`429` and `MODEL_CAPACITY_EXHAUSTED`/`503`
markers and reports the real cause immediately instead of burning the remaining
retries on "the model never called the generator".

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

State on the server (service user's home, survives updates):
~/.gemini/antigravity-skill.json          default model + default image aspect ratio
~/.gemini/antigravity-image-prompts.json  prompt store for Recreate/Edit buttons (newest 100)
scripts/bootstrap.sh       curl | sudo bash entrypoint: fetch repo + run setup.sh
scripts/setup.sh           one-command orchestrator: deps->preflight->install->login->buttons->restart->healthcheck
scripts/preflight.sh       read-only env checks (root, openclaw version, user, tmux, network, disk, buttons)
scripts/install.sh         idempotent: agy + PATH symlink + plugin install
scripts/login.sh           one-time Google AI Pro OAuth via tmux (seeds onboarding config; walk is fallback)
scripts/healthcheck.sh     end-to-end verification, non-zero exit on failure
scripts/uninstall.sh       remove plugin + symlink + helper (--purge also removes agy)
scripts/secret-scan.sh     fail if any tracked file looks like a credential
docs/plugin-internals.md   maintainer design notes: command/rendering model + onboarding internals
docs/onboarding-improvement-plan.md  design notes for the onboarding flow
.github/workflows/preflight.yml  CI gate: shell/plugin syntax, JSON, secret-scan, no *bak*
```

## Onboarding internals

`login.sh` is the only fiddly part, because agy has **no `login`/`auth`
subcommand** — the Google OAuth is reachable only through the interactive TUI
(`agy -i`), which `login.sh` holds in tmux to read the auth URL and inject the code
you paste back. Resilience comes from seeding agy's onboarding config, a key-walk
fallback, an agy version gate, and a `tmux attach` escape hatch. Walk-through:
[`docs/plugin-internals.md`](docs/plugin-internals.md); design retrospective:
[`docs/onboarding-improvement-plan.md`](docs/onboarding-improvement-plan.md).

## Hardening

CI (`.github/workflows/preflight.yml`) gates every push: `bash -n` on all scripts
and `bin/agy-models`, `node --check plugin/index.js`, JSON-validates the plugin
manifests, runs `scripts/secret-scan.sh`, and rejects tracked `*bak*` files. No
credentials live in the repo — the AI Pro OAuth token stays in the service user's
home on each host. The `v1.1-hardened` tag is the recovery checkpoint: if a host is
lost, `git checkout v1.1-hardened && sudo RESTART_GATEWAY=1 scripts/install.sh`
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
