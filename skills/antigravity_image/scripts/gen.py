#!/usr/bin/env python3
"""antigravity_image skill: generate image(s) with Antigravity (agy -> Nano Banana 2).

For each requested variant this runs the official `agy` CLI with a generate_image
instruction, finds the freshly-produced image in agy's brain tree, and copies it into
the workspace outputs dir (an allowed outbound-media root) so the agent can attach it.
Prints one `IMAGE: <abs path>` line per produced image.

Attribution is by "an image path that did NOT exist before this agy call" (a per-attempt
snapshot of the brain tree, taken under a cross-process lock) — so a no-op variant can
never re-emit an earlier variant's image, and concurrent skill runs cannot claim each
other's output. On a no-image outcome the agy output (and, as a fallback, the run's
brain transcript) is classified so real Google-side 503/429 conditions stop retrying
immediately instead of burning quota. Logic mirrors the /antigravity plugin's image
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
from contextlib import contextmanager
from pathlib import Path
from shutil import which

try:
    import fcntl  # POSIX advisory locks; absent on non-POSIX (lock degrades to no-op)
except ImportError:
    fcntl = None

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
LOCK_FILE = GEMINI_DIR / "antigravity-image-skill.lock"
WORKSPACE_DIR = Path(os.environ.get("OPENCLAW_WORKSPACE_DIR",
                                    HOME / ".openclaw" / "workspace"))
# Own subdir (not the plugin's outputs/antigravity-images) so the plugin's prune can
# never reap a skill image the agent hasn't attached yet. Still under the workspace
# outputs root, so it is an allowed outbound-media path.
OUT_DIR = WORKSPACE_DIR / "outputs" / "antigravity-skill-images"
# Match the plugin's ANTIGRAVITY_IMAGE_KEEP default (20) so the two output dirs retain
# the same amount; override with the same env var.
OUT_KEEP = max(1, int(os.environ.get("ANTIGRAVITY_IMAGE_KEEP", "") or 20))
IMAGE_EXTS = {".png", ".jpg", ".jpeg", ".webp", ".gif"}
# Keep in sync with plugin/index.js ASPECT_RATIOS and antigravity_image/SKILL.md.
ASPECT_RATIOS = ["1:1", "2:3", "3:2", "3:4", "4:3", "9:16", "16:9"]
MAX_COUNT = 10
# Deeper than the plugin's newestBrainImage (<=3) — only affects how far we look; the
# per-run pre-snapshot bounds cost since we stat only paths new to the run.
MAX_SCAN_DEPTH = 6
AGY_CANDIDATES = ["/usr/local/bin/agy", str(HOME / ".local" / "bin" / "agy")]


# ---- shared agy helpers (KEEP IN SYNC with antigravity_ask/scripts/ask.py) ----
# Intentionally duplicated rather than shared: install.sh deploys each skill dir
# independently, so a shared module would need extra deployment machinery. Keep these
# byte-identical with ask.py so a fix lands in both.

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


# ---- agy failure classification (KEEP IN SYNC with ask.py and plugin/index.js
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


def detect_brain_error(min_mtime):
    """Scan this run's brain transcripts for a 429/503 agy swallowed with empty output.

    Mirrors plugin/index.js detectBrainError: only transcript.jsonl files modified after
    the run start, tail-limited. Returns {'quota','capacity'} or None."""
    found = {"quota": False, "capacity": False}
    if not BRAIN_DIR.exists():
        return None
    for root, dirs, files in os.walk(BRAIN_DIR):
        if ".git" in dirs:
            dirs.remove(".git")
        depth = len(Path(root).relative_to(BRAIN_DIR).parts)
        if depth >= MAX_SCAN_DEPTH:
            dirs[:] = []
        if "transcript.jsonl" not in files:
            continue
        fp = Path(root) / "transcript.jsonl"
        try:
            if fp.stat().st_mtime < min_mtime:
                continue
            text = fp.read_text(encoding="utf-8", errors="replace")
        except OSError:
            continue
        tail = text[-65536:]
        if re.search(r"RESOURCE_EXHAUSTED|\b429\b", tail, re.I):
            found["quota"] = True
        if re.search(r"MODEL_CAPACITY_EXHAUSTED|\b503\b", tail, re.I):
            found["capacity"] = True
    return found if (found["quota"] or found["capacity"]) else None


# ---- image helpers ----

def _as_text(b):
    """Decode subprocess output that may be bytes (TimeoutExpired) or str/None."""
    if isinstance(b, (bytes, bytearray)):
        return b.decode("utf-8", "replace")
    return b or ""


def sanitize_subject(s):
    # Strip leading markdown noise so a stray '*'/'_'/'#' can't make the model return
    # an empty response without calling the tool (see the plugin's sanitizeImageSubject).
    stripped = re.sub(r"^[\s>#*_~`-]+", "", s).strip()
    return stripped or s.strip()


def list_brain_image_paths():
    """Set of image file paths under the brain tree (no stat — cheap pre-snapshot)."""
    paths = set()
    if not BRAIN_DIR.exists():
        return paths
    for root, dirs, files in os.walk(BRAIN_DIR):
        depth = len(Path(root).relative_to(BRAIN_DIR).parts)
        if depth >= MAX_SCAN_DEPTH:
            dirs[:] = []
        for fn in files:
            if Path(fn).suffix.lower() in IMAGE_EXTS:
                paths.add(str(Path(root) / fn))
    return paths


def newest_image_excluding(pre_paths):
    """Newest (by mtime) brain image whose path is NOT in pre_paths. Stats only the
    handful of new paths, never the whole (pre-existing) tree."""
    newest = None
    newest_m = -1.0
    if not BRAIN_DIR.exists():
        return None
    for root, dirs, files in os.walk(BRAIN_DIR):
        depth = len(Path(root).relative_to(BRAIN_DIR).parts)
        if depth >= MAX_SCAN_DEPTH:
            dirs[:] = []
        for fn in files:
            if Path(fn).suffix.lower() not in IMAGE_EXTS:
                continue
            sp = str(Path(root) / fn)
            if sp in pre_paths:
                continue
            try:
                m = os.stat(sp).st_mtime
            except OSError:
                continue
            if m > newest_m:
                newest_m = m
                newest = sp
    return newest


def looks_complete(path):
    """Lenient truncation check (used only on the timeout path, where a killed agy could
    leave a half-written file). Accepts unknown types; only rejects an obviously
    incomplete JPEG/PNG."""
    p = Path(path)
    try:
        with open(p, "rb") as fh:
            head = fh.read(12)
            fh.seek(0, os.SEEK_END)
            size = fh.tell()
            if size < 16:
                return False
            fh.seek(-16, os.SEEK_END)
            tail = fh.read(16)
    except OSError:
        return False
    ext = p.suffix.lower()
    if ext in (".jpg", ".jpeg") or head[:2] == b"\xff\xd8":
        return tail.rstrip(b"\x00").endswith(b"\xff\xd9")
    if ext == ".png" or head[:8] == b"\x89PNG\r\n\x1a\n":
        return b"IEND" in tail
    return True  # webp/gif/unknown — don't block delivery


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
    # the brain image into workspace/outputs and return THAT path. May raise OSError,
    # which the caller treats as fatal (a broken outputs dir affects every variant).
    OUT_DIR.mkdir(parents=True, exist_ok=True)
    src_path = Path(src)
    safe = re.sub(r"[^A-Za-z0-9._-]", "_", src_path.name)
    uniq = f"{int(time.time() * 1000)}-{os.urandom(3).hex()}"
    target = OUT_DIR / f"{uniq}-{safe}"
    shutil.copyfile(src_path, target)
    prune(OUT_DIR, OUT_KEEP)  # best-effort; must not fail the publish
    return target


@contextmanager
def image_lock():
    """Cross-process advisory lock so two concurrent skill runs can't race the shared
    brain tree (each holds it around snapshot+run+scan+publish). Auto-released if the
    holder dies. Degrades to a no-op where fcntl is unavailable."""
    if fcntl is None:
        yield
        return
    try:
        GEMINI_DIR.mkdir(parents=True, exist_ok=True)
        fh = open(LOCK_FILE, "w")
    except OSError:
        yield  # can't create the lock file — proceed unlocked rather than fail
        return
    try:
        fcntl.flock(fh, fcntl.LOCK_EX)
        yield
    finally:
        try:
            fcntl.flock(fh, fcntl.LOCK_UN)
        except Exception:
            pass
        fh.close()


class FatalError(Exception):
    """A condition that dooms every remaining variant (e.g. unwritable outputs dir)."""


def generate_one(agy, model, aspect, subject, timeout, env):
    """Produce one image. Returns (kind, payload):
    ('ok', Path) | ('flaky', None) | ('capacity', None) | ('quota', reset|None) | ('timeout', None).
    Raises FatalError on an unwritable outputs dir."""
    # The plugin can't pass tool args to agy, so the ratio rides as a prompt
    # instruction; the reasoning model copies it into generate_image's AspectRatio.
    aspect_clause = (f' Set the AspectRatio parameter of generate_image to "{aspect}".'
                     if aspect else "")
    prompt = (f"Use your generate_image tool to create an image: {subject}."
              f"{aspect_clause} Save it as an artifact.")
    # Keep agy's own print-timeout ~30s below our hard kill (mirrors the plugin's
    # 3m/210s pairing) so the two limits track instead of fighting.
    print_timeout = max(30, timeout - 30)
    cmd = [agy]
    if model:
        cmd += ["--model", model]
    cmd += ["--print-timeout", f"{print_timeout}s", "-p", prompt]

    # The reasoning model is flaky at actually invoking generate_image (~1/3 of clean
    # prompts return no image). That failure comes back fast and spends no capacity, so
    # retry — but stop immediately on a real 503/429 (checked below), never 3x on it.
    for attempt in range(1, 4):
        with image_lock():
            pre = list_brain_image_paths()
            brain_since = time.time() - 2.0  # small clock-granularity margin
            timed_out = False
            try:
                r = subprocess.run(cmd, stdin=subprocess.DEVNULL, capture_output=True,
                                   encoding="utf-8", errors="replace", timeout=timeout, env=env)
                out = f"{r.stdout or ''}\n{r.stderr or ''}"
            except subprocess.TimeoutExpired as e:
                timed_out = True
                # On timeout the exception carries RAW bytes (it is raised before the
                # encoding= decode step), so decode before classifying.
                out = f"{_as_text(e.stdout)}\n{_as_text(e.stderr)}"
                print(f"  attempt {attempt}: agy timed out", file=sys.stderr)
            except OSError as e:
                print(f"  could not run agy: {e}", file=sys.stderr)
                return ("flaky", None)  # can't run agy — don't spin

            img = newest_image_excluding(pre)
            # On a timeout, a killed agy could leave a half-written file — don't ship it.
            if img and not (timed_out and not looks_complete(img)):
                try:
                    target = publish(img)
                except OSError as e:
                    raise FatalError(f"generated an image but could not write it to {OUT_DIR}: {e}")
                return ("ok", target)

            # No usable image this attempt — classify (capacity FIRST, mirroring the plugin).
            if detect_capacity_error(out):
                return ("capacity", None)
            q = detect_quota_error(out)
            if q is not None:
                return ("quota", q.get("reset"))
            if timed_out:
                return ("timeout", None)
            be = detect_brain_error(brain_since)
            if be and be.get("quota"):
                return ("quota", None)
            if be and be.get("capacity"):
                return ("capacity", None)
        # Model just didn't call the tool — retry (lock released between attempts).
        print(f"  attempt {attempt}: no image produced, retrying", file=sys.stderr)
    return ("flaky", None)


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
                    help="hard seconds per image; agy's own limit tracks ~30s below it "
                         "(default 210)")
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

    produced = 0
    stop = None  # (kind, payload) that halted the batch on a systemic condition
    for i in range(count):
        if count > 1:
            print(f"variant {i + 1}/{count} ...", file=sys.stderr)
        try:
            kind, payload = generate_one(agy, model, aspect, subject, args.timeout, env)
        except FatalError as e:
            print(f"error: {e}", file=sys.stderr)
            return 3
        if kind == "ok":
            produced += 1
            print(f"IMAGE: {payload}")
            sys.stdout.flush()
        elif kind == "flaky":
            print(f"  variant {i + 1}: no image after retries (model did not call "
                  "generate_image)", file=sys.stderr)
            continue
        else:
            stop = (kind, payload)  # capacity/quota/timeout — pointless to keep spending
            break

    if stop:
        kind, payload = stop
        if kind == "capacity":
            print("error: Google image model temporarily overloaded (503, "
                  "MODEL_CAPACITY_EXHAUSTED) — Google-side, not your quota. Retry in a "
                  "minute or two.", file=sys.stderr)
        elif kind == "quota":
            print(f"error: Google image quota exhausted (429 RESOURCE_EXHAUSTED)."
                  f"{quota_reset_suffix(payload)} Image quota is separate from text "
                  "models; try again later.", file=sys.stderr)
        elif kind == "timeout":
            print("error: image generation exceeded the timeout; try again or simplify "
                  "the prompt.", file=sys.stderr)
        if produced:
            print(f"note: delivered {produced} image(s) before stopping.", file=sys.stderr)
            return 4
        return 5

    if produced == 0:
        print("error: no images were produced (agy's model did not call generate_image). "
              "Retry.", file=sys.stderr)
        return 1
    print(f"done: {produced}/{count} image(s) saved under {OUT_DIR}", file=sys.stderr)
    return 0 if produced == count else 4


if __name__ == "__main__":
    sys.exit(main())
