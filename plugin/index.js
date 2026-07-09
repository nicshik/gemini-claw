// Antigravity (agy) control-panel plugin for OpenClaw.
//
// Registers a native `/antigravity` command that renders an inline-button control
// panel. Because it is a *plugin command*, it is dispatched BEFORE the LLM agent
// (see OpenClaw's `registerCommand` docs: "Register a custom command that bypasses
// the LLM agent"). Navigation is instant and immune to the agent backend being
// slow or flaky — no model is invoked to draw a menu.
//
// Navigation buttons use `action.type: "callback"` and a companion
// `registerInteractiveHandler` rewrites the SAME message in place (edit-in-place),
// so tapping through the panel doesn't spam the chat with new messages. Typed
// subcommands (`/antigravity`, `/antigravity model <name>`, `/antigravity ask <q>`,
// ...) still work as a fallback and for text input.
//
// The only slow parts are the actual `agy` calls (ask/image), which are slow
// because `agy` itself is — there is no LLM overhead added on top.

import { definePluginEntry } from "openclaw/plugin-sdk/core";
import { spawn } from "node:child_process";
import { copyFile, unlink, readFile, writeFile, mkdir, readdir, rename, stat, rm } from "node:fs/promises";
import { existsSync } from "node:fs";
import { homedir } from "node:os";
import path from "node:path";

const HOME = process.env.HOME || homedir();
const GEMINI_DIR = path.join(HOME, ".gemini");
const MODELS_CACHE = path.join(GEMINI_DIR, "antigravity-models.txt");
const BRAIN_DIR = path.join(GEMINI_DIR, "antigravity-cli", "brain");
// Throwaway per-generation dirs holding the user's attached reference image(s),
// handed to agy via --add-dir. Created and removed around each generation.
const REFS_DIR = path.join(GEMINI_DIR, "antigravity-cli", "refs");
const WORKSPACE_DIR = process.env.OPENCLAW_WORKSPACE_DIR || path.join(HOME, ".openclaw", "workspace");
const OUTBOUND_IMAGE_DIR = path.join(WORKSPACE_DIR, "outputs", "antigravity-images");
// Keep only the newest N published images so the outbound folder never grows
// without bound. Override with ANTIGRAVITY_IMAGE_KEEP.
const OUTBOUND_IMAGE_KEEP = Math.max(1, Number(process.env.ANTIGRAVITY_IMAGE_KEEP) || 20);
// Default-model state. A plain JSON file (NOT openKeyedStore, which is gated to
// trusted/bundled plugins) so this works as an ordinary installed plugin. Lives
// in the agy config dir — outside the git-synced workspace, so it never dirties
// a sync. Same file the earlier skill used, so state carries over.
const STATE_FILE = path.join(GEMINI_DIR, "antigravity-skill.json");
// Prompt store for the Recreate/Edit buttons under generated images. Telegram
// callback_data is capped at 64 bytes, so the full prompt can never ride in the
// button — we store it here under a short id and put only `rc:<id>`/`ed:<id>`
// in the callback. Plain JSON file for the same trust-level reason as STATE_FILE.
const IMAGE_STORE_FILE = path.join(GEMINI_DIR, "antigravity-image-prompts.json");
const IMAGE_STORE_KEEP = 100;

// AspectRatio values accepted by agy's generate_image tool (verified against the
// binary's tool schema). The plugin can't pass tool args directly — the value is
// injected as an instruction in the prompt text and the model fills the tool param.
const ASPECT_RATIOS = ["1:1", "2:3", "3:2", "3:4", "4:3", "9:16", "16:9"];

// Max images one command may request. Each image is a separate agy call spending
// a separate Google image-quota unit (Nano Banana 2), so keep this small.
// Override with ANTIGRAVITY_IMAGE_MAX_COUNT.
const MAX_IMAGE_COUNT = Math.max(1, Math.min(10, Number(process.env.ANTIGRAVITY_IMAGE_MAX_COUNT) || 4));

// Last-resort model list if the cache helper has not populated a list yet.
// The live list comes from `agy-models` (cached, self-refreshing daily).
const BOOTSTRAP_MODELS = [
  "Gemini 3.5 Flash (Medium)",
  "Gemini 3.5 Flash (High)",
  "Gemini 3.5 Flash (Low)",
  "Gemini 3.1 Pro (High)",
  "Gemini 3.1 Pro (Low)",
  "Claude Sonnet 4.6 (Thinking)",
  "Claude Opus 4.6 (Thinking)",
  "GPT-OSS 120B (Medium)",
];

const IMAGE_EXTS = new Set([".png", ".jpg", ".jpeg", ".webp", ".gif"]);
const TELEGRAM_CALLBACK_MAX_BYTES = 64; // Telegram drops callback_data over 64 bytes

// Callback namespace for our interactive handler. The opaque callback value is
// `NS:<payload>` (the framework/plugin dispatch splits on the first ':').
const NS = "agy";

function resolveAgyBin() {
  for (const p of ["/usr/local/bin/agy", path.join(HOME, ".local", "bin", "agy")]) {
    if (existsSync(p)) return p;
  }
  return "agy"; // rely on PATH
}
const AGY_BIN = resolveAgyBin();

// ---- agy runner: stdin is /dev/null (agy reads leftover stdin as a prompt) ----
function runAgy(args, { timeoutMs }) {
  return new Promise((resolve) => {
    let child;
    try {
      child = spawn(AGY_BIN, args, {
        stdio: ["ignore", "pipe", "pipe"], // stdin ignored == </dev/null
        env: { ...process.env, HOME },
      });
    } catch (e) {
      resolve({ ok: false, out: "", err: String(e), timedOut: false, code: null });
      return;
    }
    // Decode on the stream so multi-byte UTF-8 (Cyrillic/emoji) that straddles a
    // chunk boundary is not corrupted — `out += <Buffer>` would decode each chunk
    // in isolation and mangle any split character.
    child.stdout.setEncoding("utf8");
    child.stderr.setEncoding("utf8");
    let out = "";
    let err = "";
    let killed = false;
    const timer = setTimeout(() => {
      killed = true;
      try { child.kill("SIGKILL"); } catch {}
    }, timeoutMs);
    child.stdout.on("data", (d) => { out += d; });
    child.stderr.on("data", (d) => { err += d; });
    child.on("error", (e) => {
      clearTimeout(timer);
      resolve({ ok: false, out, err: err || String(e), timedOut: false, code: null });
    });
    child.on("close", (code) => {
      clearTimeout(timer);
      resolve({ ok: code === 0 && !killed, out: out.trim(), err: err.trim(), timedOut: killed, code });
    });
  });
}

async function readModels() {
  try {
    const text = await readFile(MODELS_CACHE, "utf8");
    const lines = text.split("\n").map((s) => s.trim()).filter(Boolean);
    if (lines.length) return lines;
  } catch { /* fall through to bootstrap */ }
  return BOOTSTRAP_MODELS;
}

// Newest image under the brain tree. `minMtimeMs` filters out images from
// earlier runs so a failed/no-op generation never returns a stale picture.
async function newestBrainImage(minMtimeMs = 0) {
  let newest = null;
  let newestMs = minMtimeMs - 1;
  async function scan(dir, depth) {
    if (depth > 3) return;
    let entries;
    try { entries = await readdir(dir, { withFileTypes: true }); } catch { return; }
    for (const ent of entries) {
      const full = path.join(dir, ent.name);
      if (ent.isDirectory()) {
        await scan(full, depth + 1);
      } else if (IMAGE_EXTS.has(path.extname(ent.name).toLowerCase())) {
        try {
          const st = await stat(full);
          if (st.mtimeMs > newestMs) { newestMs = st.mtimeMs; newest = full; }
        } catch { /* ignore */ }
      }
    }
  }
  await scan(BRAIN_DIR, 0);
  return newest;
}

