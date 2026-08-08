// compare.ts — a run against its baseline.
//
// Pure: takes two sets of metrics, returns the diff. Kept free of file IO so it
// is testable without a fixture directory, and so the same function serves the
// CLI and any future report surface.

import type { Metric, MetricDiff, SectionDiff, SectionResult, Verdict } from './types';

function verdictFor(before: number | null, after: number | null, m: Metric | null): Verdict {
  if (before === null) return 'new';
  if (after === null) return 'gone';
  if (before === after) return 'unchanged';
  if (!m) return 'unchanged';
  if (m.direction === 'exact') return 'regressed';
  const better = m.direction === 'lower-is-better' ? after < before : after > before;
  return better ? 'improved' : 'regressed';
}

/**
 * Diff one section's metrics against its baseline.
 *
 * A metric that DISAPPEARED is reported (`gone`) rather than ignored: a section
 * that silently stops measuring something looks identical to one where the
 * number went to zero, and the second is the interesting case.
 */
export function diffSection(
  label: string,
  current: SectionResult,
  baseline: readonly Metric[] | null,
): SectionDiff {
  const byId = new Map((baseline ?? []).map((m) => [m.id, m]));
  const diffs: MetricDiff[] = [];

  for (const m of current.metrics) {
    const before = byId.get(m.id)?.value ?? null;
    const verdict = verdictFor(before, m.value, m);
    diffs.push({
      metricId: m.id,
      label: m.label,
      unit: m.unit,
      before,
      after: m.value,
      delta: before === null ? null : m.value - before,
      verdict,
      ...(m.detail && m.detail.length > 0 ? { detail: m.detail } : {}),
    });
    byId.delete(m.id);
  }

  for (const [, m] of byId) {
    diffs.push({
      metricId: m.id,
      label: m.label,
      unit: m.unit,
      before: m.value,
      after: null,
      delta: null,
      verdict: 'gone',
    });
  }

  return {
    sectionId: current.sectionId,
    label,
    diffs,
    // A section that could not run counts as regressed. Treating it as "no
    // change" is how a broken measurement becomes invisible.
    regressed: Boolean(current.error) || diffs.some((d) => d.verdict === 'regressed'),
    ...(current.error ? { error: current.error } : {}),
  };
}
