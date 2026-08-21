#!/usr/bin/env node
// Conformance CLI — `pnpm --filter @nodal-agents/llm conformance -- <args>`
//
// Adding a model to the catalogue should mean running this against it and
// reading the table. Two runs of the same suite, weeks apart, also catch a
// provider drifting under a stable model id — the failure mode that a one-off
// audit document cannot see.
//
// Examples
//   pnpm --filter @nodal-agents/llm conformance -- \
//     --provider openrouter --model z-ai/glm-5.2 --key-file ./key.txt
//
//   pnpm --filter @nodal-agents/llm conformance -- \
//     --provider anthropic --model claude-sonnet-5 --json report.json
//
// The key is read from --key, --key-file, or the provider's usual env var —
// never echoed, never written into the JSON report.

import { readFileSync, writeFileSync } from 'node:fs';
import { PROVIDER_NAMES } from '../types.ts';
import type { ProviderName } from '../types.ts';
import { runConformance, formatReport } from './run.ts';

function arg(name: string): string | undefined {
  const i = process.argv.indexOf(`--${name}`);
  return i !== -1 ? process.argv[i + 1] : undefined;
}

function fail(msg: string): never {
  console.error(`\n❌ ${msg}\n`);
  process.exit(1);
}

const provider = arg('provider') as ProviderName | undefined;
const model = arg('model');
if (!provider || !model) {
  fail(
    'Usage: --provider <nom> --model <id> [--key <clé> | --key-file <chemin>] ' +
      '[--base-url <url>] [--only <ids,séparés,par,virgules>] [--json <fichier>]\n' +
      `   providers: ${PROVIDER_NAMES.join(', ')}`,
  );
}
if (!PROVIDER_NAMES.includes(provider)) {
  fail(`Provider inconnu: "${provider}". Attendu: ${PROVIDER_NAMES.join(', ')}`);
}

/**
 * Prefix each provider's keys are known to carry.
 *
 * A key file often holds SEVERAL labelled keys. Taking "the first thing that
 * looks like a key" silently picks the wrong one, and the whole run comes back
 * as `401 Missing Authentication header` on every probe — loud, but pointing at
 * the model instead of at the mistake. Matching the prefix removes the trap.
 * Providers with no distinctive prefix fall through to the generic scan.
 */
const KEY_PREFIX: Partial<Record<ProviderName, RegExp>> = {
  openrouter: /\bsk-or-[A-Za-z0-9_-]{16,}\b/,
  anthropic: /\bsk-ant-[A-Za-z0-9_-]{16,}\b/,
  groq: /\bgsk_[A-Za-z0-9_-]{16,}\b/,
  openai: /\bsk-(?!ant-|or-)[A-Za-z0-9_-]{16,}\b/,
};

/** Read the key for THIS provider from a file that may hold several. Never printed. */
function readKeyFile(path: string, forProvider: ProviderName): string {
  const raw = readFileSync(path, 'utf-8');
  const specific = KEY_PREFIX[forProvider];
  if (specific) {
    const m = raw.match(specific);
    if (m) return m[0];
    fail(
      `Aucune clé ${forProvider} dans ${path}. Le fichier contient peut-être la clé d'un ` +
        `AUTRE provider — la prendre donnerait un 401 sur chaque sonde, ce qui accuserait ` +
        `le modèle à tort.`,
    );
  }
  const m = raw.match(/\b(sk-[A-Za-z0-9_-]{16,}|[A-Za-z0-9_-]{32,})\b/);
  if (!m) fail(`Aucune clé reconnaissable dans ${path}`);
  return m[0];
}

const keyFile = arg('key-file');
const apiKey = arg('key') ?? (keyFile ? readKeyFile(keyFile, provider) : undefined);
const only = arg('only')
  ?.split(',')
  .map((s) => s.trim())
  .filter(Boolean);

console.log(`\n▶ Conformité — ${provider} / ${model}`);
if (!apiKey) console.log('  (aucune clé passée — le provider lira sa variable d’environnement)');

const report = await runConformance({
  config: {
    provider,
    model,
    ...(apiKey ? { apiKey } : {}),
    ...(arg('base-url') ? { baseURL: arg('base-url') } : {}),
  },
  ...(only ? { only } : {}),
  onResult: (r) => {
    const icon = { pass: '✅', fail: '❌', unsupported: '➖', inconclusive: '⚠️ ' }[r.status];
    console.log(`  ${icon} ${r.label}`);
  },
});

console.log(formatReport(report));

const jsonPath = arg('json');
if (jsonPath) {
  writeFileSync(jsonPath, JSON.stringify(report, null, 2), 'utf-8');
  console.log(`  Rapport JSON: ${jsonPath}\n`);
}

// Exit non-zero on a real failure OR on a contradiction with the declared
// matrix — so this can gate a model's addition in CI once keys are available.
// `unsupported` and `inconclusive` never fail the run: the first is a legitimate
// answer, the second means the probe could not decide and must not masquerade
// as a verdict.
process.exit(report.summary.fail > 0 || report.contradictions.length > 0 ? 1 : 0);
