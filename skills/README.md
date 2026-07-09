# Agent skills (agy for the LLM agent)

These are OpenClaw **workspace skills** that give the LLM agent an explicit route to the
Antigravity CLI (`agy`) — complementing the `/antigravity` control-panel plugin, which
deliberately bypasses the agent. The plugin stays the fast, user-facing pult; these
skills are an additive, agent-facing tool surface.

| Skill | What it does | Wrapper |
|-------|--------------|---------|
| `antigravity_ask` | Ask agy (Gemini) a text question, return the answer | `bin/antigravity-ask` |
| `antigravity_image` | Generate image(s) via agy → Nano Banana 2, print `IMAGE:` paths | `bin/antigravity-image` |

## Routing: explicit only

Both skills are **explicit-invocation only** — `metadata.invocation_strategy: explicit`
in `SKILL.md` plus `policy.allow_implicit_invocation: false` in `agents/openai.yaml`. The
agent uses them only when Nick explicitly asks (e.g. "через antigravity_image", "через
agy/Gemini", or `/skill antigravity_image …`). For ordinary image requests the agent
keeps using the built-in `imagegen` (OpenAI) skill.

## Layout

```
skills/
  bin/
    antigravity-ask        # thin wrapper -> antigravity_ask/scripts/ask.py
    antigravity-image      # thin wrapper -> antigravity_image/scripts/gen.py
  antigravity_ask/
    SKILL.md
    agents/openai.yaml
    scripts/ask.py
  antigravity_image/
    SKILL.md
    agents/openai.yaml
    scripts/gen.py
```

## Install / update

`scripts/install.sh` deploys these into the service user's OpenClaw workspace
(`~/.openclaw/workspace/skills/` + `~/.openclaw/workspace/bin/`) alongside the plugin, and
restarts the gateway when run with `RESTART_GATEWAY=1`. Each skill's behavior (usage,
image attribution, retry/error handling, output location) is documented in its own
`SKILL.md` and script — this README is just the index; SKILL.md is the source of truth.
The image path mirrors the `/antigravity` plugin's proven pipeline.

No secrets: agy authenticates via Google OAuth (`scripts/login.sh`).

## Governance note

The OpenClaw hygiene audit (`nicshik/openclaw` → `scripts/audit-openclaw-hygiene.sh`)
tracks the expected model-visible skill set, and `docs/openclaw-skills-policy.md` still
says "Antigravity is no longer a skill". Adding these two skills means updating that
expected set + policy doc in the `openclaw` repo (separate change).
