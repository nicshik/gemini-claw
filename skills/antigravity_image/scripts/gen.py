#!/usr/bin/env python3
"""antigravity_image skill: generate image(s) with Antigravity (agy -> Nano Banana 2).

For each requested variant this runs the official `agy` CLI with a generate_image
instruction, finds the freshly-produced image in agy's brain tree, and copies it into
the workspace outputs dir (an allowed outbound-media root) so the agent can attach it.
Prints one `IMAGE: <abs path>` line per produced image.

Attribution is by "an image path that did NOT exist before this agy call" (a per-attempt
snapshot of the brain tree) plus a run-wide set of already-published sources — so a
no-op variant can never re-publish an earlier variant's image, and each source file is
delivered at most once. Logic otherwise mirrors the /antigravity plugin's proven image
path. Explicit-invocation only. No secrets: agy uses Google OAuth.
"""
import argparse
import json
import os
import re
import shutil
import subprocess
import sys
import time
from pathlib import Path

# Deterministic UTF-8 I/O regardless of the service's locale (Russian prompts/answers).
for _s in (sys.stdout, sys.stderr):
    try:
        _s.reconfigure(encoding="utf-8", errors="replace")
    except Exception:
        pass

HOME = Path(os.environ.get("HOME", "/var/lib/openclaw"))
GEMINI_DIR = HOME / ".gemini"
BRAIN_DIR = GEMINI_DIR / "antigravity-cli" / "brain"
STATE_FILE = GEMINI_DIR / "antigravity-skill.json"
WORKSPACE_DIR = Path(os.environ.get("OPENCLAW_WORKSPACE_DIR",
                                    HOME / ".openclaw" / "workspace"))
# Own subdir (not the plugin's outputs/antigravity-images) so the plugin's prune can
# never reap a skill image the agent hasn't attached yet. Still under the workspace
# outputs root, so it is an allowed outbound-media path.
OUT_DIR = WORKSPACE_DIR / "outputs" / "antigravity-skill-images"
OUT_KEEP = 40
IMAGE_EXTS = {".png", ".jpg", ".jpeg", ".webp", ".gif"}
ASPECT_RATIOS = ["1:1", "2:3", "3:2", "3:4", "4:3", "9:16", "16:9"]
MAX_COUNT = 10
MAX_SCAN_DEPTH = 6
AGY_CANDIDATES = ["/usr/local/bin/agy", str(HOME / ".local" / "bin" / "agy")]


def resolve_agy():
    for c in AGY_CANDIDATES:
        if os.access(c, os.X_OK):  # exists AND is executable
            return c
    return shutil.which("agy")


def read_state():
    try:
        return json.loads(STATE_FILE.read_text())
    except Exception:
        return {}


def sanitize_subject(s):
    # Strip leading markdown noise so a stray '*'/'_'/'#' can't make the model return
    # an empty response without calling the tool (see the plugin's sanitizeImageSubject).
    return re.sub(r"^[\s>#*_~`-]+", "", s).strip()


def list_brain_images():
    """All (path_str, mtime) image files under the brain tree, depth-bounded."""
    out = []
    if not BRAIN_DIR.exists():
        return out
    for root, dirs, files in os.walk(BRAIN_DIR):
        depth = len(Path(root).relative_to(BRAIN_DIR).parts)
        if depth >= MAX_SCAN_DEPTH:
            dirs[:] = []  # stop descending, still scan files at this level
        for fn in files:
            if Path(fn).suffix.lower() not in IMAGE_EXTS:
                continue
            fp = Path(root) / fn
            try:
                out.append((str(fp), fp.stat().st_mtime))
            except OSError:
                continue
    return out


def newest_new_image(pre_paths, published, min_mtime):
    """Newest brain image whose path is new this attempt and not already published."""
    newest = None
    newest_m = min_mtime
    for sp, m in list_brain_images():
        if sp in pre_paths or sp in published:
            continue
        if m > newest_m:
            newest_m = m
            newest = sp
    return newest


def prune(out_dir, keep):
    try:
        files = sorted((p for p in out_dir.iterdir() if p.is_file()),
                       key=lambda p: p.stat().st_mtime, reverse=True)
    except OSError:
        return
    for p in files[keep:]:
        try:
            p.unlink()
        except OSError:
            pass


def publish(src):
    # OpenClaw only sends outbound media from an allowed root (the workspace), so copy
    # the brain image into workspace/outputs and return THAT path.
    OUT_DIR.mkdir(parents=True, exist_ok=True)
    src_path = Path(src)
    safe = re.sub(r"[^A-Za-z0-9._-]", "_", src_path.name)
    uniq = f"{int(time.time() * 1000)}-{os.urandom(3).hex()}"
    target = OUT_DIR / f"{uniq}-{safe}"
    shutil.copyfile(src_path, target)  # may raise OSError; caller handles
    prune(OUT_DIR, OUT_KEEP)  # best-effort; must not fail the publish
    return target


