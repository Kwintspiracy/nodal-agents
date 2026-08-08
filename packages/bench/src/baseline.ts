// baseline.ts — where a measurement is remembered.
//
// One JSON file per section under `bench/baselines/`, committed. Committed on
// purpose: a baseline living only on the machine that produced it answers
// "did it change since I last ran it here", which is not the question. In the
// repo, it answers "did it change since the last accepted state", and a diff
// shows up in review next to the code that moved it.

import { readFileSync, writeFileSync, mkdirSync, existsSync, readdirSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import type { Metric, SectionResult } from './types';

const HERE = dirname(fileURLToPath(import.meta.url));
/** packages/bench/src → repo root. */
export const REPO_ROOT = join(HERE, '..', '..', '..');
export const BASELINE_DIR = join(REPO_ROOT, 'bench', 'baselines');

export interface BaselineFile {
  sectionId: string;
  /** Commit the numbers were accepted at. */
  gitSha: string;
  acceptedAt: string;
  metrics: Metric[];
}

function pathFor(sectionId: string): string {
  return join(BASELINE_DIR, `${sectionId}.json`);
}

/** Null when the section has never been accepted — reported as `new`, not 0. */
export function loadBaseline(sectionId: string): BaselineFile | null {
  const p = pathFor(sectionId);
  if (!existsSync(p)) return null;
  try {
    return JSON.parse(readFileSync(p, 'utf-8')) as BaselineFile;
  } catch {
    // A corrupt baseline must not silently become "no baseline": that would
    // turn every metric into `new` and hide a regression behind a parse error.
    throw new Error(`Baseline illisible: ${p}`);
  }
}

export function saveBaseline(result: SectionResult, gitSha: string, acceptedAt: string): string {
  mkdirSync(BASELINE_DIR, { recursive: true });
  const file: BaselineFile = {
    sectionId: result.sectionId,
    gitSha,
    acceptedAt,
    metrics: result.metrics,
  };
  const p = pathFor(result.sectionId);
  writeFileSync(p, `${JSON.stringify(file, null, 2)}\n`, 'utf-8');
  return p;
}

/** Section ids that already have an accepted baseline. */
export function knownBaselines(): string[] {
  if (!existsSync(BASELINE_DIR)) return [];
  return readdirSync(BASELINE_DIR)
    .filter((f) => f.endsWith('.json'))
    .map((f) => f.slice(0, -'.json'.length))
    .sort();
}
