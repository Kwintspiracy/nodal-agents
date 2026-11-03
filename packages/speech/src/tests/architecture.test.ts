// @nodal-agents/speech — architecture invariant tests.
//
// Wired up with the package rather than after it: this is the file that would
// otherwise be added a month later, once a voice id, a personal agent slug or a
// vendor URL had already been baked into a provider. One scanner from
// @nodal-agents/test-kit, no local copy to drift.

import { describe, it, expect } from 'vitest';
import { readdirSync, readFileSync } from 'node:fs';
import { join, relative, sep } from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  scanForAgentSlugs,
  scanForHardcodedUuids,
  scanForDbDriverImports,
  scanForUserFacingStrings,
  assertNoViolations,
} from '@nodal-agents/test-kit';

const srcDir = join(fileURLToPath(import.meta.url), '..', '..');

describe('architecture invariants', () => {
  it('no agent or server slug hardcoded in source (invariant #1)', () => {
    assertNoViolations('slugs d\u2019agent', scanForAgentSlugs({ srcDir }));
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

// ── One speech path (#940, invariant #11) ────────────────────────────────────
//
// Until #940, `generate_speech` produced its audio through packages/llm (the AI
// SDK's speech model pointed at OpenRouter), and this package held a second
// set of vendors. One path remains: the adapters of this package. This scan
// reads every product source file of the monorepo, tests excluded, and fails
// on a second text-to-speech call site: the AI SDK's speech entry point, an
// SDK speech model, or a request to a speech endpoint outside this package's
// providers.

const repoRoot = join(srcDir, '..', '..', '..');
const SKIP = new Set(['node_modules', 'dist', '.next', '.turbo', 'tests', '__tests__', 'out']);

function sourceFiles(dir: string, out: string[] = []): string[] {
  let entries;
  try {
    entries = readdirSync(dir, { withFileTypes: true });
  } catch {
    return out;
  }
  for (const e of entries) {
    if (SKIP.has(e.name)) continue;
    const full = join(dir, e.name);
    if (e.isDirectory()) sourceFiles(full, out);
    else if (/\.(ts|tsx|mts|js|mjs)$/.test(e.name) && !/\.test\.[tj]sx?$/.test(e.name)) {
      out.push(full);
    }
  }
  return out;
}

const SECOND_PATH = [
  {
    what: 'the AI SDK speech entry point',
    re: /\bexperimental_generateSpeech\b|\bgenerateSpeech\s*\(/,
  },
  { what: 'an SDK speech model', re: /\.speech\(\s*['"`a-z]/ },
  {
    what: 'a speech endpoint',
    re: /\/audio\/speech\b|:generateContent[^\n]*preview-tts|\/t2a_v2\b/,
  },
];

describe('one speech path @cap:travailler-sur-des-fichiers/moteur', () => {
  it('no product source outside packages/speech/src/providers calls a text-to-speech API', () => {
    const roots = ['packages', 'apps'].map((r) => join(repoRoot, r));
    const files = roots.flatMap((r) => sourceFiles(r));
    // The scan must have read the monorepo, not an empty folder.
    expect(
      files.some((f) => f.endsWith(join('tools', 'src', 'builtin', 'generate-speech.ts'))),
    ).toBe(true);
    const providers = join(srcDir, 'providers') + sep;
    const found: string[] = [];
    for (const file of files) {
      if (file.startsWith(providers)) continue;
      const text = readFileSync(file, 'utf8');
      for (const { what, re } of SECOND_PATH) {
        if (re.test(text)) found.push(`${relative(repoRoot, file)}: ${what}`);
      }
    }
    expect(found).toEqual([]);
  });
});
