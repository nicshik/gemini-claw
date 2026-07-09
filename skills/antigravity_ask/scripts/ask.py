#!/usr/bin/env python3
"""antigravity_ask skill: ask Antigravity (agy) a text question, return its answer.

Runs the official `agy` CLI (Google Gemini via Antigravity) as the OpenClaw service
user and prints Gemini's answer to stdout. On failure it classifies Google-side 503
(overloaded) and 429 (quota exhausted) into a short reason so the agent can tell the
user whether to retry soon or wait. Explicit-invocation only. No secrets: agy uses OAuth.
"""
import argparse
import json
import os
import re
import subprocess
import sys
from pathlib import Path
from shutil import which

# Deterministic UTF-8 I/O regardless of the service's locale (Russian prompts/answers).
for _s in (sys.stdout, sys.stderr):
    try:
        _s.reconfigure(encoding="utf-8", errors="replace")
    except Exception:
        pass

HOME = Path(os.environ.get("HOME", "/var/lib/openclaw"))
STATE_FILE = HOME / ".gemini" / "antigravity-skill.json"
# Match the plugin's resolution order (symlink first, then the service user's install).
AGY_CANDIDATES = ["/usr/local/bin/agy", str(HOME / ".local" / "bin" / "agy")]


# ---- shared agy helpers (KEEP IN SYNC with antigravity_image/scripts/gen.py) ----
# Intentionally duplicated rather than shared: install.sh deploys each skill dir
# independently, so a shared module would need extra deployment machinery. Keep these
# byte-identical with gen.py so a fix lands in both.

def resolve_agy():
    for c in AGY_CANDIDATES:
        if os.access(c, os.X_OK):  # exists AND is executable
            return c
    return which("agy")


def read_state():
    try:
        return json.loads(STATE_FILE.read_text())
    except Exception:
        return {}


# ---- agy failure classification (KEEP IN SYNC with gen.py and plugin/index.js
#      detectCapacityError / detectQuotaError / quotaResetSuffix) ----

def detect_capacity_error(text):
    """Transient Google-side 503 / overloaded (NOT the user's quota). Check FIRST."""
    if not text:
        return False
    return bool(
        re.search(r"model[\s_-]*capacity[\s_-]*exhausted", text, re.I)
        or re.search(r"\b503\b", text)
        or re.search(r"service[\s_-]*unavailable", text, re.I)
        or re.search(r"(out of|over[\s-]?)\s*capacity", text, re.I)
        or re.search(r"\boverloaded\b|temporarily unavailable", text, re.I)
        or re.search(r"(перегруж\w*|временно недоступ\w*)", text, re.I)
    )


def detect_quota_error(text, strict=False):
    """Google 429 RESOURCE_EXHAUSTED (per-account quota). Returns {'reset': str|None} or None."""
    if not text:
        return None
    structured = bool(re.search(r"resource[\s_-]*exhausted", text, re.I) or re.search(r"\b429\b", text))
    adjacency = bool(
        re.search(r"(quota|limit|capacity)[^.\n]{0,30}(exhaust|exceed|reach|unavailable|unable)", text, re.I)
        or re.search(r"(exhaust|exceed|reach|unavailable|unable)[^.\n]{0,30}(quota|limit|capacity)", text, re.I)
        or re.search(r"(квот\w*|лимит\w*)[^.\n]{0,30}(исчерпан|превыш|восстанов|недоступ)", text, re.I)
        or re.search(r"(исчерпан|превыш|недоступ)[^.\n]{0,30}(квот\w*|лимит\w*)", text, re.I)
    )
    broad = bool(
        (re.search(r"\b(quota|rate[\s_-]?limit|usage limit|capacity)\b", text, re.I) or re.search(r"(квот|лимит)", text, re.I))
        and (re.search(r"\b(exhaust\w*|reset\w*|exceed\w*|unavailable|unable)\b", text, re.I)
             or re.search(r"(исчерпан|восстанов|обнов|сброс|превыш|недоступ)", text, re.I))
    )
    if not (structured or adjacency or (not strict and broad)):
        return None
    reset = None
    m = (re.search(r"reset[^.]*?\bin\b\s*(?:approximately\s+|about\s+)?([^.\n)]{1,50})", text, re.I)
         or re.search(r"через\s*(?:~|примерно\s+|около\s+)?([^.\n)]{1,50})", text, re.I))
    if m:
        raw = m.group(1)
        h = re.search(r"(\d+)\s*(?:hours?|hrs?|\bh\b|час\w*|\bч\b)", raw, re.I)
        mi = re.search(r"(\d+)\s*(?:minutes?|mins?|\bm\b|минут\w*|\bмин\b)", raw, re.I)
        parts = []
        if h:
            parts.append(f"{h.group(1)} ч")
        if mi:
            parts.append(f"{mi.group(1)} мин")
        if parts:
            reset = " ".join(parts)
        elif re.search(r"few\s+hours?|несколько\s+час", raw, re.I):
            reset = "несколько часов"
        elif re.search(r"hour|час", raw, re.I):
            reset = "около часа"
    return {"reset": reset}