// OpenClaw only sends outbound media from an allowed root (the workspace), not
// from an arbitrary local path, so copy the brain image into the workspace and
// return THAT path. Unique name (time + random) avoids collisions; prune keeps
// the folder bounded.
async function publishBrainImage(img) {
  await mkdir(OUTBOUND_IMAGE_DIR, { recursive: true });
  const safeName = path.basename(img).replace(/[^a-zA-Z0-9._-]/g, "_");
  const uniq = `${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
  const target = path.join(OUTBOUND_IMAGE_DIR, `${uniq}-${safeName}`);
  await copyFile(img, target);
  await pruneOutboundImages().catch(() => {}); // best-effort; must not fail the publish
  return target;
}

// Keep only the newest OUTBOUND_IMAGE_KEEP files; delete the rest. Runs at
// publish time (not after send — that would race the outbound layer that reads
// the returned path). Every step is best-effort so cleanup never breaks delivery.
async function pruneOutboundImages() {
  let entries;
  try { entries = await readdir(OUTBOUND_IMAGE_DIR, { withFileTypes: true }); } catch { return; }
  const files = [];
  for (const ent of entries) {
    if (!ent.isFile()) continue;
    const full = path.join(OUTBOUND_IMAGE_DIR, ent.name);
    try { files.push({ full, mtimeMs: (await stat(full)).mtimeMs }); } catch { /* ignore */ }
  }
  files.sort((a, b) => b.mtimeMs - a.mtimeMs);
  for (const f of files.slice(OUTBOUND_IMAGE_KEEP)) {
    try { await unlink(f.full); } catch { /* ignore */ }
  }
}

// ---- image prompt store (Recreate/Edit buttons) ----
// Store mutations are serialized through a promise chain: the background
// Recreate flow made saveImagePrompt genuinely concurrent with the foreground
// command path, and an unserialized read-modify-write would drop the losing
// entry (its buttons would then dead-end on "кнопка устарела").
let imageStoreLock = Promise.resolve();
function withImageStore(fn) {
  const run = imageStoreLock.then(fn, fn);
  imageStoreLock = run.then(() => {}, () => {});
  return run;
}
async function readImageStore() {
  try {
    const obj = JSON.parse(await readFile(IMAGE_STORE_FILE, "utf8"));
    return obj && typeof obj === "object" && !Array.isArray(obj) ? obj : {};
  } catch { return {}; }
}
async function writeImageStore(store) {
  const ids = Object.keys(store);
  if (ids.length > IMAGE_STORE_KEEP) {
    ids.sort((a, b) => (store[a]?.ts || 0) - (store[b]?.ts || 0));
    for (const id of ids.slice(0, ids.length - IMAGE_STORE_KEEP)) delete store[id];
  }
  await mkdir(GEMINI_DIR, { recursive: true });
  // tmp + rename: a crash mid-write must not leave invalid JSON (readImageStore
  // would silently return {} and orphan every existing button).
  const tmp = `${IMAGE_STORE_FILE}.tmp`;
  await writeFile(tmp, JSON.stringify(store));
  await rename(tmp, IMAGE_STORE_FILE);
}
async function saveImagePrompt(prompt, aspect, count, refs) {
  return withImageStore(async () => {
    const store = await readImageStore();
    let id;
    do { id = Math.random().toString(36).slice(2, 8); } while (store[id]);
    store[id] = {
      p: prompt,
      ...(aspect ? { ar: aspect } : {}),
      ...(count > 1 ? { n: count } : {}),
      ...(Array.isArray(refs) && refs.length ? { refs } : {}),
      ts: Date.now(),
    };
    await writeImageStore(store);
    return id;
  });
}
async function getImagePrompt(id) {
  if (!/^[a-z0-9]{1,12}$/.test(id || "")) return null;
  const store = await readImageStore();
  const entry = store[id];
  return entry && typeof entry.p === "string" ? entry : null;
}

// ---- attached-image reference stash (for /antigravity_image with a photo) ----
// A plugin command handler's ctx carries NO inbound media (verified against the
// OpenClaw 2026.6 PluginCommandContext: only text/args + addressing). The only
// plugin-visible path to an attached photo is the `message_received` hook, whose
// event carries the downloaded file path in `event.metadata.mediaPath(s)`. That
// hook fires (fire-and-forget) around command dispatch, BEFORE our command runs —
// so the hook records a "sighting" (sender + downloaded image paths) here, and the
// command handler picks it up. A plain JSON ring (not openKeyedStore, which is
// gated to trusted/bundled plugins) for the same reason as the other stores.
const IMAGE_REF_STORE_FILE = path.join(GEMINI_DIR, "antigravity-image-refs.json");
const IMAGE_REF_KEEP = 20;             // ring size across all senders
const IMAGE_REF_TTL_MS = 5 * 60_000;   // sightings older than this are ignored/pruned
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

let refStoreLock = Promise.resolve();
function withRefStore(fn) {
  const run = refStoreLock.then(fn, fn);
  refStoreLock = run.then(() => {}, () => {});
  return run;
}
async function readRefStore() {
  try {
    const arr = JSON.parse(await readFile(IMAGE_REF_STORE_FILE, "utf8"));
    return Array.isArray(arr) ? arr : [];
  } catch { return []; }
}
async function writeRefStore(list) {
  await mkdir(GEMINI_DIR, { recursive: true });
  const tmp = `${IMAGE_REF_STORE_FILE}.tmp`;
  await writeFile(tmp, JSON.stringify(list.slice(-IMAGE_REF_KEEP)));
  await rename(tmp, IMAGE_REF_STORE_FILE);
}
// Record that an /antigravity_image command from `sender`/`from` arrived carrying
// `paths` image files (possibly empty — an empty sighting still lets the waiting
// command resolve instantly instead of polling the full timeout).
async function recordReferenceSighting(sender, from, paths) {
  return withRefStore(async () => {
    const now = Date.now();
    const list = (await readRefStore()).filter((e) => e && now - (e.ts || 0) < IMAGE_REF_TTL_MS);
    list.push({ s: String(sender ?? ""), f: String(from ?? ""), p: Array.isArray(paths) ? paths : [], ts: now, c: false });
    await writeRefStore(list);
  });
}
// Claim the freshest unconsumed sighting from this sender newer than `sinceMs`.
// Returns its paths array (possibly empty) or null when there is no sighting yet.
// Matching is sender-first: when BOTH sides know the sender id they must agree —
// in a group chat `from` is shared by everyone, so a from-only match could hand
// user A's attached photo to user B's concurrent command. `from` alone is only
// trusted when one side lacks a sender id (defensive fallback).
async function consumeReferenceSighting(senderId, from, sinceMs) {
  return withRefStore(async () => {
    const list = await readRefStore();
    const s = String(senderId ?? "");
    const f = String(from ?? "");
    const matches = (e) => {
      const es = String(e.s ?? "");
      const ef = String(e.f ?? "");
      if (s && es) return es === s;
      return Boolean(f && ef && ef === f);
    };
    let idx = -1, bestTs = -1;
    for (let i = 0; i < list.length; i++) {
      const e = list[i];
      if (!e || e.c) continue;
      if (!matches(e)) continue;
      if ((e.ts || 0) < sinceMs) continue;
      if ((e.ts || 0) > bestTs) { bestTs = e.ts; idx = i; }
    }
    if (idx < 0) return null;
    list[idx].c = true;
    await writeRefStore(list);
    return Array.isArray(list[idx].p) ? list[idx].p : [];
  });
}
// Wait briefly for the message_received hook (fired ~concurrently, not awaited) to
// land this command's sighting, then return its reference paths. [] means either
// "seen, no photo attached" or "no sighting arrived" — both mean generate text-only.
async function awaitReferenceFor(senderId, from, timeoutMs = 1500) {
  const start = Date.now();
  const since = start - 30_000; // only this message's sighting (hook fires just before us)
  for (;;) {
    const paths = await consumeReferenceSighting(senderId, from, since);
    if (paths) return paths;
    if (Date.now() - start >= timeoutMs) return [];
    await sleep(120);
  }
}
// True when a raw inbound message body is an /antigravity_image (or /antigravity
// image) command — tolerates a `@BotName` suffix and the two-word form.
function isImageCommandText(text) {
  const m = (text || "").trim().match(/^\/([a-z0-9_]+)(?:@[a-z0-9_]+)?(?:\s+(\S+))?/i);
  if (!m) return false;
  const cmd = m[1].toLowerCase();
  if (cmd === "antigravity_image") return true;
  return cmd === "antigravity" && (m[2] || "").toLowerCase() === "image";
}
// Pull the downloaded IMAGE file paths off a message:received hook event.
// The internal-hook event shape is { type, action, sessionKey, context, ... } with
// the message fields under `context`: { from, content, ..., metadata: { senderId,
// mediaPath(s), mediaType(s), ... } } (verified against the OpenClaw 2026.6 dist,
// toInternalMessageReceivedContext). Prefer the media type; fall back to extension.
function imagePathsFromEvent(event) {
  const md = event?.context?.metadata || {};
  const paths = Array.isArray(md.mediaPaths) && md.mediaPaths.length ? md.mediaPaths : (md.mediaPath ? [md.mediaPath] : []);
  const types = Array.isArray(md.mediaTypes) && md.mediaTypes.length ? md.mediaTypes : (md.mediaType ? [md.mediaType] : []);
  return paths.filter((p, i) => {
    if (typeof p !== "string" || !p) return false;
    const t = types[i] || types[0] || "";
    if (/^image\//i.test(t)) return true;
    if (t) return false; // a known non-image media type
    return IMAGE_EXTS.has(path.extname(p).toLowerCase());
  });
}

// When generate_image hits a Google-side error (429 quota / 503 capacity), the
// reasoning model sometimes "handles" it itself — schedules a retry timer, writes
// a status artifact — and returns an EMPTY answer instead of relaying the error
// (seen on prod 2026-07-08: three silent attempts on an exhausted image quota).
// agy's stdout then carries nothing to detect, but the brain transcript does.
// Scan transcripts touched by THIS run for the structured error markers.
async function detectBrainError(minMtimeMs) {
  const found = { quota: false, capacity: false };
  async function scan(dir, depth) {
    if (depth > 4) return;
    let entries;
    try { entries = await readdir(dir, { withFileTypes: true }); } catch { return; }
    for (const ent of entries) {
      const full = path.join(dir, ent.name);
      if (ent.isDirectory()) {
        if (ent.name === ".git") continue;
        await scan(full, depth + 1);
      } else if (ent.name === "transcript.jsonl") {
        try {
          const st = await stat(full);
          if (st.mtimeMs < minMtimeMs) continue;
          const text = await readFile(full, "utf8");
          const tail = text.length > 65536 ? text.slice(-65536) : text;
          if (/RESOURCE_EXHAUSTED|\b429\b/i.test(tail)) found.quota = true;
          if (/MODEL_CAPACITY_EXHAUSTED|\b503\b/i.test(tail)) found.capacity = true;
        } catch { /* ignore */ }
      }
    }
  }
  await scan(BRAIN_DIR, 0);
  return found.quota || found.capacity ? found : null;
}

// Inline aspect prefix: `/antigravity_image 16:9 закат` — first token is applied
// as a one-off ratio when it matches the known list, otherwise it's just prompt text.
function parseAspectPrefix(payload) {
  const trimmed = (payload || "").trim();
  // A bare ratio with no prompt must fall into the "show hint" branch (empty
  // rest), not become a multi-minute generation of the literal text "16:9".
  if (ASPECT_RATIOS.includes(trimmed)) return { aspect: trimmed, rest: "" };
  const m = trimmed.match(/^(\d{1,2}:\d{1,2})\s+(\S[\s\S]*)$/);
  if (m && ASPECT_RATIOS.includes(m[1])) return { aspect: m[1], rest: m[2].trim() };
  return { aspect: null, rest: trimmed };
}

// Inline count prefix: how many images to generate. Parsed AFTER the aspect prefix,
// from the very start of the remaining prompt. Two accepted forms:
//   - explicit multiplier: `x3` / `3x` / `х3` / `3х` (latin x or Cyrillic х)
//   - count phrase with an image noun: `3 изображения|картинки|фото|варианта|штуки|
//     кадра` (ru) or `3 images|pictures|photos|variants` (en)
// The image noun is required so a plain leading number that describes the SUBJECT
// ("3 котика идут гулять") stays a single image of three kittens, not three images.
// The matched prefix is stripped; the remainder is the subject. Count is clamped to
// [1, MAX_IMAGE_COUNT]. If stripping would leave no subject, the whole text is kept
// as the subject and count falls back to 1.
function parseCountPrefix(payload) {
  const trimmed = (payload || "").trim();
  const clamp = (n) => Math.max(1, Math.min(MAX_IMAGE_COUNT, n));
  let m = trimmed.match(/^[xх]\s?(\d{1,2})(?=[\s,.:;)\-]|$)[\s,.:;)\-]*([\s\S]*)$/i) ||
          trimmed.match(/^(\d{1,2})\s?[xх](?=[\s,.:;)\-]|$)[\s,.:;)\-]*([\s\S]*)$/i);
  if (m && Number(m[1]) >= 1 && m[2].trim()) return { count: clamp(Number(m[1])), rest: m[2].trim() };
  m = trimmed.match(/^(\d{1,2})\s+(?:изображени[а-яё]*|картин[а-яё]*|фото|вариант[а-яё]*|штук[а-яё]*|шт\.?|кадр[а-яё]*|images?|pictures?|photos?|variants?)(?=[\s,.:;)\-]|$)[\s,.:;)\-]*([\s\S]*)$/i);
  if (m && Number(m[1]) >= 1 && m[2].trim()) return { count: clamp(Number(m[1])), rest: m[2].trim() };
  return { count: 1, rest: trimmed };
}

