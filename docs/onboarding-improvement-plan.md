# Onboarding improvement plan

Status: **implemented** (shipped — this is now a retrospective design record).
Target achieved: a new OpenClaw host goes from `git clone` (or the `bootstrap.sh`
one-liner) to a working `/antigravity` with **one command**, resilient to agy
version drift, with the fragile TUI key-walk demoted to a fallback. The stages
below describe the design as built (`scripts/setup.sh`, `scripts/preflight.sh`,
`scripts/login.sh` v2 with `seed_agy_config`).

## Background: what was verified empirically (2026-07-07, on a test host)

A/B test on clean throwaway HOMEs (`agy -i` in tmux, prod profile untouched):

- The pre-auth flow is: `Select login method` menu → Enter → auth URL →
  inline `authorization code...` field. No theme/telemetry/trust screens before
  the code; those are **post-auth**.
- Seeding `~/.gemini/settings.json` with `security.auth.selectedType:
  "oauth-personal"` does **NOT** skip the login-method menu (refuted — agy writes
  that key after login but does not read it as a pre-selection). The menu is
  stable and defaults to option 1; a single Enter proceeds.
- Post-auth onboarding state lives in files (confirmed on the live profile):
  - `~/.gemini/antigravity-cli/settings.json` → `{"enableTelemetry": false,
    "trustedWorkspaces": ["<HOME>"]}`
  - `~/.gemini/antigravity-cli/cache/onboarding.json` →
    `{"consumerOnboardingComplete": true, "onboardingComplete": true}`
  - the agy binary contains `consumerOnboardingComplete` / "failed to save
    onboarding status" strings; seeded files are accepted without error.
- **PROVEN (2026-07-07, live test).** Completing a real OAuth in a seeded temp
  HOME on a test host: after the code, agy went straight to the chat prompt in ~3s with
  **no theme / telemetry / trust screen** shown, `enableTelemetry` stayed `false`
  (not flipped back), and `agy -p` answered. The prod token was unaffected (a new
  grant did not invalidate it); the temp HOME was discarded. So the seed is the
  primary mechanism on agy 1.0.16 and the key-walk is a genuine fallback.
- No `--skip-onboarding` / headless CLI flag exists in agy 1.0.16 (binary
  strings checked; only an internal language-server `SkipOnboarding` RPC).

Design consequence: **seed is additive, the key-walk stays as fallback.** If the
seed works, the walk becomes a no-op; if not, behavior is unchanged. Either way
nothing regresses.

## Stage 0 (DONE 2026-07-07): live seed verification

Ran a seeded login on a throwaway HOME on a test host: seed → `agy -i` in tmux →
operator signed in and pasted the code → observed. Result: **no telemetry / trust
/ theme screen appeared**, agy reached the chat prompt in ~3s, `enableTelemetry`
stayed `false`, `agy -p` answered. Prod token unaffected, temp HOME discarded.
Conclusion: the seed suppresses the whole post-auth walk on agy 1.0.16; the
key-walk is now confirmed to be a fallback, not the primary path.

## Stage 1: `login.sh` v2 — seed + hardened walk

1. **`seed_agy_config()`** — runs before `agy -i`, as the service user:
   - `~/.gemini/antigravity-cli/settings.json`: merge-write (python3, not
     overwrite — preserve unknown keys) `enableTelemetry: false`, append
     `$OPENCLAW_HOME` to `trustedWorkspaces` if absent.
   - `~/.gemini/antigravity-cli/cache/onboarding.json`: create with
     `{"consumerOnboardingComplete": true, "onboardingComplete": true}` **only
     if missing** (never touch an existing one).
   - Do NOT seed `settings.json:selectedType` (refuted, useless).
   - Ownership `$OPENCLAW_USER`, dirs 700, files 600.
2. **Code entry hardening:** validate the pasted authorization code (non-empty,
   no whitespace, plausible length); re-prompt up to 3 times instead of `die` on
   a typo.
3. **URL-extraction fallback:** if the URL regex finds nothing, print the whole
   captured pane and the attach command instead of failing blind (session is
   already kept alive today; add the pane dump).
4. **Key-walk stays** (theme/telemetry/trust), unchanged logic, but each detected
   screen is logged (`onboarding screen 'telemetry' detected — walking it`), so
   a transcript shows whether the seed suppressed the screens.
5. **Post-login seed audit:** after the final `agy -p` check, re-read
   `antigravity-cli/settings.json` and warn loudly if `enableTelemetry` flipped
   to true or `trustedWorkspaces` lost the home dir (agy rewrote our seed) —
   warn-only, not fatal.
6. **Version gate:** `KNOWN_GOOD_AGY="1.0.16"`. If `agy --version` differs,
   print a warning that the onboarding automation was verified on that version
   and the attach-and-finish-manually escape hatch exists. Warn-only.

## Stage 2: `scripts/preflight.sh` — fail fast with fix hints

Read-only checks, `[ OK ]/[FAIL]/[WARN]` output like healthcheck.sh, non-zero
exit on any FAIL, each FAIL with a one-line fix hint:

