#!/usr/bin/env python3
"""antigravity_ask skill: ask Antigravity (agy) a text question, return its answer.

Runs the official `agy` CLI (Google Gemini via Antigravity) as the OpenClaw service
user and prints Gemini's answer to stdout. Explicit-invocation only (see
agents/openai.yaml). No secrets: agy authenticates via Google OAuth.
"""
import argparse
import json
import os
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


def resolve_agy():
    for c in AGY_CANDIDATES:
        if os.access(c, os.X_OK):  # exists AND is executable
            return c
    return which("agy")


def default_model():
    try:
        data = json.loads(STATE_FILE.read_text())
    except Exception:
        return None
    m = data.get("default_model")
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
    err = (r.stderr or "").strip() or out or f"agy exited {r.returncode} with no output"
    print(f"error: agy failed: {err[:500]}", file=sys.stderr)
    return 1


if __name__ == "__main__":
    sys.exit(main())
