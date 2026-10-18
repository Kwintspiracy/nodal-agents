// vitest-timeouts.test.ts — every vitest config in the monorepo declares a
// per-test timeout. A config that does not falls back to vitest's 5 s, and many
// suites here spawn real processes (the CLI through tsx, shells, git): 0.5 s on
// a free machine, 4 to 10 s on a contended two-core CI runner. apps/cli was the
// one config left at the default, and Windows CI went red on it (run
// 39158880706, `nodal-home.test.ts` "Test timed out in 5000ms").

import { describe, it, expect } from 'vitest';
import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join, relative, sep } from 'node:path';

const root = join(__dirname, '..', '..', '..', '..');
// `fixtures`: configs of throw-away projects that tests run vitest against.
const skip = new Set(['node_modules', 'dist', '.next', '.turbo', '.claude', '.git', 'fixtures']);

function configs(dir: string, out: string[] = []): string[] {
  for (const name of readdirSync(dir)) {
    if (skip.has(name)) continue;
    const p = join(dir, name);
    if (statSync(p).isDirectory()) configs(p, out);
    else if (/^vitest\.config\.(ts|mts|js|mjs)$/.test(name)) out.push(p);
  }
  return out;
}

describe('vitest configs @cap:executer-une-commande/moteur', () => {
  const files = configs(root);

  it('finds the configs it is meant to guard', () => {
    expect(files.length).toBeGreaterThanOrEqual(5);
  });

  it('every one sets testTimeout to at least 30 s', () => {
    const offenders: string[] = [];
    for (const f of files) {
      const m = /testTimeout:\s*([\d_]+)/.exec(readFileSync(f, 'utf8'));
      const ms = m ? Number(m[1]!.replace(/_/g, '')) : 0;
      if (ms < 30_000) offenders.push(relative(root, f).split(sep).join('/'));
    }
    expect(offenders).toEqual([]);
  });
});