// Detect a Google "quota exhausted" (HTTP 429 RESOURCE_EXHAUSTED) response in
// agy's output and pull out the reset window it mentions, so we can show a clear
// message instead of a raw error. Antigravity meters quota per-model, and image
// generation uses a separate model (Nano Banana 2 / gemini-3.1-flash-image), so
// its limit is exhausted independently of the text/reasoning models.
// Refs: ai.google.dev/gemini-api/docs/rate-limits, .../image-generation,
//       antigravity.google/docs/plans.
function detectQuotaError(text, { strict = false } = {}) {
  if (!text) return null;
  // agy relays the failure as free-form model prose, in the PROMPT's language
  // (English or Russian), so wording varies a lot: "429 Resource Exhausted",
  // "reached its usage quota", "capacity will reset", "исчерпан лимит запросов",
  // "квота восстановится через...". Detect via: (1) unambiguous structured
  // markers; (2) a quota/limit word sitting next to an exhaustion word (EN or RU);
  // (3) in non-strict mode, a looser co-occurrence. `strict` is used on the ask
  // path so a genuine Q&A about limits/quotas isn't mistaken for an error.
  const structured = /resource[\s_-]*exhausted/i.test(text) || /\b429\b/.test(text);
  const adjacency =
    /(quota|limit|capacity)[^.\n]{0,30}(exhaust|exceed|reach|unavailable|unable)/i.test(text) ||
    /(exhaust|exceed|reach|unavailable|unable)[^.\n]{0,30}(quota|limit|capacity)/i.test(text) ||
    /(квот\w*|лимит\w*)[^.\n]{0,30}(исчерпан|превыш|восстанов|недоступ)/i.test(text) ||
    /(исчерпан|превыш|недоступ)[^.\n]{0,30}(квот\w*|лимит\w*)/i.test(text);
  const broad =
    (/\b(quota|rate[\s_-]?limit|usage limit|capacity)\b/i.test(text) || /(квот|лимит)/i.test(text)) &&
    (/\b(exhaust\w*|reset\w*|exceed\w*|unavailable|unable)\b/i.test(text) ||
      /(исчерпан|восстанов|обнов|сброс|превыш|недоступ)/i.test(text));
  const looksLikeQuota = structured || adjacency || (!strict && broad);
  if (!looksLikeQuota) return null;
  // Best-effort reset window, rendered in Russian. EN: "reset ... in X"; RU: "через X".
  let reset = null;
  const m =
    text.match(/reset[^.]*?\bin\b\s*(?:approximately\s+|about\s+)?([^.\n)]{1,50})/i) ||
    text.match(/через\s*(?:~|примерно\s+|около\s+)?([^.\n)]{1,50})/i);
  if (m) {
    const raw = m[1];
    const h = raw.match(/(\d+)\s*(?:hours?|hrs?|\bh\b|час\w*|\bч\b)/i);
    const mi = raw.match(/(\d+)\s*(?:minutes?|mins?|\bm\b|минут\w*|\bмин\b)/i);
    const parts = [];
    if (h) parts.push(`${h[1]} ч`);
    if (mi) parts.push(`${mi[1]} мин`);
    if (parts.length) reset = parts.join(" ");
    else if (/few\s+hours?|несколько\s+час/i.test(raw)) reset = "несколько часов";
    else if (/hour|час/i.test(raw)) reset = "около часа";
    // vague/non-numeric ("shortly", etc.) -> leave null, no half-language suffix
  }
  return { reset };
}
function quotaResetSuffix(reset) {
  return reset ? ` Сброс примерно через ${reset}.` : "";
}

