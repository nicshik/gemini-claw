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
import { copyFile, unlink, readFile, writeFile, mkdir, readdir, stat } from "node:fs/promises";
import { existsSync } from "node:fs";
import { homedir } from "node:os";
import path from "node:path";

const HOME = process.env.HOME || homedir();
const GEMINI_DIR = path.join(HOME, ".gemini");
const MODELS_CACHE = path.join(GEMINI_DIR, "antigravity-models.txt");
const BRAIN_DIR = path.join(GEMINI_DIR, "antigravity-cli", "brain");
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

function statusText(defaultModel) {
  return `Модель по умолчанию: ${defaultModel || "agy (без явного выбора)"}`;
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
const IMAGE_HINT = "🖼 Введите запрос на генерацию изображения: /antigravity_image текст запроса";
const ASK_HINT_MD = "✍️ Введите вопрос: `/antigravity_ask` текст вопроса";
const IMAGE_HINT_MD = "🖼 Введите запрос на генерацию изображения: `/antigravity_image` текст запроса";

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
    async function getDefaultModel() {
      try {
        const obj = JSON.parse(await readFile(STATE_FILE, "utf8"));
        return obj && typeof obj.default_model === "string" ? obj.default_model : null;
      } catch { return null; }
    }
    async function setDefaultModel(model) {
      let obj = {};
      try { obj = JSON.parse(await readFile(STATE_FILE, "utf8")) || {}; } catch { /* new file */ }
      if (model) obj.default_model = model;
      else delete obj.default_model;
      try {
        await mkdir(GEMINI_DIR, { recursive: true });
        await writeFile(STATE_FILE, JSON.stringify(obj, null, 2));
      } catch (e) {
        api.logger?.warn?.(`antigravity: could not persist default model: ${e}`);
      }
    }
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

    async function doImage(payload, defaultModel) {
      const prompt = `Use your generate_image tool to create an image: ${payload}. Save it as an artifact.`;
      // Only accept an image produced by THIS run: capture a start time (with a
      // small clock-granularity margin) and ignore anything older, so a
      // failed/no-op generation can't resend a stale image under the new caption.
      const startMs = Date.now() - 2000;
      const r = await runAgy([...modelArgs(defaultModel), "--print-timeout", "3m", "-p", prompt], { timeoutMs: 210_000 });
      const img = await newestBrainImage(startMs);
      if (img) {
        try {
          return { text: `🖼 ${payload}`, mediaUrl: await publishBrainImage(img) };
        } catch (e) {
          api.logger?.error?.(`antigravity: publish image failed: ${e?.message || e}`);
          return { text: `🖼 Картинка сгенерирована, но не удалось подготовить её к отправке.\n${String(e?.message || e).slice(0, 200)}` };
        }
      }
      // No image produced. A 503 (image model overloaded on Google's side) is
      // transient and NOT the user's quota — check it before detectQuotaError,
      // whose "capacity exhausted" match would otherwise mislabel it as a quota.
      if (detectCapacityError(r.out || r.err)) return { text: "🕐 Модель картинок Google (Nano Banana 2 / gemini-3.1-flash-image) временно перегружена (503, MODEL_CAPACITY_EXHAUSTED) — это на стороне Google, а не твоя квота. Попробуй ещё раз через минуту-другую." };
      const quota = detectQuotaError(r.out || r.err);
      if (quota) return { text: `🚫 Квота Google на генерацию картинок исчерпана.${quotaResetSuffix(quota.reset)}\nКартинки идут по отдельной квоте (модель Nano Banana 2), не связанной с текстовыми моделями — /antigravity ask работает как обычно.` };
      if (r.timedOut) return { text: "⏳ Генерация картинки не уложилась в тайм-аут. Попробуй позже или упрости запрос." };
      return { text: `Картинку получить не удалось.${r.out ? `\n${r.out.slice(0, 400)}` : ""}${r.err ? `\n${r.err.slice(0, 200)}` : ""}` };
    }

    // ---- edit-in-place navigation for button taps ----
    api.registerInteractiveHandler({
      channel: "telegram",
      namespace: NS,
      handler: async (ctx) => {
        if (ctx.auth && ctx.auth.isAuthorizedSender === false) return { handled: false };
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
          await show(menuBack(statusText(defaultModel)));
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
          return asReply(menuBack(statusText(defaultModel)));
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
          if (!payload) return asHintReply(IMAGE_HINT_MD);
          return doImage(payload, defaultModel);
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
        if (!payload) return asHintReply(IMAGE_HINT_MD);
        return doImage(payload, defaultModel);
      },
    });

    api.logger?.info?.(`antigravity plugin registered (agy: ${AGY_BIN}, edit-in-place)`);
  },
});
