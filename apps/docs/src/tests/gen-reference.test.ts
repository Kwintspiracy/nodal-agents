/**
 * The homepage figures exist only because `scripts/gen-reference.ts` writes
 * `lib/measured-facts.json` on every build. Nothing proved that it does.
 *
 * Verified by mutation on 2026-09-16: delete the `writeFileSync` block for
 * `measured-facts.json` from the generator and the whole docs suite stayed
 * green (28/28) — `measured-facts.test.ts` derives the figures itself, and
 * `homepage.test.tsx` reads the same committed file the page imports, so both
 * were blind to a generator that had stopped writing. The next measurement
 * would then have been published under the figures of an older one, with every
 * test still green.
 *
 * So this runs the real generator against a throwaway directory and reads what
 * came out. Deliberately NOT a comparison between the committed
 * `measured-facts.json` and the committed snapshot: that comparison is issue
 * #109 itself — the nightly rewrites the snapshot with `[skip ci]`, so it would
 * turn every pull request opened afterwards red for a drift it had not caused.
 * The drift is caught where the regeneration happens, in `docs.yml`, not here.
 */
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { deriveMeasuredFacts, type MeasuredFacts } from '../../scripts/measured-facts';

const here = dirname(fileURLToPath(import.meta.url));
const repoRoot = resolve(here, '..', '..', '..', '..');

let outRoot: string;

describe('the generator writes the figures the homepage imports', () => {
  beforeAll(async () => {
    outRoot = mkdtempSync(join(tmpdir(), 'nodal-gen-reference-'));
    process.env.NODAL_DOCS_GEN_OUT = outRoot;
    // Top-level script: importing it runs it, against the directory named
    // above. Imported once per test file, which is the single run this needs.
    await import('../../scripts/gen-reference');
  }, 120_000);

  afterAll(() => {
    delete process.env.NODAL_DOCS_GEN_OUT;
    if (outRoot) rmSync(outRoot, { recursive: true, force: true });
  });

  const produced = (name: string) =>
    JSON.parse(readFileSync(join(outRoot, 'lib', name), 'utf8')) as unknown;

  it('produces measured-facts.json, and it is the snapshot derived', () => {
    const snapshot = JSON.parse(
      readFileSync(join(repoRoot, 'apps', 'qa', 'data', 'snapshot.json'), 'utf8'),
    ) as unknown;
    expect(produced('measured-facts.json')).toEqual(deriveMeasuredFacts(snapshot));
  });

  it('produces catalog-facts.json in the same run', () => {
    expect(produced('catalog-facts.json')).toMatchObject({ systemSkills: expect.any(Number) });
  });

  it('writes the file the page imports, under the name the page imports', () => {
    const committed = JSON.parse(
      readFileSync(join(repoRoot, 'apps', 'docs', 'lib', 'measured-facts.json'), 'utf8'),
    ) as MeasuredFacts;
    const fresh = produced('measured-facts.json') as MeasuredFacts;
    // Values may legitimately differ — a measurement lands before the docs are
    // rebuilt. The SHAPE may not: the page destructures these fields.
    expect(Object.keys(fresh).sort()).toEqual(Object.keys(committed).sort());
    expect(fresh.figures.map((f) => f.label)).toEqual(committed.figures.map((f) => f.label));
  });
});

describe('the build is invalidated when the measurement changes', () => {
  // `pnpm build` is turbo. The docs live in their own workspace, the snapshot in
  // `apps/qa`, so nothing in the docs package changes when a measurement lands:
  // turbo would replay a cached build and publish the previous figures. Only a
  // root-level dependency crosses workspaces.
  it('lists the snapshot among turbo globalDependencies', () => {
    const turbo = JSON.parse(readFileSync(join(repoRoot, 'turbo.json'), 'utf8')) as {
      globalDependencies?: string[];
    };
    expect(turbo.globalDependencies ?? []).toContain('apps/qa/data/snapshot.json');
  });
});