def quota_reset_suffix(reset):
    return f" Сброс примерно через {reset}." if reset else ""


def default_model():
    st = read_state()
    m = st.get("default_model")
    return m if isinstance(m, str) and m.strip() else None


def main():
    ap = argparse.ArgumentParser(description="Ask Antigravity (agy / Gemini) a question.")
    ap.add_argument("--model", default=None,
                    help="agy model name (default: the pult's default_model)")
    ap.add_argument("--timeout", type=int, default=120, help="seconds (default 120)")
    ap.add_argument("--dry-run", action="store_true",
                    help="check agy/env only; make no API call, spend no quota")
    ap.add_argument("prompt", nargs="+", help="the question")
    args = ap.parse_args()

    agy = resolve_agy()
    prompt = " ".join(args.prompt).strip()
    model = args.model or default_model()

    if args.dry_run:
        print(f"dry-run: agy={agy or 'NOT FOUND'} model={model or '(agy default)'} "
              f"prompt_len={len(prompt)}")
        return 0 if (agy and prompt) else 2
    if not agy:
        print("error: agy CLI not found or not executable (looked in /usr/local/bin/agy, "
              "~/.local/bin/agy, PATH)", file=sys.stderr)
        return 2
    if not prompt:
        print("error: empty prompt", file=sys.stderr)
        return 2

    cmd = [agy]
    if model:
        cmd += ["--model", model]
    cmd += ["-p", prompt]
    env = dict(os.environ)
    env["HOME"] = str(HOME)  # agy reads its OAuth creds from $HOME/.gemini
    try:
        r = subprocess.run(cmd, stdin=subprocess.DEVNULL, capture_output=True,
                           encoding="utf-8", errors="replace", timeout=args.timeout,
                           env=env)
    except subprocess.TimeoutExpired:
        print("error: agy timed out — try a shorter prompt or again later.",
              file=sys.stderr)
        return 3
    except OSError as e:
        print(f"error: could not run agy: {e}", file=sys.stderr)
        return 2

    out = (r.stdout or "").strip()
    if r.returncode == 0 and out:
        print(out)
        return 0

    # Failure: classify Google-side conditions the way the plugin's doAsk does. Use
    # strict quota matching so a genuine Q&A about "limits/quota" isn't mislabelled.
    combined = f"{r.stdout or ''}\n{r.stderr or ''}"
    if detect_capacity_error(combined):
        print("error: Google model temporarily overloaded (503) — Google-side, not your "
              "quota. Retry in a minute or two.", file=sys.stderr)
        return 5
    q = detect_quota_error(combined, strict=True)
    if q is not None:
        print(f"error: Google quota exhausted (429 RESOURCE_EXHAUSTED).{quota_reset_suffix(q.get('reset'))} "
              "Try later or switch the model in /antigravity model.", file=sys.stderr)
        return 5

    err = (r.stderr or "").strip() or out or f"agy exited {r.returncode} with no output"
    print(f"error: agy failed: {err[:500]}", file=sys.stderr)
    return 1


if __name__ == "__main__":
    sys.exit(main())
