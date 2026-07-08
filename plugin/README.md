# antigravity — OpenClaw control-panel plugin

Registers a native `/antigravity` command that renders an inline-button control
panel for the Antigravity CLI (`agy`).

Because it is an OpenClaw **plugin command**, `/antigravity` is dispatched *before
the LLM agent* — menu navigation, model switching, and status are drawn in code
in milliseconds, with no model call. That makes the panel instant and immune to a
slow or flaky agent backend. The only slow parts are the real `agy` calls
(`ask` / `image`), which are slow because `agy` itself is — no LLM overhead is
added on top.

## Panel

- `/antigravity` — main menu: **Модель · Статус** buttons, plus the two action
  commands printed in the body as tap-to-copy monospace (`/antigravity_ask` /
  `/antigravity_image`). They live in the body, not as buttons, because a button
  tap is answered as plain text (no markdown) — only the command-reply render can
  produce a copyable command. See the root README, "Command & rendering model".
- **Модель** → one button per model (from the cached `agy models` list); the
  current default is marked `•`. Tapping one sets it as the default for future
  `ask`/`image` calls.
- **Статус** → the current default model.
- `/antigravity_ask <вопрос>` → runs `agy [--model …] -p "<вопрос>"`, returns the answer.
  Single-token command; the subcommand form `/antigravity ask <вопрос>` also works.
- `/antigravity_image <описание>` → runs `agy … generate_image …`, returns the newest
  rendered image as a photo. Subcommand form `/antigravity image <описание>` also works.
- `/antigravity ping` → bounded auth probe (`agy -p "OK"`).
- `/antigravity reset` → clear the default model (fall back to agy's own default).

Navigation is **edit-in-place**: tapping a button rewrites the same message rather
than posting a new one. Buttons use `action.type: "callback"` (value `agy:<payload>`);
the companion `registerInteractiveHandler` receives the tap and calls
`respond.editMessage`. On the first render the framework encodes the callback; the
interactive handler re-encodes buttons in the same `tgcb1:` opaque form itself (a
small copy of the framework's checksum, verified byte-identical). Typed subcommands
(`/antigravity model <name>`, `/antigravity ask <q>`, …) still work as a fallback.

Inline buttons must be enabled for the channel:
`openclaw config set channels.telegram.capabilities.inlineButtons dm`.

## State

- **Default model** — `~/.gemini/antigravity-skill.json` (`{"default_model": "…"}`),
  in agy's config dir, outside the git-synced workspace. A plain JSON file, not
  `openKeyedStore` (which is gated to trusted/bundled plugins), so this installs
  as an ordinary plugin.
- **Model list** — read from `~/.gemini/antigravity-models.txt`, populated by the
  `agy-models` helper + a daily systemd timer (see the repo root). The plugin only
  reads the cache file, so the menu never blocks on a slow `agy`. If the cache is
  missing it falls back to a built-in bootstrap list.

## Layout

```
index.js               the plugin (ESM; imports openclaw/plugin-sdk/core)
openclaw.plugin.json   manifest (id, command alias, activation)
package.json           openclaw.extensions -> ./index.js (no build step)
```

Installed via `openclaw plugins install --force <dir>` into
`~/.openclaw/extensions/antigravity/` — under the service user's home, so it
survives `openclaw update`. Requires a gateway restart to load.