def generate_one(agy, model, aspect, subject, timeout, env, published):
    # The plugin can't pass tool args to agy, so the ratio rides as a prompt
    # instruction; the reasoning model copies it into generate_image's AspectRatio.
    aspect_clause = (f' Set the AspectRatio parameter of generate_image to "{aspect}".'
                     if aspect else "")
    prompt = (f"Use your generate_image tool to create an image: {subject}."
              f"{aspect_clause} Save it as an artifact.")
    cmd = [agy]
    if model:
        cmd += ["--model", model]
    cmd += ["--print-timeout", "3m", "-p", prompt]
    # The reasoning model is flaky at actually invoking generate_image (~1/3 of clean
    # prompts return no image). That failure comes back fast and spends no capacity, so
    # retry a few times. Attribution: only an image that did NOT exist before this agy
    # call (and isn't already published) counts as this attempt's output.
    for attempt in range(1, 4):
        pre = {sp for sp, _ in list_brain_images()}
        start = time.time() - 2.0  # small clock-granularity margin
        try:
            subprocess.run(cmd, stdin=subprocess.DEVNULL, capture_output=True,
                           encoding="utf-8", errors="replace", timeout=timeout, env=env)
        except subprocess.TimeoutExpired:
            print(f"  attempt {attempt}: agy timed out", file=sys.stderr)
            # A slow-but-successful run may have written the image before hanging —
            # still check for a new image before giving up on this attempt.
        except OSError as e:
            print(f"  could not run agy: {e}", file=sys.stderr)
            return None  # agy not runnable — retrying won't help
        src = newest_new_image(pre, published, start)
        if src:
            published.add(src)
            try:
                return publish(src)
            except OSError as e:
                print(f"  attempt {attempt}: could not copy produced image: {e}",
                      file=sys.stderr)
                return None
        print(f"  attempt {attempt}: no image produced, retrying", file=sys.stderr)
    return None


def main():
    ap = argparse.ArgumentParser(
        description="Generate image(s) with Antigravity (agy / Nano Banana 2).")
    ap.add_argument("--aspect", default=None,
                    help=f"one of {ASPECT_RATIOS} (default: the pult's image_aspect)")
    ap.add_argument("--model", default=None,
                    help="agy reasoning model (default: the pult's default_model)")
    ap.add_argument("-n", "--count", type=int, default=1,
                    help=f"number of variants (1..{MAX_COUNT})")
    ap.add_argument("--timeout", type=int, default=210,
                    help="seconds per image (default 210)")
    ap.add_argument("--dry-run", action="store_true",
                    help="check agy/env only; make no API call, spend no quota")
    ap.add_argument("prompt", nargs="+", help="image description")
    args = ap.parse_args()

    agy = resolve_agy()
    st = read_state()

    aspect = args.aspect if args.aspect is not None else st.get("image_aspect")
    if aspect in ("", "auto", None):
        aspect = None
    if aspect and aspect not in ASPECT_RATIOS:
        print(f"error: invalid --aspect {aspect!r}; allowed: {ASPECT_RATIOS}",
              file=sys.stderr)
        return 2

    dm = st.get("default_model")
    model = args.model or (dm if isinstance(dm, str) and dm.strip() else None)
    count = max(1, min(MAX_COUNT, args.count))
    subject = sanitize_subject(" ".join(args.prompt))

    if args.dry_run:
        print(f"dry-run: agy={agy or 'NOT FOUND'} model={model or '(agy default)'} "
              f"aspect={aspect or 'auto'} count={count} out={OUT_DIR}")
        return 0 if (agy and subject) else 2
    if not agy:
        print("error: agy CLI not found or not executable (looked in /usr/local/bin/agy, "
              "~/.local/bin/agy, PATH)", file=sys.stderr)
        return 2
    if not subject:
        print("error: empty image description", file=sys.stderr)
        return 2

    env = dict(os.environ)
    env["HOME"] = str(HOME)  # agy reads its OAuth creds and brain tree from $HOME

    published = set()  # resolved brain source paths already delivered this run
    produced = []
    for i in range(count):
        if count > 1:
            print(f"variant {i + 1}/{count} ...", file=sys.stderr)
        target = generate_one(agy, model, aspect, subject, args.timeout, env, published)
        if target:
            produced.append(target)
            print(f"IMAGE: {target}")
            sys.stdout.flush()

    if not produced:
        print("error: no images were produced. Either agy's model did not call "
              "generate_image, or Google is overloaded (503) / the image quota is "
              "exhausted (429). This is a Google-side condition, not a bug — retry later.",
              file=sys.stderr)
        return 1
    print(f"done: {len(produced)}/{count} image(s) saved under {OUT_DIR}",
          file=sys.stderr)
    return 0 if len(produced) == count else 4


if __name__ == "__main__":
    sys.exit(main())