- running as root; `curl`, `tmux` present (tmux → WARN if only install is
  planned, FAIL for login).
- `$OPENCLAW_BIN` exists/executable; `openclaw --version` >= 2026.6.11
  (`sort -V` compare) — the plugin SDK floor.
- service user exists, home resolves, home owned by the user.
- systemd unit `openclaw-gateway` exists (`systemctl cat`); WARN if not active.
- network: `curl -sI --max-time 5 https://accounts.google.com` → WARN only
  (login will need it; install of agy needs antigravity.google too).
- disk: >= 1 GB free in the service user's home (agy is ~170 MB + brain grows).
- `channels.telegram.capabilities.inlineButtons` is `dm`/`all` → WARN with the
  exact `openclaw config set` command otherwise.

Also invoked as the first step of setup.sh (Stage 3); usable standalone.

## Stage 3: `scripts/setup.sh` — one-command orchestrator

```
sudo scripts/setup.sh [--yes] [--skip-login] [--no-buttons]
```

Sequence (each step logged `[setup N/7] …`, idempotent, safe to re-run):

1. `ensure_deps` — auto-install missing `curl`/`tmux` via apt-get (prompt, or
   `--yes`); skipped where apt-get is absent.
2. `preflight.sh` (abort on FAIL).
3. `install.sh` (no restart yet).
4. `login.sh` v2 (skips itself if already authenticated; `--skip-login` for
   automation/CI).
5. Telegram buttons capability: if not already `dm`/`all`, ask y/N (or `--yes`)
   and then — timestamped backup of `openclaw.json` next to it → `openclaw
   config set channels.telegram.capabilities.inlineButtons dm` → `openclaw
   config validate`; restore backup on validation failure. `--no-buttons`
   skips. (This is the one step that edits host config — hence the explicit
   consent + backup + validate.)
6. `systemctl restart openclaw-gateway` + wait for `is-active` (bounded, ~30s).
   Replaces the old second `RESTART_GATEWAY=1 install.sh` pass — no reason to
   re-run the whole installer just to restart.
7. `healthcheck.sh` — the verdict. Exit code of setup.sh = healthcheck's.

Final message: "send `/antigravity` in Telegram".

`install.sh` itself stays unchanged (proven path, other docs reference it);
setup.sh is a wrapper, not a rewrite.

## Stage 4: README

- TL;DR and Install section become: `git clone … && cd gemini-claw && sudo
  scripts/setup.sh` (manual 4-step path kept below as the debugging/expert
  path — it is what setup.sh runs internally).
- New short section "Onboarding internals": what gets seeded, what the key-walk
  handles, `KNOWN_GOOD_AGY`, and the attach escape hatch
  (`sudo -u openclaw tmux -L agy-login attach -t login`).
- Files section: add `setup.sh`, `preflight.sh`.

## Stage 5: CI

`bash -n scripts/*.sh` already globs — new scripts are covered automatically.
No workflow change needed. (Optional, separate decision: add shellcheck as a
non-blocking job; not part of this plan.)

## Stage 6: testing & rollout

On a test host (safe, since setup.sh is idempotent and everything is already
installed):

1. `preflight.sh` standalone — read-only, expect all OK/WARN-buttons-already-set.
2. `seed_agy_config()` unit-style test on a temp HOME: seeds land, merge
   preserves foreign keys, re-run is a no-op. No OAuth needed.
3. Full `setup.sh --yes` on a test host: install no-ops, login self-skips (already
   authenticated), buttons already `dm` → skip, gateway restart + healthcheck
   6/6. This exercises every branch except a fresh login.
4. Fresh-login path: verified on the next real new-host install (or Stage 0
   live test, if run).

Rollback: all changes are additive new scripts + a v2 of login.sh; `git revert`
of one commit restores the current proven flow. Tag the pre-change commit as the
checkpoint per the hardening convention.

## Risks

| Risk | Mitigation |
|------|------------|
| agy update changes TUI wording → key-walk misses screens | seed makes screens unlikely; version gate warns; attach escape hatch documented; walk logs which screens it saw |
| agy changes seed file schema / ignores seeds | seed is additive; walk still handles everything; post-login audit detects a flipped telemetry value |
| settings.json merge clobbers foreign keys | python3 read-merge-write, never blind overwrite; unit test in Stage 6.2 |
| setup.sh edits openclaw.json (buttons) on a host we don't own the policy for | explicit consent prompt, timestamped backup, `config validate`, `--no-buttons` opt-out |
| gateway restart at a bad moment on a busy host | restart only in setup.sh step 5 (operator-invoked), bounded wait, healthcheck right after |

## Explicitly out of scope

- npm / ClawHub / marketplace publishing (decided against — native install
  copies only the JS; this plugin is inert without agy + OAuth + PATH + cache).
- "capture-next-message" input flow (blocked by plugin trust tier — see
  `docs/plugin-internals.md` "Command & rendering model").
- Patching agy or OpenClaw core.
