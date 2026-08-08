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
  /**
   * Absolute paths to exclude, matched by suffix.
   *
   * For the file that DEFINES a denylist: this module lists every forbidden
   * slug as a string literal, so scanning it reports eleven violations that are
   * the rule itself. Left in, that constant floor hides the twelfth — a real
   * one — behind noise nobody reads twice.
   */
  skipFiles?: readonly string[];
}

/** Normalised suffix match, so a caller can pass a posix or win32 path. */
function isSkipped(file: string, skipFiles: readonly string[]): boolean {
  const norm = file.split('\\').join('/');
  return skipFiles.some((s) => norm.endsWith(s.split('\\').join('/')));
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
  // `cortex` is deliberately ABSENT. The product ships a public catalog
  // connector called `cogni-cortex` (packages/shared/src/mcp-catalog.ts), so
  // the bare word cannot tell product data from a personal agent name — it
  // fired on the catalog entry, its label and its description. A rule that
  // flags the product's own connector gets disabled, not fixed. The personal
  // agent names below still cover the risk the invariant is about.
  'tatooine',
  'sputnik',
  'displacer',
  'alfred',
  // The owner's own handle. Present in all 12 adapter copies and absent from
  // this list until the adapters were folded in — propagating without it would
  // have made the shared guard weaker than the copies it replaced.
  'kwint',
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
  const files = collectTsFiles(opts.srcDir, opts.skipDirs ?? DEFAULT_SKIP).filter(
    (f) => !isSkipped(f, opts.skipFiles ?? []),
  );
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
  const files = collectTsFiles(opts.srcDir, opts.skipDirs ?? DEFAULT_SKIP).filter(
    (f) => !isSkipped(f, opts.skipFiles ?? []),
  );
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
  const files = collectTsFiles(opts.srcDir, opts.skipDirs ?? DEFAULT_SKIP).filter(
    (f) => !isSkipped(f, opts.skipFiles ?? []),
  );
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

/**
 * Invariant #6 — no per-user values in shipped source.
 *
 * A UUID literal is an id from ONE install's database. Shipped, it makes the
 * code behave correctly for its author and silently wrong for everyone else.
 */
export function scanForHardcodedUuids(opts: ScanOptions): Violation[] {
  return scanForPattern(opts, {
    // Quoted, so a UUID inside a comment or a doc example does not fire.
    pattern: /['"`][0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}['"`]/i,
    rule: 'hardcoded-uuid',
    allowMatch: isSeedUuid,
  });
}

/**
 * A zero-prefixed UUID is a SEEDED default, identical in every install
 * (`00000000-0000-0000-0000-000000000002` is the default entity everywhere).
 *
 * The invariant forbids per-USER values; a constant the installer writes on
 * first boot is the opposite of that, and flagging it would push people to
 * disable the check rather than fix anything.
 */
export function isSeedUuid(match: string): boolean {
  return /^['"`]0{8}-0{4}-0{4}-0{4}-[0-9a-f]{12}['"`]$/i.test(match);
}

/**
 * Layering — an adapter must not reach into db / llm / auth / memory.
 *
 * dependency-cruiser enforces this at the graph level; this catches it at the
 * package's own suite, where the failure names the line rather than an edge.
 */
export function scanForForbiddenPackageImports(
  opts: ScanOptions,
  packages: readonly string[],
): Violation[] {
  const escaped = packages.map((p) => p.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')).join('|');
  return scanForPattern(opts, {
    pattern: new RegExp(`from\\s+['"](${escaped})(/[^'"]*)?['"]`),
    rule: 'forbidden-import',
  });
}

/**
 * Generic line scanner, so a package-specific rule reuses the shared walker
 * instead of shipping its twelfth copy of a recursive readdir.
 */
export function scanForPattern(
  opts: ScanOptions,
  spec: {
    pattern: RegExp;
    rule: string;
    /**
     * Called with each MATCH, not each line. Match-level on purpose: a
     * line-level filter would let a real value hide on the same line as an
     * allowed placeholder (`'me@example.com', 'quentin@gmail.com'`).
     */
    allowMatch?: (match: string) => boolean;
  },
): Violation[] {
  const files = collectTsFiles(opts.srcDir, opts.skipDirs ?? DEFAULT_SKIP).filter(
    (f) => !isSkipped(f, opts.skipFiles ?? []),
  );
  const flags = spec.pattern.flags.includes('g') ? spec.pattern.flags : `${spec.pattern.flags}g`;
  const out: Violation[] = [];
  for (const file of files) {
    readFileSync(file, 'utf-8')
      .split('\n')
      .forEach((line, i) => {
        for (const m of line.matchAll(new RegExp(spec.pattern.source, flags))) {
          if (spec.allowMatch?.(m[0])) continue;
          out.push({ file, line: i + 1, text: line.trim().slice(0, 120), rule: spec.rule });
          break;
        }
      });
  }
  return out;
}

/**
 * Every source file of the package, concatenated.
 *
 * For the rare assertion that is POSITIVE — "this adapter must import the
 * official SDK" — which a violation scanner cannot express.
 */
export function readSource(opts: ScanOptions): string {
  return collectTsFiles(opts.srcDir, opts.skipDirs ?? DEFAULT_SKIP)
    .filter((f) => !isSkipped(f, opts.skipFiles ?? []))
    .map((f) => readFileSync(f, 'utf-8'))
    .join('\n');
}

/**
 * Throw with the offending lines when a scan found anything.
 *
 * Throws rather than calling `expect` so this package stays free of a test
 * runner — the same reason `executeTool` is injected into the gate harness.
 */
export function assertNoViolations(label: string, violations: readonly Violation[]): void {
  if (violations.length > 0) throw new Error(formatViolations(label, violations));
}

/** Readable failure text for a non-empty violation list. */
export function formatViolations(label: string, violations: readonly Violation[]): string {
  return (
    `${label} — ${violations.length} violation(s) :\n` +
    violations.map((v) => `  ${v.file}:${v.line} [${v.rule}]\n    ${v.text}`).join('\n')
  );
}
