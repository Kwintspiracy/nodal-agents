// architecture.ts — one implementation of the invariant scanners, instead of 15.
//
// The invariants ARE enforced today — that is the correction to audit finding
// CODE-001, which claimed the opposite because it looked for ESLint rules and
// never for tests. But they are enforced by 15 near-identical
// `architecture.test.ts` files, each carrying its own copy of the slug list, the
// forbidden-string patterns and the directory walker.
//
// Fifteen copies means fifteen places to update when an agent is renamed, and
// fifteen chances for one to drift into being weaker than the others — a guard
// that is right in fourteen packages and wrong in the fifteenth is worse than a
// single guard, because nobody re-reads the passing ones.
//
// So the scanners live here and each package's suite becomes a call.

import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join } from 'node:path';

export interface Violation {
  file: string;
  line: number;
  text: string;
  /** Which rule fired. */
  rule: string;
}

export interface ScanOptions {
  /** Directory to walk. Usually the package's `src/`. */
  srcDir: string;
  /**
   * Directory names to skip.
   *
   * `tests` is skipped by default and that is deliberate, not laxity: a test
   * legitimately names an agent in a fixture. The cost is that a violation
   * introduced inside a test file is invisible — accepted, because the
   * alternative (annotating every fixture) makes the guard hated and disabled.
   */
  skipDirs?: readonly string[];
}

function collectTsFiles(dir: string, skip: readonly string[], acc: string[] = []): string[] {
  for (const entry of readdirSync(dir)) {
    const full = join(dir, entry);
    if (statSync(full).isDirectory()) {
      if (skip.includes(entry)) continue;
      collectTsFiles(full, skip, acc);
    } else if (entry.endsWith('.ts') || entry.endsWith('.tsx')) {
      acc.push(full);
    }
  }
  return acc;
}

const DEFAULT_SKIP = ['node_modules', 'tests', '__tests__', 'dist', '.next'] as const;

/**
 * Agent and server slugs that must never appear in shipped source.
 *
 * Invariant #1: skills, routing, team blocks and sub-agent descriptions come
 * 100 % from the DB. A slug in source means a behaviour keyed to ONE user's
 * setup, which is the thing the invariant exists to prevent.
 *
 * Kept as one list here so renaming an agent is one edit, not fifteen.
 */
export const FORBIDDEN_AGENT_SLUGS: readonly string[] = [
  'ender',
  'pavel',
  'boris',
  'jennie',
  'stanley',
  'sherlock',
  'cortex',
  'tatooine',
  'sputnik',
  'displacer',
  'alfred',
] as const;

/**
 * Strings that would put words in an agent's mouth.
 *
 * Invariant #2: the LLM speaks or the runner stays silent. Platform UI
 * describing what an ACTION does is exempt — that is why the list is specific
 * phrases rather than "any French or English sentence".
 */
export const FORBIDDEN_USER_FACING: readonly RegExp[] = [
  /\bSorry\b/,
  /\bDésolé\b/,
  /\bVoici votre résultat\b/,
  /\bJe ne peux pas\b/,
  /\bI can'?t help with\b/,
] as const;

/** Invariant #1 — no hardcoded agent slug in shipped source. */
export function scanForAgentSlugs(opts: ScanOptions): Violation[] {
  const files = collectTsFiles(opts.srcDir, opts.skipDirs ?? DEFAULT_SKIP);
  const out: Violation[] = [];
  for (const file of files) {
    const lines = readFileSync(file, 'utf-8').split('\n');
    lines.forEach((line, i) => {
      const lower = line.toLowerCase();
      for (const slug of FORBIDDEN_AGENT_SLUGS) {
        // Word-boundary match: `cortex` must not fire on `cortexAnalyser`, but
        // must fire on `cogni-cortex`.
        if (new RegExp(`\\b${slug}\\b`).test(lower)) {
          out.push({ file, line: i + 1, text: line.trim().slice(0, 120), rule: `slug:${slug}` });
        }
      }
    });
  }
  return out;
}

/** Invariant #2 — no hardcoded user-facing prose in shipped source. */
export function scanForUserFacingStrings(opts: ScanOptions): Violation[] {
  const files = collectTsFiles(opts.srcDir, opts.skipDirs ?? DEFAULT_SKIP);
  const out: Violation[] = [];
  for (const file of files) {
    const lines = readFileSync(file, 'utf-8').split('\n');
    lines.forEach((line, i) => {
      for (const re of FORBIDDEN_USER_FACING) {
        if (re.test(line)) {
          out.push({ file, line: i + 1, text: line.trim().slice(0, 120), rule: String(re) });
        }
      }
    });
  }
  return out;
}

/** Invariant: only packages/db may import a database driver. */
export function scanForDbDriverImports(opts: ScanOptions): Violation[] {
  const files = collectTsFiles(opts.srcDir, opts.skipDirs ?? DEFAULT_SKIP);
  const out: Violation[] = [];
  const re = /from\s+['"](pg|postgres|drizzle-orm(\/.*)?)['"]/;
  for (const file of files) {
    const lines = readFileSync(file, 'utf-8').split('\n');
    lines.forEach((line, i) => {
      if (re.test(line)) {
        out.push({ file, line: i + 1, text: line.trim().slice(0, 120), rule: 'db-driver-import' });
      }
    });
  }
  return out;
}

/** Readable failure text for a non-empty violation list. */
export function formatViolations(label: string, violations: readonly Violation[]): string {
  return (
    `${label} — ${violations.length} violation(s) :\n` +
    violations.map((v) => `  ${v.file}:${v.line} [${v.rule}]\n    ${v.text}`).join('\n')
  );
}
