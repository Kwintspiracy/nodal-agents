#!/usr/bin/env node
// check-no-secrets.mjs — fail the build if a hardcoded secret is committed.
//
// SEC-1 (audit sécu 2026-07-07): a real 256-bit WORKER_SECRET was committed to
// a tracked test helper and reached public `main`. The value was dehardcoded
// (read from ~/.nodalai/config.json at runtime) — this guard stops the class of
// mistake from recurring, wired into CI so it catches a secret BEFORE it lands
// on the public repo (a local pre-commit hook is bypassable and unshared).
//
// It detects the SHAPE of a hardcoded secret, not a specific value, so nothing
// sensitive lives in this file:
//   1. a secret-named symbol assigned a high-entropy literal (hex >=32 / long
//      base64), e.g. `const WORKER_SECRET = '<64 hex>'`;
//   2. a well-known provider key prefix with a real-length body (sk-ant-, sk-,
//      ghp_, github_pat_, xox[bp]-, AKIA...).
// A line carrying `secrets:allow` is skipped (escape hatch for docs/examples).
//
// Usage: node scripts/check-no-secrets.mjs   (exit 1 on any finding)

import { execSync } from 'node:child_process';
import { readFileSync, statSync } from 'node:fs';

const repoRoot = process.cwd();
const NUL = String.fromCharCode(0);

// Files we never scan: this scanner (it names the patterns), lockfiles, and
// anything non-text/generated. git ls-files already excludes node_modules/dist.
const SKIP = [
  /(^|\/)scripts\/check-no-secrets\.mjs$/,
  /(^|\/)pnpm-lock\.yaml$/,
  /\.(png|jpg|jpeg|gif|webp|ico|pdf|woff2?|ttf|eot|mp4|zip|tgz|lock)$/i,
  /(^|\/)(dist|\.next|out|coverage)\//,
];

// Rule 1 — a secret-named symbol next to a high-entropy quoted literal.
const SECRET_KEYWORD = /(worker_secret|auth_secret|api[_-]?key|apikey|secret|token|password)/i;
// A quoted literal that is pure hex (>=32) or a long base64-ish blob (>=40 with
// mixed classes) — short/obvious test fakes ('sk-secret123', 'fake') don't match.
const HIGH_ENTROPY_LITERAL = /['"`]([A-Fa-f0-9]{32,}|[A-Za-z0-9+/_-]{40,})['"`]/;

// Rule 2 — real provider key prefixes with a plausible body length.
const PROVIDER_KEY =
  /\b(sk-ant-[A-Za-z0-9_-]{20,}|sk-[A-Za-z0-9]{40,}|ghp_[A-Za-z0-9]{30,}|gho_[A-Za-z0-9]{30,}|github_pat_[A-Za-z0-9_]{40,}|xox[bp]-[A-Za-z0-9-]{20,}|AKIA[0-9A-Z]{16})\b/;

function looksBase64Entropy(s) {
  // A 40+ char base64-ish literal is only suspicious if it mixes letters AND
  // digits (a plain lowercase word or a long path won't have digits).
  return /[0-9]/.test(s) && /[A-Za-z]/.test(s);
}

const tracked = execSync('git ls-files', { cwd: repoRoot, encoding: 'utf8' })
  .split('\n')
  .map((f) => f.trim())
  .filter(Boolean)
  .filter((f) => !SKIP.some((re) => re.test(f)));

const findings = [];

for (const file of tracked) {
  let size;
  try {
    size = statSync(file).size;
  } catch {
    continue;
  }
  if (size > 2_000_000) continue; // skip big/binary blobs
  let text;
  try {
    text = readFileSync(file, 'utf8');
  } catch {
    continue;
  }
  if (text.indexOf(NUL) !== -1) continue; // skip binary (contains a null byte)

  const lines = text.split('\n');
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    if (/secrets:allow/.test(line)) continue;

    const provider = line.match(PROVIDER_KEY);
    if (provider) {
      findings.push({
        file,
        line: i + 1,
        why: `provider key literal (${provider[1].slice(0, 6)}...)`,
      });
      continue;
    }

    if (SECRET_KEYWORD.test(line)) {
      const lit = line.match(HIGH_ENTROPY_LITERAL);
      if (lit && (/^[A-Fa-f0-9]{32,}$/.test(lit[1]) || looksBase64Entropy(lit[1]))) {
        findings.push({
          file,
          line: i + 1,
          why: `secret-named symbol assigned a high-entropy literal`,
        });
      }
    }
  }
}

if (findings.length > 0) {
  console.error(`\nHardcoded secret(s) detected (${findings.length}):\n`);
  for (const f of findings) {
    console.error(`  ${f.file}:${f.line} — ${f.why}`);
  }
  console.error(
    `\nDo NOT commit secrets. Read them from config/env at runtime. If this is a\n` +
      `false positive (a hash, a fixture), append \`secrets:allow\` to the line.\n`,
  );
  process.exit(1);
}

console.log(`No hardcoded secrets found (${tracked.length} tracked files scanned).`);
