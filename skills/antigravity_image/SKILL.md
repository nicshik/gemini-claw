---
name: antigravity_image
description: Generate raster images with Antigravity (the official `agy` CLI, Google's Nano Banana 2 model) on Nick's Google AI Pro quota. USE ONLY WHEN NICK EXPLICITLY ASKS for Antigravity / agy / Gemini / Nano Banana image generation, or invokes /skill antigravity_image. For ordinary image requests use the built-in imagegen skill instead — this is an explicit, opt-in alternative that routes generation through agy rather than the built-in OpenAI image tool. Do not pick it implicitly.
metadata:
  category: media-generation
  distribution_scope: internal
  invocation_strategy: explicit
  runtimes:
    - codex
    - openclaw
  source_of_truth: github:nicshik/gemini-claw
---

# Antigravity Image (agy / Nano Banana 2)

Generate one or more images through the official Antigravity CLI (`agy`), which drives
Google's **Nano Banana 2** image model on Nick's **Google AI Pro** quota. This is a
deliberate, explicit alternative to the built-in `imagegen` skill (which uses the OpenAI
image tool). It exists so Nick can say "сделай N вариантов через antigravity_image" and
get images produced by agy, not by OpenAI.

## When to use (explicit only)

Use this skill ONLY when Nick explicitly asks for it, e.g.:

- "через antigravity_image ...", "через agy", "через Gemini / Nano Banana";
- `/skill antigravity_image <описание>`;
- he directly asks for image generation specifically via Antigravity / agy.

For any other image request, prefer the default `imagegen` skill. Do NOT silently pick
this skill over `imagegen`.

## How to run

```bash
~/.openclaw/workspace/bin/antigravity-image [-n COUNT] [--aspect RATIO] [--model NAME] "<image description>"
```

- `-n, --count COUNT` — number of variants, 1..10. Each variant is a separate agy run.
- `--aspect RATIO` — one of `1:1 2:3 3:2 3:4 4:3 9:16 16:9`. Default: the pult's current
  aspect (`~/.gemini/antigravity-skill.json` -> `image_aspect`).
- `--model NAME` — agy reasoning model (default: the pult's `default_model`). The image
  itself is always Nano Banana 2 (fixed by agy); this only picks the reasoning model.
- `--dry-run` — verify agy/env without spending quota.

Example — Nick's "5 variants" request:

```bash
~/.openclaw/workspace/bin/antigravity-image -n 5 --aspect 16:9 "фотореализм, зарянка и пума идут гулять в парк, естественный дневной свет, без текста и водяных знаков"
```

## Delivering the result to the user

The wrapper prints one line per produced image:

```
IMAGE: /var/lib/openclaw/.openclaw/workspace/outputs/antigravity-skill-images/<file>.jpg
```

For EACH `IMAGE:` line, send that file to the user as a photo/attachment. The files live
under the workspace `outputs/` root (an allowed outbound-media root), so they can be
attached directly. Also tell the user how many of the requested variants succeeded.

## Timing & reliability

- ~60-90 seconds per image; `-n 5` runs serially ≈ 5-8 minutes. Tell the user it's
  generating; don't silently block.
- agy's reasoning model is occasionally flaky and returns no image (~1/3 of runs); the
  wrapper auto-retries each variant up to 3 times. If a variant still fails, the wrapper
  reports fewer images than requested — offer to re-run the missing ones.
- If Google is overloaded (503) or the image quota is exhausted (429), the wrapper
  produces no image and exits non-zero; relay that it's a Google-side condition, not a
  bug. Image quota is separate from text models.

## Notes

- No secrets: agy authenticates via Google OAuth (run the host's `scripts/login.sh` once).
- This skill does NOT touch the `/antigravity` control-panel plugin; it's an additive,
  agent-facing route to the same `agy` binary.
