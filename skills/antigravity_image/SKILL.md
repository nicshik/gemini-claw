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
- `--reference PATH` — reference image for image-to-image / edits: the result is based
  on that file (object shape, colours, label text carry over). Repeatable. Use it when
  Nick attaches a photo and asks to edit it or build around it (поменять фон, добавить
  элемент, обложка для маркетплейса с этим товаром). The path must be a real local file
  from the current task (an inbound attachment or a task-dir file) — never invent one.
- `--dry-run` — verify agy/env without spending quota.

Example — Nick's "5 variants" request:

```bash
~/.openclaw/workspace/bin/antigravity-image -n 5 --aspect 16:9 "фотореализм, зарянка и пума идут гулять в парк, естественный дневной свет, без текста и водяных знаков"
```

Example — edit an attached product photo:

```bash
~/.openclaw/workspace/bin/antigravity-image --aspect 3:4 --reference /path/to/inbound-photo.jpg "обложка карточки маркетплейса: этот же товар, чистый белый фон, мягкая тень"
```

## Delivering the result to the user

The wrapper prints one line per produced image:

```
IMAGE: /var/lib/openclaw/.openclaw/workspace/outputs/antigravity-skill-images/<file>.jpg
```

For EACH `IMAGE:` line, send that file to the user as a photo/attachment. The files live
under the workspace `outputs/` root (an allowed outbound-media root), so they can be
attached directly. Also tell the user how many of the requested variants succeeded.

**A result is ONLY a fresh `IMAGE:` line from the current run.** Send exactly the files
this invocation printed as `IMAGE:` lines, and nothing else:

- If the run printed no `IMAGE:` line (or exited non-zero), the generation did **not**
  happen. Say so plainly ("не выполнено, нового изображения нет"), give the reason the
  wrapper reported (quota 429 / overload 503 / the model never called the generator), and
  attach nothing. Do not soften a failure into a success.
- Never re-send an image from an earlier request, from chat history, or from an inbound
  attachment as if it were a new result or a reference — the wrapper already guarantees
  every `IMAGE:` path did not exist before this run, so if there is no such line there is
  no new image to send.
- Match the count and aspect the user asked for **this time**. Don't carry over a previous
  request's parameters (e.g. answering "5 variants" when the user now asked for 2).
- Before delivering, confirm the file actually came from this run — the wrapper's fresh-path
  attribution does this for you, so trust the `IMAGE:` lines and do not substitute anything.

## Timing & reliability

- ~60-90 seconds per image; `-n 5` runs serially ≈ 5-8 minutes. Tell the user it's
  generating; don't silently block.
- agy's reasoning model is occasionally flaky and returns no image (~1/3 of runs); the
  wrapper auto-retries each variant up to 3 times. If a variant still fails, the wrapper
  reports fewer images than requested — offer to re-run the missing ones.
- If Google is overloaded (503) or the image quota is exhausted (429), the wrapper
  produces no image and exits non-zero; relay that it's a Google-side condition, not a
  bug. Image quota is separate from text models.

## Quota & limits — do not invent numbers

If the user asks how many images are left, how many were used, or what the exact daily
limit is, do NOT fabricate a figure or present a mechanism as fact. State only what is
actually known:

- Image quota is separate from and metered independently of the text models.
- Google does not publish the exact bucket size or reset window for this route, and there
  is no live counter / "fuel gauge" to read.
- The only authoritative signal is agy's own `429 RESOURCE_EXHAUSTED`, which sometimes
  carries a reset window ("resets in ~N"). Relay exactly that and nothing more.

Do NOT claim a specific number (e.g. "100/day"), and do NOT explain it as a "developer API
vs web app" split or backend-specific throttling — auth is Nick's Google AI Pro
subscription over OAuth, not a separate API key. If asked how many were generated today,
there is no quota gauge to answer that; past attempts live only in the local brain
transcripts, which is not a limit readout. See the repo README "Image quota" section for
the sourced details.

## Notes

- No secrets: agy authenticates via Google OAuth (run the host's `scripts/login.sh` once).
- This skill does NOT touch the `/antigravity` control-panel plugin; it's an additive,
  agent-facing route to the same `agy` binary.
