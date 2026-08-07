// Conformance runner — drive every probe against one model and report.
//
// The report is the product: a table a human reads in ten seconds, plus a JSON
// artefact two runs can be diffed on. Adding a model to the catalogue means
// running this and reading the table; a provider that drifts shows up as a
// probe flipping from pass to fail between two runs of the SAME suite.

import { createLlmClient } from '../client.ts';
import { CAPABILITY_MATRIX } from '../providers/registry.ts';
import type { ProviderConfig, ProviderName } from '../types.ts';
import { ALL_PROBES, type Probe, type ProbeResult, type ProbeStatus } from './probes.ts';

export interface ConformanceRunOptions {
  config: ProviderConfig;
  /** Subset of probe ids. Omit to run everything. */
  only?: readonly string[];
  /** Called as each probe settles, so a long run prints progressively. */
  onResult?: (result: ProbeResult) => void;
}

export interface ConformanceReport {
  provider: ProviderName;
  model: string;
  /**
   * The harness code path actually exercised — `providers/<harness>.ts`.
   *
   * Stated explicitly because it is the single most misread thing about these
   * results: running GLM 5.2 through OpenRouter exercises the `openrouter`
   * harness, NOT `deepseek.ts` or any other. A matrix of "12 harnesses" is only
   * complete when each has been driven with its own native credentials.
   */
  harness: ProviderName;
  declared: (typeof CAPABILITY_MATRIX)[ProviderName];
  results: ProbeResult[];
  summary: Record<ProbeStatus, number>;
  /** Probes whose outcome contradicts CAPABILITY_MATRIX. The audit-relevant list. */
  contradictions: string[];
  startedAt: string;
  durationMs: number;
}

/** Run one probe, converting an unexpected throw into a verdict rather than
 *  losing the whole run to it. */
async function safeRun(probe: Probe, ctx: Parameters<Probe['run']>[0]): Promise<ProbeResult> {
  try {
    return await probe.run(ctx);
  } catch (e) {
    return {
      id: probe.id,
      label: probe.label,
      status: 'inconclusive',
      detail: `La sonde elle-même a échoué: ${e instanceof Error ? e.message : String(e)}`,
    };
  }
}

export async function runConformance(opts: ConformanceRunOptions): Promise<ConformanceReport> {
  const startedAt = new Date().toISOString();
  const t0 = Date.now();

  const client = createLlmClient(opts.config);
  const declared = CAPABILITY_MATRIX[opts.config.provider];
  const ctx = { client, declared };

  const selected = opts.only?.length
    ? ALL_PROBES.filter((p) => opts.only!.includes(p.id))
    : ALL_PROBES;

  const results: ProbeResult[] = [];
  for (const probe of selected) {
    // A probe gated on a capability the matrix denies is reported as skipped
    // rather than run — asking a non-streaming provider to stream proves
    // nothing and costs a call.
    if (probe.requires && !declared[probe.requires]) {
      const skipped: ProbeResult = {
        id: probe.id,
        label: probe.label,
        status: 'unsupported',
        detail: `Non déclaré par la matrice (${probe.requires}: false) — sonde non exécutée.`,
      };
      results.push(skipped);
      opts.onResult?.(skipped);
      continue;
    }
    const r = await safeRun(probe, ctx);
    results.push(r);
    opts.onResult?.(r);
  }

  const summary: Record<ProbeStatus, number> = {
    pass: 0,
    fail: 0,
    unsupported: 0,
    inconclusive: 0,
  };
  for (const r of results) summary[r.status] += 1;

  // A contradiction is a probe that OBSERVED something the matrix denies, or
  // failed something the matrix promises. This is what makes the suite an audit
  // tool rather than a smoke test.
  const contradictions: string[] = [];
  const byId = new Map(results.map((r) => [r.id, r]));
  const cachingProbe = byId.get('prompt-caching');
  if (cachingProbe?.status === 'pass' && !declared.promptCaching) {
    contradictions.push(
      'prompt-caching: du cache est observé alors que CAPABILITY_MATRIX déclare promptCaching:false',
    );
  }
  if (cachingProbe?.status === 'fail' && declared.promptCaching) {
    contradictions.push(
      'prompt-caching: la matrice promet promptCaching:true, aucun token caché observé',
    );
  }
  for (const [probeId, cap] of [
    ['tool-call-single', 'toolUse'],
    ['streaming', 'streaming'],
    ['structured-output', 'structuredOutputs'],
  ] as const) {
    const r = byId.get(probeId);
    if (r?.status === 'fail' && declared[cap]) {
      contradictions.push(`${probeId}: la matrice promet ${cap}:true, la sonde échoue`);
    }
  }

  return {
    provider: opts.config.provider,
    model: opts.config.model,
    harness: opts.config.provider,
    declared,
    results,
    summary,
    contradictions,
    startedAt,
    durationMs: Date.now() - t0,
  };
}

// ─── Rendering ────────────────────────────────────────────────────────────────

const ICON: Record<ProbeStatus, string> = {
  pass: '✅',
  fail: '❌',
  unsupported: '➖',
  inconclusive: '⚠️ ',
};

/** Human-readable report. Written to stdout by the CLI. */
export function formatReport(report: ConformanceReport): string {
  const lines: string[] = [];
  lines.push('');
  lines.push(`  ${report.model}`);
  lines.push(`  harnais exercé : packages/llm/src/providers/${report.harness}.ts`);
  lines.push(
    `  matrice déclarée : ` +
      Object.entries(report.declared)
        .map(([k, v]) => `${k}=${v}`)
        .join(' · '),
  );
  lines.push('');
  for (const r of report.results) {
    lines.push(`  ${ICON[r.status]} ${r.label.padEnd(46)} ${r.detail}`);
  }
  lines.push('');
  lines.push(
    `  ${report.summary.pass} conformes · ${report.summary.fail} échecs · ` +
      `${report.summary.unsupported} non supportés · ${report.summary.inconclusive} non concluants ` +
      `(${(report.durationMs / 1000).toFixed(1)} s)`,
  );
  if (report.contradictions.length > 0) {
    lines.push('');
    lines.push('  ⚠️  CONTRADICTIONS AVEC CAPABILITY_MATRIX');
    for (const c of report.contradictions) lines.push(`     - ${c}`);
  }
  lines.push('');
  return lines.join('\n');
}
