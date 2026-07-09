# Plugin internals

Design notes for maintainers — the non-obvious mechanics behind the `antigravity`
plugin. Not needed to install or use it (see the [README](../README.md)); read this
before changing command rendering or the login flow.

## Command & rendering model

Read this before changing how commands or the panel text render. It is the result
of testing the real Telegram behavior, not guesswork.

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
send plain text. So **via `respond.*` a button tap can never render a
monospace/tap-to-copy command.** Only a real command reply can.

**Escape hatch (used by the image Recreate/Edit buttons): the channel outbound
adapter.** A plugin can send a NEW message — with markdown rendering and media —
from inside an interactive handler via
`api.runtime.channel.outbound.loadAdapter("telegram")` → `adapter.sendPayload({
cfg: api.runtime.config.current(), to: ctx.callback.chatId, accountId, threadId,
text, payload })`. `sendPayload` runs the full delivery pipeline: markdown→HTML,
photo upload from `mediaUrl`/`mediaUrls` (plural = separate sendPhoto messages,
caption and keyboard on the FIRST one only). The handler's *return value* is still
discarded beyond `.handled`, and `respond.*` stays text-only — the adapter is the
only media/markdown path from a tap. Photo captions render markdown too (backticks
→ tap-to-copy `code`), but only while the whole text fits Telegram's 1024-char
caption cap; longer text becomes a follow-up message and the buttons detach from
the photo.

**Buttons on a PHOTO must ride `channelData.telegram.buttons`, not
`presentation.blocks`.** On the media delivery path the framework's
`renderPresentation` ALSO flattens every presentation block into the caption text
(a `- label` markdown list Telegram renders as `• label`), so presentation-carried
buttons show up twice: as caption bullets AND as the inline keyboard (the
text-only path doesn't flatten, which is why the panel never showed this). Raw
`channelData.telegram.buttons` (`[[{ text, callback_data }]]`, callback_data in
the same opaque `tgcb1:` form via `opaqueCallbackData`) skips the flatten while
still becoming a real inline keyboard — taps route back to this plugin's
namespace handler exactly like the edit-in-place keyboard. Verified against the
OpenClaw 2026.6.11 dist (`outbound-adapter`/`deliver`/`button-types` modules).

**An attached photo never reaches a command handler.** `PluginCommandContext`
carries text/addressing only — no media. The only plugin-visible route to an
attached image is `api.registerHook("message:received", handler, { name })`
(INTERNAL hook system: the key is `type:action`, NOT the config-hook name
`message_received`; a missing `opts.name` fails the whole plugin registration).
The event's payload sits under `event.context`: `content` (text/caption),
`from`, and `metadata.mediaPath(s)` — OpenClaw has already downloaded the file
to `.openclaw/media/inbound/` by then. The emit happens in dispatch-from-config
BEFORE the command executes, and a photo-with-caption command takes exactly that
path (Telegram's native `bot.command` shortcut matches only `msg.text`, never
captions — which also means an image sent as a FILE/document with a command
caption does NOT dispatch the command at all; it falls through to the LLM
agent). The plugin records a sighting (sender + media paths) from the hook and
the command handler claims it (`awaitReferenceFor`, sender-matched, short TTL),
then stages the file for `agy` via `--add-dir` + an explicit
use-this-reference-file instruction in the prompt.

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

See [`onboarding-improvement-plan.md`](onboarding-improvement-plan.md).
