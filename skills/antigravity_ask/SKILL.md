---
name: antigravity_ask
description: Ask Antigravity (the official `agy` CLI, Google Gemini on Nick's Google AI Pro quota) a text question and return its answer. USE ONLY WHEN NICK EXPLICITLY asks to route a question through Antigravity / agy / Gemini, or invokes /skill antigravity_ask. This is an explicit, opt-in alternative to answering directly or with other tools — do not pick it implicitly.
metadata:
  category: llm-routing
  distribution_scope: internal
  invocation_strategy: explicit
  runtimes:
    - codex
    - openclaw
  source_of_truth: github:nicshik/gemini-claw
---

# Antigravity Ask (agy / Gemini)

Send a text prompt to the official Antigravity CLI (`agy`) and return Gemini's answer,
on Nick's **Google AI Pro** quota. This is an explicit, opt-in route — use it only when
Nick asks to send a question specifically through Antigravity / agy / Gemini
(e.g. "спроси через agy", "через Gemini", `/skill antigravity_ask <вопрос>`). For
ordinary questions, answer normally; do not silently divert to this skill.

## How to run

```bash
~/.openclaw/workspace/bin/antigravity-ask [--model NAME] "<question>"
```

- `--model NAME` — agy model (default: the pult's `default_model` from
  `~/.gemini/antigravity-skill.json`). Human model names come from `agy models`.
- `--dry-run` — verify agy/env without spending quota.

The wrapper prints agy's answer to stdout; relay it to the user. If Google is
overloaded (503) or the quota is exhausted (429), the wrapper exits non-zero with a
short reason on stderr — pass that along rather than treating it as a bug.

## Notes

- No secrets: agy authenticates via Google OAuth (run the host's `scripts/login.sh` once).
- Slow == agy's own latency, no extra LLM on top. Answers take a few seconds to tens of
  seconds.
- Additive to the `/antigravity` control-panel plugin; this skill does not modify it.
