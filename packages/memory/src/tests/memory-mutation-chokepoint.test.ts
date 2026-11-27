// memory-mutation-chokepoint.test.ts — architecture: a fact changes in ONE
// place.
//
// Every change to a fact after it was saved goes through `mutateMemory`
// (packages/memory/src/mutate.ts): it checks the version the caller read,
// honours the owner's marks in its WHERE, and keeps the previous state. An
// UPDATE of agent_memory written anywhere else would skip all three, which is
// how a dozen paths came to rewrite facts with nothing kept (#1144). This test
// reads every source file of apps/ and packages/ and fails on such an UPDATE.
//
// Two other writers are allowed, by name, because they do not change the
// fact: the usage counters and the derived vector. A new entry here needs the
// same kind of reason, written next to it.

import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { join, relative, sep } from 'node:path';
import { fileURLToPath } from 'node:url';
import { sourceFilesUnder } from '@nodal-agents/test-kit';

const repoRoot = join(fileURLToPath(import.meta.url), '..', '..', '..', '..', '..');

/** Files allowed to UPDATE agent_memory, and why. */
const ALLOWED: Record<string, string> = {
  'packages/memory/src/mutate.ts': 'the one function that changes a fact',
  'packages/memory/src/access-tracking.ts':
    'usage counters (access_count, last_accessed_at): not part of the fact, no version',
  'packages/memory/src/backfill.ts': 'the derived vector of the current text: not part of the fact',
};

const PATTERNS: ReadonlyArray<{ name: string; re: RegExp }> = [
  { name: 'query-builder update', re: /\.update\(\s*agentMemory\s*\)/g },
  { name: 'raw SQL update', re: /\bUPDATE\s+agent_memory\b/gi },
];

const SOURCE_EXT = /\.(ts|tsx|mts|cts|js|mjs|cjs)$/;
const TEST_PATH = /(^|\/)(tests|__tests__|e2e)\/|\.(test|spec)\.[a-z]+$|\/test-utils\b/;

/** The direct UPDATEs of agent_memory in one file (path relative to the repo, `/`-separated). */
function directMemoryUpdates(path: string, text: string): string[] {
  if (ALLOWED[path] !== undefined) return [];
  const out: string[] = [];
  for (const { name, re } of PATTERNS) {
    for (const m of text.matchAll(re)) {
      const line = text.slice(0, m.index).split('\n').length;
      out.push(`${path}:${line} (${name})`);
    }
  }
  return out;
}

function scan(): { files: number; violations: string[] } {
  const violations: string[] = [];
  let files = 0;
  for (const top of ['apps', 'packages']) {
    for (const abs of sourceFilesUnder(join(repoRoot, top))) {
      const rel = relative(repoRoot, abs).split(sep).join('/');
      if (!SOURCE_EXT.test(rel) || TEST_PATH.test(rel)) continue;
      files += 1;
      violations.push(...directMemoryUpdates(rel, readFileSync(abs, 'utf8')));
    }
  }
  return { files, violations };
}

describe('architecture: a fact changes only through mutateMemory (#1144) @cap:se-souvenir/moteur', () => {
  it('no source file of apps/ or packages/ updates agent_memory outside the allowed writers', () => {
    const { files, violations } = scan();
    // A scan that read nothing would pass: it must have read the repository.
    expect(files).toBeGreaterThan(500);
    expect(violations).toEqual([]);
  });

  it('the scanner turns red on a direct update, in either form, anywhere else', () => {
    expect(
      directMemoryUpdates(
        'packages/tools/src/builtin/some-tool.ts',
        'await ctx.db\n  .update(agentMemory)\n  .set({ archived: true })',
      ),
    ).toEqual(['packages/tools/src/builtin/some-tool.ts:2 (query-builder update)']);
    expect(
      directMemoryUpdates(
        'apps/web/src/lib/actions.ts',
        'await tx.update( agentMemory ).set({ fact });\nawait db.execute(sql`update agent_memory set fact = ${f}`);',
      ),
    ).toEqual([
      'apps/web/src/lib/actions.ts:1 (query-builder update)',
      'apps/web/src/lib/actions.ts:2 (raw SQL update)',
    ]);
  });

  it('the allowed writers are exactly the three named, and each exists', () => {
    const { violations } = scan();
    expect(violations).toEqual([]);
    for (const path of Object.keys(ALLOWED)) {
      expect(() => readFileSync(join(repoRoot, path), 'utf8')).not.toThrow();
    }
    // The allow-list does not cover a file it does not name.
    expect(
      directMemoryUpdates('packages/memory/src/curator.ts', 'db.update(agentMemory)'),
    ).toHaveLength(1);
  });
});
