#!/usr/bin/env bash
# Fail if any tracked / staged / untracked text file looks like it contains a
# credential, so no AI Pro OAuth token, key, or bot token ever gets committed.
# Run in CI and locally before pushing.
set -euo pipefail

ROOT="$(git rev-parse --show-toplevel)"
cd "$ROOT"

tmp_files="$(mktemp "${TMPDIR:-/tmp}/gemini-claw-secret-files.XXXXXX")"
tmp_findings="$(mktemp "${TMPDIR:-/tmp}/gemini-claw-secret-findings.XXXXXX")"
trap 'rm -f "$tmp_files" "$tmp_findings"' EXIT

{
  git ls-files
  git diff --cached --name-only --diff-filter=ACMRT
  git ls-files -o --exclude-standard
} | sort -u > "$tmp_files"

while IFS= read -r file; do
  [ -f "$file" ] || continue
  LC_ALL=C grep -Iq . "$file" || continue

  perl -ne '
    BEGIN {
      @patterns = (
        ["private-key", qr/-----BEGIN (?:RSA |DSA |EC |OPENSSH |PGP )?PRIVATE KEY-----/],
        ["github-token", qr/\b(?:ghp|gho|ghu|ghs|ghr)_[A-Za-z0-9_]{20,}\b/],
        ["github-pat", qr/\bgithub_pat_[A-Za-z0-9_]{30,}\b/],
        ["openai-key", qr/\bsk-(?:proj-)?[A-Za-z0-9_-]{20,}\b/],
        ["anthropic-key", qr/\bsk-ant-[A-Za-z0-9_-]{20,}\b/],
        ["perplexity-key", qr/\bpplx-[A-Za-z0-9_-]{20,}\b/],
        ["slack-token", qr/\bxox[baprs]-[A-Za-z0-9-]{20,}\b/],
        ["aws-access-key", qr/\bAKIA[0-9A-Z]{16}\b/],
        ["google-api-key", qr/\bAIza[0-9A-Za-z_-]{25,}\b/],
        ["telegram-bot-token", qr/\b[0-9]{8,10}:AA[A-Za-z0-9_-]{33,}\b/],
        ["auth-header", qr/\b(?:Authorization|Bearer)\b\s*[:=]?\s*["'\'']?[A-Za-z0-9._~+\/-]{24,}/i],
        ["secret-assignment", qr/\b(?:api[_-]?key|token|secret|password|passwd)\b\s*=\s*["'\''][^"'\'']{16,}["'\'']/i],
      );
    }
    for my $pattern (@patterns) {
      if ($_ =~ $pattern->[1]) {
        chomp;
        print "$ARGV:$.: $pattern->[0]\n";
      }
    }
  ' "$file" >> "$tmp_findings"
done < "$tmp_files"

if [ -s "$tmp_findings" ]; then
  echo "Potential secrets found:" >&2
  cat "$tmp_findings" >&2
  exit 1
fi

echo "secret-scan ok"
