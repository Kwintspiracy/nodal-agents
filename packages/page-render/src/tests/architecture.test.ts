// @nodal-agents/page-render — architecture invariant tests (#1082).
//
// Wired up with the package: the same shared scanners as every package of the
// monorepo, plus the one rule this package exists for — no product source
// launches a browser the person installed, and only this package drives the
// page renderer.

import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { join, relative } from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  scanForAgentSlugs,
  scanForHardcodedUuids,
  scanForDbDriverImports,
  scanForUserFacingStrings,
  assertNoViolations,
  sourceFilesUnder,
} from '@nodal-agents/test-kit';

const srcDir = join(fileURLToPath(import.meta.url), '..', '..');
const repoRoot = join(srcDir, '..', '..', '..');

describe('architecture invariants', () => {
  it('no agent or server slug hardcoded in source (invariant #1)', () => {
    assertNoViolations('slugs d’agent', scanForAgentSlugs({ srcDir }));
  });

  it('no per-user UUID in source (invariant #6)', () => {
    assertNoViolations('UUID en dur', scanForHardcodedUuids({ srcDir }));
  });

  it('does not import a database driver (only packages/db may)', () => {
    assertNoViolations('driver DB', scanForDbDriverImports({ srcDir }));
  });

  it('no hardcoded user-facing prose (invariant #2)', () => {
    assertNoViolations('texte utilisateur en dur', scanForUserFacingStrings({ srcDir }));
  });
});

/** The code of a source file, comments removed: a comment may name the flag it refuses. */
const codeOnly = (text: string): string =>
  text.replace(/\/\*[\s\S]*?\*\//g, '').replace(/(^|[^:'"`])\/\/.*$/gm, '$1');

const isTest = (rel: string): boolean =>
  /(^|\/)(tests|__tests__)\//.test(rel) || /\.(test|spec)\.[cm]?[tj]sx?$/.test(rel);

describe('one page renderer @cap:travailler-sur-des-fichiers/moteur', () => {
  it('only packages/page-render drives puppeteer-core or installs a browser', () => {
    const files = ['packages', 'apps']
      .flatMap((r) => sourceFilesUnder(join(repoRoot, r)))
      .map((file) => ({ file, rel: relative(repoRoot, file).replaceAll('\\', '/') }))
      .filter(({ rel }) => /\.[cm]?[tj]sx?$/.test(rel) && !isTest(rel));
    // The scan must have read the monorepo, not an empty folder.
    expect(files.map((f) => f.rel)).toContain('packages/tools/src/builtin/render-pdf.ts');
    const found: string[] = [];
    for (const { file, rel } of files) {
      if (rel.startsWith('packages/page-render/src/')) continue;
      const text = readFileSync(file, 'utf8');
      if (/from\s+['"](puppeteer-core|puppeteer|@puppeteer\/browsers)['"]/.test(text)) {
        found.push(`${rel}: imports the renderer driver or installer`);
      }
    }
    expect(found).toEqual([]);
  });

  it('the renderer never turns Chrome’s sandbox off', () => {
    const files = sourceFilesUnder(srcDir)
      .map((file) => ({ file, rel: relative(repoRoot, file).replaceAll('\\', '/') }))
      .filter(({ rel }) => /\.[cm]?[tj]sx?$/.test(rel) && !isTest(rel));
    expect(files.map((f) => f.rel)).toContain('packages/page-render/src/render.ts');
    const found = files
      .filter(({ file }) =>
        /--no-sandbox|--disable-setuid-sandbox/.test(codeOnly(readFileSync(file, 'utf8'))),
      )
      .map(({ rel }) => rel);
    expect(found).toEqual([]);
  });
});