// Distinguish a TRANSIENT Google-side capacity/availability failure (HTTP 503
// "MODEL_CAPACITY_EXHAUSTED for gemini-3.1-flash-image" / "Service Unavailable" —
// the image model is momentarily overloaded on Google's side) from a per-account
// quota (429 RESOURCE_EXHAUSTED; detectQuotaError). This must be checked FIRST,
// because "MODEL_CAPACITY_EXHAUSTED" contains "capacity"+"exhausted" and would
// otherwise trip detectQuotaError and be mislabelled as the user's quota. A 503 is
// not the user's limit and clears on its own, so it warrants a "try again" message.
function detectCapacityError(text) {
  if (!text) return false;
  return /model[\s_-]*capacity[\s_-]*exhausted/i.test(text)
    || /\b503\b/.test(text)
    || /service[\s_-]*unavailable/i.test(text)
    || /(out of|over[\s-]?)\s*capacity/i.test(text)
    || /\boverloaded\b|temporarily unavailable/i.test(text)
    || /(перегруж\w*|временно недоступ\w*)/i.test(text);
}

// The reasoning model that fronts the generate_image tool (esp. GPT-OSS) treats a
// leading markdown emphasis/heading char as formatting and often returns an empty
// response WITHOUT calling the tool — verified on prod: a subject starting with `*`
// failed ~100% of the time vs ~33% for the same text without it. Strip leading
// markdown noise so the subject reads as plain prose. Keep the original if stripping
// would empty it.
function sanitizeImageSubject(s) {
  const stripped = (s || "").replace(/^[\s*_~`#>]+/, "").trim();
  return stripped || (s || "").trim();
}

// ---- opaque callback encoding ----
// Navigation buttons are `action.type:"callback"` with value `NS:<payload>`. On
// the FIRST render (a command reply) the framework encodes them for us. But when
// the interactive handler rewrites the message via editMessage, its buttons take
// RAW `callback_data`, so we must produce the same `tgcb1:` opaque form ourselves.
// This mirrors OpenClaw's Telegram extension (buildTelegramOpaqueCallbackData +
// its FNV-1a checksum) so taps route back to our namespace handler. Values here
// are ASCII (model names, short tokens), so charCodeAt == byte value.
function opaqueChecksum(value) {
  let hash = 2166136261;
  for (let i = 0; i < value.length; i += 1) {
    hash ^= value.charCodeAt(i);
    hash = Math.imul(hash, 16777619) >>> 0;
  }
  return hash.toString(36).slice(0, 5).padStart(5, "0");
}
function opaqueCallbackData(value) {
  return `tgcb1:${opaqueChecksum(value)}:${value}`;
}
function fitsCallbackValue(value) {
  return Buffer.byteLength(opaqueCallbackData(`${NS}:${value}`), "utf8") <= TELEGRAM_CALLBACK_MAX_BYTES;
}

// ---- abstract menu model: { text, rows: [ [ {label, value} ] ] } ----
// The two action commands are written into the menu body as markdown code spans
// (tap-to-copy) rather than as inline buttons: a button tap is dispatched to the
// interactive handler, whose Telegram respond.reply/editMessage send PLAIN text with
// no parse_mode — so a button can never render a tap-to-copy monospace command, and
// the edit-in-place render can't render markdown at all. Only the command-reply path
// (a real `/antigravity`) renders markdown.
//
// So the command lines are shown ONLY with `withCommands` (the command-reply path),
// where they render monospace. The edit-in-place path (back-navigation) calls with
// `withCommands: false` so it never shows a plain, non-monospace copy of the
// commands — you only ever see them where they're actually tap-to-copy.
function menuMain(defaultModel, { withCommands = true } = {}) {
  const head = `✨ Antigravity — пульт\n${defaultModel ? `Модель: ${defaultModel}` : "Модель: agy по умолчанию"}`;
  const commands = "\n\nСпросить: `/antigravity_ask` текст вопроса\nКартинка: `/antigravity_image` текст запроса";
  return {
    text: withCommands ? head + commands : head,
    rows: [
      [{ label: "Модель", value: "models" }, { label: "Статус", value: "status" }],
      [{ label: "Формат картинок", value: "aspect" }],
    ],
  };
}
// Aspect-ratio picker. Tap sets the persistent default for /antigravity_image;
// "авто" clears it (agy's own default, 1:1). All values fit callback_data easily.
function menuAspect(currentAspect) {
  const mark = (v) => `${currentAspect === v ? "• " : ""}${v}`;
  return {
    text: `Формат картинок (соотношение сторон)${currentAspect ? ` — текущий: ${currentAspect}` : " — сейчас: авто"}.\nРазово: /antigravity_image 16:9 текст запроса`,
    rows: [
      [{ label: mark("1:1"), value: "ar:1:1" }, { label: mark("3:2"), value: "ar:3:2" }, { label: mark("2:3"), value: "ar:2:3" }],
      [{ label: mark("16:9"), value: "ar:16:9" }, { label: mark("9:16"), value: "ar:9:16" }],
      [{ label: mark("4:3"), value: "ar:4:3" }, { label: mark("3:4"), value: "ar:3:4" }],
      [{ label: `${currentAspect ? "" : "• "}авто`, value: "ar:auto" }, { label: "‹ Назад", value: "menu" }],
    ],
  };
}
function menuMainNote(defaultModel, note) {
  return { ...menuMain(defaultModel), text: `✨ Antigravity — пульт\n${note}` };
}
async function menuModels(defaultModel) {
  const models = await readModels();
  const rows = [];
  const skipped = [];
  for (const m of models) {
    if (!fitsCallbackValue(`m:${m}`)) { skipped.push(m); continue; }
    rows.push([{ label: `${defaultModel === m ? "• " : ""}${m}`, value: `m:${m}` }]);
  }
  rows.push([{ label: "‹ Назад", value: "menu" }]);
  let text = `Выбор модели${defaultModel ? ` (текущая: ${defaultModel})` : ""}:`;
  if (skipped.length) text += `\n(не помещаются в кнопку: ${skipped.join(", ")} — задай /antigravity model <имя>)`;
  return { text, rows };
}
function menuBack(text) {
  return { text, rows: [[{ label: "‹ Назад", value: "menu" }]] };
}

function statusText(defaultModel, imageAspect) {
  return `Модель по умолчанию: ${defaultModel || "agy (без явного выбора)"}\nФормат картинок: ${imageAspect || "авто"}`;
}

// Shown when a command arrives with no argument (bare `/antigravity_ask`, the
// "Спросить" button, etc.). Lead with the ACTION ("Введите вопрос") rather than
// echoing "Напиши: /antigravity_ask …", which reads as a confusing loop right
// after the user just tapped that command. A plugin command can't capture a bare
// follow-up message (that goes to the LLM), so the text must be sent together
// with the command in one message.
//
// Two variants:
// - *_HINT_MD: the command token is wrapped in a markdown code span (`…`). When
//   rendered via a presentation TEXT block (which is "markdown-ish"), Telegram
//   turns it into a `code` entity — tap-to-copy. Used on the command-reply path.
// - *_HINT: plain fallback for the edit-in-place (button) path, where the raw
//   editMessage text is not markdown-rendered, so backticks would show literally.
const ASK_HINT = "✍️ Введите вопрос: /antigravity_ask текст вопроса";
const IMAGE_HINT = "🖼 Введите запрос на генерацию изображения: /antigravity_image текст запроса\nФормат — первым словом (16:9), количество — x3 или «3 изображения …». Можно приложить фото-референс к сообщению.";
const ASK_HINT_MD = "✍️ Введите вопрос: `/antigravity_ask` текст вопроса";
const IMAGE_HINT_MD = "🖼 Введите запрос на генерацию изображения: `/antigravity_image` текст запроса\nФормат — первым словом: `/antigravity_image 16:9`; количество: `x3` или «3 изображения …».\nМожно приложить фото-референс к сообщению — сгенерирую с оглядкой на него.";

// ---- renderers ----
// Command reply (first render): the framework encodes `type:"callback"` -> tgcb1.
function asReply(menu, extra = {}) {
  return {
    ...extra,
    text: menu.text,
    presentation: {
      blocks: menu.rows.map((row) => ({
        type: "buttons",
        buttons: row.map((b) => ({ label: b.label, action: { type: "callback", value: `${NS}:${b.value}` } })),
      })),
    },
  };
}
// Interactive edit: raw Telegram keyboard; we encode callback_data ourselves.
function asEditButtons(menu) {
  return menu.rows.map((row) => row.map((b) => ({ text: b.label, callback_data: opaqueCallbackData(`${NS}:${b.value}`) })));
}
// The edit-in-place path (respond.editMessage/reply) sends PLAIN text — markdown
// code spans would show as literal backticks — so strip them there.
function plainText(text) {
  return text.replace(/`/g, "");
}
// Hint reply on the command-reply path. Top-level `text` is required (a
// presentation-only reply is treated as "no response"). The command token is
// wrapped in a markdown code span (`…`); if this channel renders the reply text
// as markdown, Telegram turns it into a `code` entity = tap-to-copy.
function asHintReply(textMd) {
  return {
    text: textMd,
    presentation: {
      blocks: [
        { type: "buttons", buttons: [{ label: "‹ Назад", action: { type: "callback", value: `${NS}:menu` } }] },
      ],
    },
  };
}

export default definePluginEntry({
  id: "antigravity",
  name: "Antigravity",
  description: "Antigravity (agy) control panel: model switch, status, ask, image — instant inline buttons (edit-in-place).",
  register(api) {
    async function getStateValue(key) {
      try {
        const obj = JSON.parse(await readFile(STATE_FILE, "utf8"));
        return obj && typeof obj[key] === "string" ? obj[key] : null;
      } catch { return null; }
    }
    async function setStateValue(key, value) {
      let obj = {};
      try { obj = JSON.parse(await readFile(STATE_FILE, "utf8")) || {}; } catch { /* new file */ }
      if (value) obj[key] = value;
      else delete obj[key];
      try {
        await mkdir(GEMINI_DIR, { recursive: true });
        await writeFile(STATE_FILE, JSON.stringify(obj, null, 2));
      } catch (e) {
        api.logger?.warn?.(`antigravity: could not persist ${key}: ${e}`);
      }
    }
    const getDefaultModel = () => getStateValue("default_model");
    const setDefaultModel = (m) => setStateValue("default_model", m);
    const getImageAspect = () => getStateValue("image_aspect");
    const setImageAspect = (v) => setStateValue("image_aspect", v);
    function modelArgs(defaultModel) {
      return defaultModel ? ["--model", defaultModel] : [];
    }

    // ---- shared agy-backed actions (used by both the `/antigravity ask|image`
    // subcommands and the single-token `/antigravity_ask` / `/antigravity_image`
    // commands). Slow == agy's own latency, no LLM on top. ----
    async function doAsk(payload, defaultModel) {
      const r = await runAgy([...modelArgs(defaultModel), "-p", payload], { timeoutMs: 120_000 });
      // Only treat output as an error when agy itself failed — a successful answer
      // may legitimately discuss quotas/capacity without being an error.
      if (!(r.ok && r.out)) {
        if (detectCapacityError(r.out || r.err)) return { text: "🕐 Модель Google временно перегружена (503) — это на стороне Google, не твоя квота. Попробуй ещё раз через минуту." };
        const quota = detectQuotaError(r.out || r.err, { strict: true });
        if (quota) return { text: `🚫 Квота Google на выбранную модель исчерпана.${quotaResetSuffix(quota.reset)}\nПопробуй позже или смени модель в /antigravity model.` };
      }
      if (r.ok && r.out) return { text: r.out };
      if (r.timedOut) return { text: "⏳ agy думал слишком долго — попробуй короче или позже." };
      return { text: `Не удалось получить ответ agy.${r.err ? `\n${r.err.slice(0, 400)}` : ""}` };
    }

    // Full copyable command for a stored prompt (used in captions and the Edit
    // flow). Backticks in the prompt would terminate the markdown code span the
    // command is displayed in (truncating what tap-to-copy yields), so the
    // DISPLAYED command swaps them for apostrophes and collapses newlines; the
    // stored prompt stays raw for Recreate.
    function imageCommandFor(prompt, aspect, count) {
      const p = prompt.replace(/`/g, "'").replace(/\s+/g, " ").trim();
      const countPrefix = count > 1 ? `x${count} ` : "";
      return `/antigravity_image ${aspect ? `${aspect} ` : ""}${countPrefix}${p}`;
    }
    // The caption shown under a generated photo: the tap-to-copy command as a
    // markdown code span (rendered on the command-reply AND adapter.sendPayload
    // paths). It doubles as the visible prompt and the primary Edit affordance, so
    // there's no separate `🖼 <prompt>` label line. Telegram caps captions at 1024
    // chars and only keeps the buttons on the photo when the text fits as a caption
    // (longer text becomes a buttonless follow-up message), so truncate rather than
    // overflow.
    function imageCaption(prompt, aspect, count) {
      const cmd = imageCommandFor(prompt, aspect, count);
      return cmd.length + 2 <= 1000 ? `\`${cmd}\`` : `\`${cmd.slice(0, 997)}…\``;
    }
    // Recreate/Edit inline keyboard, in the RAW Telegram shape (rows of
    // {text, callback_data}). We deliver these via `channelData.telegram.buttons`
    // rather than `presentation.blocks` on purpose: on the media/photo delivery
    // path OpenClaw's renderPresentation flattens every presentation block into the
    // caption text too (a `- label` list Telegram shows as `• label`), so a
    // presentation-carried button renders BOTH as a caption bullet AND as a real
    // key — the visible duplication. channelData buttons skip that flatten (no
    // presentation to fold) while still becoming a real inline keyboard. The
    // callback_data uses the same tgcb1: opaque form the framework expects, so taps
    // route back to this plugin's interactive handler exactly like the edit-in-place
    // keyboard already does.
    function imageKeyboard(id) {
      return [[
        { text: "🔁 Ещё раз", callback_data: opaqueCallbackData(`${NS}:rc:${id}`) },
        { text: "✏️ Изменить", callback_data: opaqueCallbackData(`${NS}:ed:${id}`) },
      ]];
    }
    // Photo reply: caption + Recreate/Edit buttons. `mediaUrls` may hold one or many
    // images; OpenClaw sends them as separate sendPhoto messages, with the caption
    // and the inline keyboard attached to the FIRST image only.
    function buildImageReply(prompt, aspect, count, mediaUrls, id) {
      const media = mediaUrls.length === 1
        ? { mediaUrl: mediaUrls[0] }
        : { mediaUrls };
      return {
        text: imageCaption(prompt, aspect, count),
        ...media,
        channelData: { telegram: { buttons: imageKeyboard(id) } },
      };
    }

    // All image generations are serialized through one promise chain. Two
    // overlapping runs would race newestBrainImage over the shared brain tree
    // and could deliver run A's picture under run B's caption/buttons; the
    // queue also keeps repeated Recreate taps from spawning parallel agy
    // processes. startMs is captured inside doImage after the prior run ends,
    // so windows never overlap.
    let imageQueue = Promise.resolve();
    let imageQueueDepth = 0;
    function doImageQueued(payload, defaultModel, aspect, count = 1, refPaths = []) {
      imageQueueDepth += 1;
      const run = imageQueue
        .then(() => doImage(payload, defaultModel, aspect, count, refPaths))
        .finally(() => { imageQueueDepth -= 1; });
      imageQueue = run.then(() => {}, () => {});
      return run;
    }

    // Remove refs/ staging dirs older than an hour. Normally each generation
    // removes its own dir in doImage's finally, but a gateway crash/restart
    // mid-generation orphans the dir forever — sweep those on the next run.
    async function pruneStaleRefDirs() {
      let entries;
      try { entries = await readdir(REFS_DIR, { withFileTypes: true }); } catch { return; }
      const cutoff = Date.now() - 60 * 60_000;
      for (const ent of entries) {
        if (!ent.isDirectory()) continue;
        // Dir names start with the creation Date.now() — cheaper than stat and
        // immune to mtime updates from the copy.
        const born = Number(ent.name.split("-")[0]);
        if (Number.isFinite(born) && born < cutoff) {
          await rm(path.join(REFS_DIR, ent.name), { recursive: true, force: true }).catch(() => {});
        }
      }
    }

    // Copy the user's attached reference image(s) into a fresh throwaway dir agy can
    // see via --add-dir, with simple predictable names the prompt can point at.
    // Returns { dir, names, addDirArgs } or null when there are no usable refs.
    // `lost` is set when refPaths were given but NONE could be read (the inbound
    // media file was pruned by OpenClaw) — callers surface that instead of silently
    // degrading a "with this product" prompt to text-only.
    async function stageReferenceImages(refPaths) {
      const usable = (refPaths || []).filter((p) => typeof p === "string" && p);
      if (!usable.length) return null;
      await pruneStaleRefDirs().catch(() => {});
      const dir = path.join(REFS_DIR, `${Date.now()}-${Math.random().toString(36).slice(2, 8)}`);
      const names = [];
      try {
        await mkdir(dir, { recursive: true });
        for (let i = 0; i < usable.length; i++) {
          const ext = (path.extname(usable[i]).toLowerCase().match(/^\.(png|jpe?g|webp|gif)$/) || [".png"])[0];
          const name = `ref${i + 1}${ext}`;
          try { await copyFile(usable[i], path.join(dir, name)); names.push(name); } catch { /* skip missing/unreadable */ }
        }
      } catch { /* mkdir failed — fall through to cleanup */ }
      if (!names.length) {
        await rm(dir, { recursive: true, force: true }).catch(() => {});
        return { lost: true };
      }
      return { dir, names, addDirArgs: ["--add-dir", dir] };
    }

    async function doImage(payload, defaultModel, aspect, count = 1, refPaths = []) {
      // Strip leading markdown noise so a stray `*`/`_`/`#` doesn't make the model
      // return an empty response without calling the tool (see sanitizeImageSubject).
      const subject = sanitizeImageSubject(payload);
      // The plugin can't pass tool args to agy, so the ratio rides as a prompt
      // instruction — the reasoning model copies it into generate_image's
      // AspectRatio parameter (its only supported values are ASPECT_RATIOS).
      const aspectClause = aspect ? ` Set the AspectRatio parameter of generate_image to "${aspect}".` : "";
      // Attached reference image(s): agy reads image files from its workspace and
      // passes them to generate_image as input images (verified: it reproduces an
      // unseen product's shape/colours/label from a --add-dir file it was told to
      // use). So stage the file(s) and point the prompt at them.
      const ref = await stageReferenceImages(refPaths);
      const refLost = ref?.lost === true;
      const staged = ref && !refLost ? ref : null;
      const referenceClause = staged
        ? ` The user's request refers to a specific product/object shown in reference image file(s) in your workspace: ${staged.names.join(", ")}. Treat those files as that exact referenced product/object (that is what phrases like "this product"/"вот этот товар" point to) and reproduce it faithfully in the generated image — same shape, colours, cap, label text and markings.`
        : "";
      const prompt = `Use your generate_image tool to create an image: ${subject}.${referenceClause}${aspectClause} Save it as an artifact.`;
      const extraArgs = staged ? staged.addDirArgs : [];

      // Generate ONE image, with the flaky-retry loop and Google-side error handling.
      // The reasoning model is flaky at actually invoking generate_image (~1/3 of
      // clean prompts still return an empty response with no image); that failure
      // comes back FAST (no generation, no capacity spent), so retry a few times —
      // only on that "no image, not a real Google-side error" case. Returns
      // { image } on success, { stop: reply } on a systemic condition
      // (capacity/quota/timeout) that should halt the whole batch, or { none } when
      // the model simply never called the generator after retries.
      async function attemptOneImage() {
        let r;
        for (let attempt = 1; attempt <= 3; attempt++) {
          // Only accept an image produced by THIS attempt: capture a start time (with
          // a small clock-granularity margin) and ignore anything older, so a
          // failed/no-op generation can't resend a stale image under the new caption.
          const startMs = Date.now() - 2000;
          r = await runAgy([...modelArgs(defaultModel), ...extraArgs, "--print-timeout", "3m", "-p", prompt], { timeoutMs: 210_000 });
          const img = await newestBrainImage(startMs);
          if (img) {
            try { return { image: await publishBrainImage(img) }; }
            catch (e) {
              api.logger?.error?.(`antigravity: publish image failed: ${e?.message || e}`);
              return { stop: { text: `🖼 Картинка сгенерирована, но не удалось подготовить её к отправке.\n${String(e?.message || e).slice(0, 200)}` } };
            }
          }
          // Real Google-side / timeout conditions: report, don't retry. A 503 (image
          // model overloaded on Google's side) is transient and NOT the user's quota —
          // check it before detectQuotaError, whose "capacity exhausted" match would
          // otherwise mislabel it as a quota.
          if (detectCapacityError(r.out || r.err)) return { stop: { text: "🕐 Модель картинок Google (Nano Banana 2 / gemini-3.1-flash-image) временно перегружена (503, MODEL_CAPACITY_EXHAUSTED) — это на стороне Google, а не твоя квота. Попробуй ещё раз через минуту-другую." } };
          const quota = detectQuotaError(r.out || r.err);
          if (quota) return { stop: { text: `🚫 Квота Google на генерацию картинок исчерпана.${quotaResetSuffix(quota.reset)}\nКартинки идут по отдельной квоте (модель Nano Banana 2), не связанной с текстовыми моделями — /antigravity ask работает как обычно.` } };
          if (r.timedOut) return { stop: { text: "⏳ Генерация картинки не уложилась в тайм-аут. Попробуй позже или упрости запрос." } };
          // Empty stdout can hide a Google-side error the model "handled" silently
          // (retry timers + status artifact instead of relaying the failure). Check
          // this run's brain transcript before burning the remaining attempts.
          const brainErr = await detectBrainError(startMs).catch(() => null);
          if (brainErr?.quota) return { stop: { text: "🚫 Квота Google на генерацию картинок исчерпана (429 RESOURCE_EXHAUSTED — видно в журнале agy). Обычно сброс в течение ~15 минут — попробуй позже.\nКартинки идут по отдельной квоте (модель Nano Banana 2), /antigravity ask работает как обычно." } };
          if (brainErr?.capacity) return { stop: { text: "🕐 Модель картинок Google временно перегружена (503) — это на стороне Google, не твоя квота. Попробуй ещё раз через минуту-другую." } };
          // else: model genuinely didn't call the tool -> retry.
          api.logger?.info?.(`antigravity: image attempt ${attempt} produced no image; retrying`);
        }
        return { none: true };
      }

      try {
        const mediaUrls = [];
        let stop = null;
        for (let i = 0; i < count; i++) {
          const res = await attemptOneImage();
          if (res.image) { mediaUrls.push(res.image); continue; }
          if (res.stop) { stop = res.stop; break; } // capacity/quota/timeout — stop spending
          // res.none: this variant never produced an image — try the next one.
        }

        if (mediaUrls.length === 0) {
          return stop ?? { text: "Не получилось сгенерировать картинку (модель не вызвала генератор). Попробуй ещё раз или упрости запрос — иногда помогает смена модели в /antigravity model." };
        }

        // Persist the prompt (with count + refs) so Recreate/Edit can reproduce the
        // whole batch. If the store write fails, fall back to a caption with no
        // buttons (they'd dangle on a missing id).
        const id = await saveImagePrompt(payload, aspect, count, refPaths).catch((e) => {
          api.logger?.warn?.(`antigravity: could not store image prompt: ${e}`);
          return null;
        });
        const reply = id
          ? buildImageReply(payload, aspect, count, mediaUrls, id)
          : { text: imageCaption(payload, aspect, count), ...(mediaUrls.length === 1 ? { mediaUrl: mediaUrls[0] } : { mediaUrls }) };
        // Partial batch (asked for N, got fewer): deliver what we have and prepend a
        // short note above the tap-to-copy command.
        if (mediaUrls.length < count) {
          const note = stop
            ? `⚠️ Готово ${mediaUrls.length} из ${count} — дальше не вышло: ${plainText(stop.text).split("\n")[0]}`
            : `⚠️ Готово ${mediaUrls.length} из ${count} (часть не удалась — модель не вызвала генератор).`;
          reply.text = `${note}\n${reply.text}`;
        }
        // Recreate after OpenClaw pruned the inbound media: the original photo is
        // gone, so this run was text-only — say so instead of pretending.
        if (refLost) {
          reply.text = `⚠️ Исходное фото-референс уже недоступно (вычищено из хранилища) — сгенерировано только по тексту. Отправь команду с фото заново, чтобы вернуть референс.\n${reply.text}`;
        }
        return reply;
      } finally {
        if (staged) await rm(staged.dir, { recursive: true, force: true }).catch(() => {});
      }
    }

    // Shared entry for both image command shapes: parse the optional `16:9` aspect
    // prefix and `x3` / "3 изображения" count prefix, claim any photo attached to
    // this command (via the message_received hook), then queue the generation.
    async function runImageCommand(ctx, payload, defaultModel) {
      if (!payload) return asHintReply(IMAGE_HINT_MD);
      const { aspect: inlineAspect, rest: afterAspect } = parseAspectPrefix(payload);
      if (!afterAspect) return asHintReply(IMAGE_HINT_MD);
      const { count, rest } = parseCountPrefix(afterAspect);
      if (!rest) return asHintReply(IMAGE_HINT_MD);
      // Same queue cap the Recreate button has: with counts a single command can be
      // ×MAX_IMAGE_COUNT quota units, so don't let impatient re-sends stack an hour
      // of serialized generations (and Google image quota) behind one chat.
      if (imageQueueDepth >= 2) {
        return { text: "⏳ Уже генерирую предыдущие запросы — дождись их и отправь команду ещё раз." };
      }
      const aspect = inlineAspect ?? await getImageAspect();
      const refPaths = await awaitReferenceFor(ctx.senderId, ctx.from);
      return doImageQueued(rest, defaultModel, aspect, count, refPaths);
    }

    // ---- inbound hook: capture a photo attached to an /antigravity_image command.
    // A plugin command handler's ctx has no media, so we record the downloaded
    // image path(s) here and the command handler claims the sighting via
    // awaitReferenceFor. registerHook lands in OpenClaw's INTERNAL hook system,
    // whose event keys are `type` / `type:action` — so the key is
    // "message:received" (NOT "message_received", that name belongs to the
    // separate config-file hook runner). The internal emit fires in
    // dispatch-from-config right before the inbound turn is processed, i.e. before
    // our command executes — a photo-with-caption command takes exactly that path
    // (Telegram's native bot.command shortcut only matches text messages, not
    // captions). Fires only for our image command; everything else is a single
    // cheap regex and return.
    api.registerHook("message:received", async (event) => {
      try {
        const content = typeof event?.context?.content === "string" ? event.context.content : "";
        if (!isImageCommandText(content)) return;
        const paths = imagePathsFromEvent(event);
        const sender = event?.context?.metadata?.senderId ?? "";
        const from = event?.context?.from ?? "";
        await recordReferenceSighting(sender, from, paths);
      } catch (e) {
        api.logger?.warn?.(`antigravity: message:received hook failed: ${e?.message || e}`);
      }
    }, { name: "antigravity-image-ref-capture", description: "Capture a photo attached to /antigravity_image so the command can use it as a reference." });

    // ---- outbound adapter: the only way to deliver MEDIA (or markdown) from an
    // interactive handler. ctx.respond.reply/editMessage are text-only and plain;
    // the handler's return value is discarded beyond `.handled`. The telegram
    // ChannelOutboundAdapter's sendPayload runs the full delivery pipeline:
    // markdown→HTML caption, photo upload, presentation buttons attached to the
    // photo (opaque tgcb1: callback encoding included). Verified against the
    // OpenClaw dist on prod (outbound-adapter / delivery / send modules). ----
    async function sendPayloadToChat(ctx, reply) {
      try {
        const adapter = await api.runtime?.channel?.outbound?.loadAdapter?.("telegram");
        if (!adapter?.sendPayload) return false;
        const cfg = api.runtime?.config?.current?.();
        const to = String(ctx.callback?.chatId ?? "");
        if (!cfg || !to) return false;
        await adapter.sendPayload({
          cfg,
          to,
          text: reply.text ?? "",
          accountId: ctx.accountId ?? undefined,
          threadId: ctx.threadId ?? undefined,
          payload: reply,
        });
        return true;
      } catch (e) {
        api.logger?.warn?.(`antigravity: outbound adapter send failed: ${e?.message || e}`);
        return false;
      }
    }

    // ---- edit-in-place navigation for button taps ----
    api.registerInteractiveHandler({
      channel: "telegram",
      namespace: NS,
      handler: async (ctx) => {
        // Fail-closed: only an explicitly authorized sender may drive the panel.
        // A missing ctx.auth is treated as unauthorized (and logged) rather than
        // silently allowed — if a framework version stops passing auth context,
        // buttons go dead with a clear log line instead of opening up to anyone.
        if (ctx.auth?.isAuthorizedSender !== true) {
          if (!ctx.auth) api.logger?.warn?.("antigravity: callback arrived without ctx.auth — denying (fail-closed)");
          return { handled: false };
        }
        const payload = (ctx.callback?.payload ?? "").trim();
        const defaultModel = await getDefaultModel();
        // Rewrite the tapped message in place; fall back to a fresh reply if the
        // edit can't be applied (e.g. Telegram "message is not modified").
        const show = async (menu) => {
          const buttons = asEditButtons(menu);
          const text = plainText(menu.text);
          try {
            await ctx.respond.editMessage({ text, buttons });
          } catch {
            try { await ctx.respond.reply({ text, buttons }); } catch { /* give up */ }
          }
        };

        if (payload === "models") {
          await show(await menuModels(defaultModel));
        } else if (payload === "aspect") {
          await show(menuAspect(await getImageAspect()));
        } else if (payload.startsWith("ar:")) {
          const value = payload.slice(3);
          if (value === "auto") {
            await setImageAspect(null);
            await show(menuMainNote(defaultModel, "✅ Формат картинок: авто"));
          } else if (ASPECT_RATIOS.includes(value)) {
            await setImageAspect(value);
            await show(menuMainNote(defaultModel, `✅ Формат картинок: ${value}`));
          } else {
            await show(menuAspect(await getImageAspect()));
          }
        } else if (payload.startsWith("rc:") || payload.startsWith("ed:")) {
          const id = payload.slice(3);
          const entry = await getImagePrompt(id);
          if (!entry) {
            try { await ctx.respond.reply({ text: "Кнопка устарела (запрос уже вычищен из истории) — отправь команду заново." }); } catch { /* ignore */ }
            return { handled: true };
          }
          const aspect = entry.ar || null;
          const count = entry.n || 1;
          const refs = Array.isArray(entry.refs) ? entry.refs : [];
          if (payload.startsWith("ed:")) {
            // Edit: hand the user the exact command to tweak. adapter.sendPayload
            // renders markdown -> the backticked command is tap-to-copy; if the
            // adapter is unavailable, fall back to plain respond.reply (copyable
            // via long-press, just not one-tap).
            const cmd = imageCommandFor(entry.p, aspect, count);
            const sent = await sendPayloadToChat(ctx, { text: `✏️ Скопируй, поправь и отправь:\n\`${cmd}\`` });
            if (!sent) {
              try { await ctx.respond.reply({ text: `✏️ Скопируй, поправь и отправь:\n${cmd}` }); } catch { /* ignore */ }
            }
          } else {
            // Recreate: ack instantly, generate in the background (up to ~3.5 min —
            // must not block the callback dispatch), deliver the new photo via the
            // outbound adapter (respond.* can't send media). Cap the queue so
            // impatient repeated taps don't stack an hour of generations.
            if (imageQueueDepth >= 2) {
              try { await ctx.respond.reply({ text: "⏳ Уже генерирую — дождись текущей картинки." }); } catch { /* ignore */ }
              return { handled: true };
            }
            try { await ctx.respond.reply({ text: `🎨 Генерирую заново${count > 1 ? ` ×${count}` : ""}${aspect ? ` (${aspect})` : ""}…` }); } catch { /* ignore */ }
            const model = defaultModel;
            (async () => {
              const reply = await doImageQueued(entry.p, model, aspect, count, refs);
              const sent = await sendPayloadToChat(ctx, reply);
              if (!sent) {
                const note = (reply.mediaUrl || reply.mediaUrls)
                  ? "Картинка сгенерирована, но не удалось отправить её из кнопки — отправь команду заново."
                  : plainText(reply.text || "Не получилось сгенерировать картинку.");
                try { await ctx.respond.reply({ text: note }); } catch { /* ignore */ }
              }
            })().catch((e) => api.logger?.error?.(`antigravity: recreate failed: ${e?.message || e}`));
          }
        } else if (payload.startsWith("m:")) {
          const name = payload.slice(2);
          const models = await readModels();
          const match = models.find((m) => m === name) || models.find((m) => m.toLowerCase() === name.toLowerCase());
          if (match) {
            await setDefaultModel(match);
            await show(menuMainNote(match, `✅ Модель: ${match}`));
          } else {
            await show(menuMainNote(defaultModel, `Не знаю модель "${name}".`));
          }
        } else if (payload === "status") {
          await show(menuBack(statusText(defaultModel, await getImageAspect())));
        } else if (payload === "ask") {
          await show(menuBack(ASK_HINT));
        } else if (payload === "image") {
          await show(menuBack(IMAGE_HINT));
        } else if (payload === "reset") {
          await setDefaultModel(null);
          await show(menuMainNote(null, "Сброшено — agy использует свою модель по умолчанию."));
        } else {
          // "menu" or anything unknown -> main menu. Edit-in-place is plain text, so
          // omit the command lines (they'd render as a non-monospace copy); the
          // commands live on the real `/antigravity` render, where they're tap-to-copy.
          await show(menuMain(defaultModel, { withCommands: false }));
        }
        return { handled: true };
      },
    });

    api.registerCommand({
      name: "antigravity",
      description: "Antigravity (agy): пульт управления — модель, статус, вопрос, картинка.",
      acceptsArgs: true,
      handler: async (ctx) => {
        const raw = (ctx.args ?? "").trim();
        const [subRaw] = raw.split(/\s+/);
        const sub = (subRaw ?? "").toLowerCase();
        const payload = raw.slice(subRaw ? raw.indexOf(subRaw) + subRaw.length : 0).trim();
        const defaultModel = await getDefaultModel();

        // ---- navigation (instant, no agy); buttons edit in place on tap ----
        if (!sub || sub === "menu" || sub === "help" || sub === "start") {
          return asReply(menuMain(defaultModel));
        }

        if (sub === "model") {
          if (!payload) return asReply(await menuModels(defaultModel));
          const models = await readModels();
          const match = models.find((m) => m.toLowerCase() === payload.toLowerCase());
          if (!match) {
            const menu = await menuModels(defaultModel);
            return asReply({ ...menu, text: `Не знаю модель "${payload}". Выбери из списка:` });
          }
          await setDefaultModel(match);
          return asReply(menuMainNote(match, `✅ Модель: ${match}`));
        }

        if (sub === "reset") {
          await setDefaultModel(null);
          return asReply(menuMainNote(null, "Сброшено — agy использует свою модель по умолчанию."));
        }

        if (sub === "status") {
          return asReply(menuBack(statusText(defaultModel, await getImageAspect())));
        }

        if (sub === "aspect") {
          if (!payload) return asReply(menuAspect(await getImageAspect()));
          const value = payload.toLowerCase() === "auto" || payload.toLowerCase() === "авто" ? null : payload;
          if (value && !ASPECT_RATIOS.includes(value)) {
            return asReply({ ...menuAspect(await getImageAspect()), text: `Не знаю формат "${payload}". Выбери из списка:` });
          }
          await setImageAspect(value);
          return asReply(menuMainNote(defaultModel, `✅ Формат картинок: ${value || "авто"}`));
        }

        // ---- agy-backed actions (slow == agy's own latency, no LLM on top) ----
        if (sub === "ping") {
          const r = await runAgy([...modelArgs(defaultModel), "-p", "Reply with exactly: OK"], { timeoutMs: 30_000 });
          if (r.ok && /ok/i.test(r.out)) return { text: "✅ agy авторизован и отвечает." };
          if (r.timedOut) return { text: "⏳ agy отвечает медленно — попробуй позже." };
          return { text: "❌ agy не отвечает / нет логина. Нужен scripts/login.sh на сервере." };
        }

        if (sub === "ask") {
          if (!payload) return asHintReply(ASK_HINT_MD);
          return doAsk(payload, defaultModel);
        }

        if (sub === "image") {
          return runImageCommand(ctx, payload, defaultModel);
        }

        if (sub === "continue") {
          if (!payload) return asReply(menuBack("Отправь текст: /antigravity continue <текст>"));
          const r = await runAgy([...modelArgs(defaultModel), "-c", "-p", payload], { timeoutMs: 120_000 });
          if (r.ok && r.out) return { text: r.out };
          if (r.timedOut) return { text: "⏳ agy думал слишком долго." };
          return { text: `Не удалось продолжить.${r.err ? `\n${r.err.slice(0, 400)}` : ""}` };
        }

        // Unknown subcommand -> menu.
        return asReply(menuMain(defaultModel));
      },
    });

    // ---- single-token commands: `/antigravity_ask` and `/antigravity_image` ----
    // A whole-word slash command is one clickable token in Telegram, so tapping it
    // in a message drops `/antigravity_ask ` straight into the input for the user
    // to type after — unlike `/antigravity ask ...`, where only `/antigravity` is
    // the token and the ` ask ...` tail is plain text. Same agy-backed behavior.
    api.registerCommand({
      name: "antigravity_ask",
      description: "Antigravity (agy): задать вопрос — /antigravity_ask <твой вопрос>.",
      acceptsArgs: true,
      handler: async (ctx) => {
        const payload = (ctx.args ?? "").trim();
        const defaultModel = await getDefaultModel();
        if (!payload) return asHintReply(ASK_HINT_MD);
        return doAsk(payload, defaultModel);
      },
    });

    api.registerCommand({
      name: "antigravity_image",
      description: "Antigravity (agy): сгенерировать картинку — /antigravity_image <описание>.",
      acceptsArgs: true,
      handler: async (ctx) => {
        const payload = (ctx.args ?? "").trim();
        const defaultModel = await getDefaultModel();
        return runImageCommand(ctx, payload, defaultModel);
      },
    });

    api.logger?.info?.(`antigravity plugin registered (agy: ${AGY_BIN}, edit-in-place)`);
  },
});
