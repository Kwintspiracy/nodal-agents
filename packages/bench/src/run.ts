// run.ts — execute sections and diff them against their baselines.

import { execFileSync } from 'node:child_process';
import { diffSection } from './compare';
import { loadBaseline } from './baseline';
import type { Section, SectionDiff, SectionResult } from './types';

export function gitSha(): string {
  try {
    return execFileSync('git', ['rev-parse', '--short', 'HEAD'], { encoding: 'utf-8' }).trim();
  } catch {
    return 'unknown';
  }
}

/**
 * Run one section, converting a throw into a recorded error rather than losing
 * the whole run. A section that cannot measure is reported as regressed — the
 * alternative is a green run that measured nothing.
 */
export async function runSection(section: Section): Promise<SectionResult> {
  const started = Date.now();
  try {
    const metrics = await section.run();
    return { sectionId: section.id, metrics, durationMs: Date.now() - started };
  } catch (e) {
    return {
      sectionId: section.id,
      metrics: [],
      durationMs: Date.now() - started,
      error: e instanceof Error ? e.message : String(e),
    };
  }
}

export async function runSections(
  sections: readonly Section[],
): Promise<{ results: SectionResult[]; diffs: SectionDiff[] }> {
  const results: SectionResult[] = [];
  const diffs: SectionDiff[] = [];
  for (const s of sections) {
    const result = await runSection(s);
    results.push(result);
    diffs.push(diffSection(s.label, result, loadBaseline(s.id)?.metrics ?? null));
  }
  return { results, diffs };
}
