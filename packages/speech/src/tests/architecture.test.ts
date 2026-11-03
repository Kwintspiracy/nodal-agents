// @nodal-agents/speech — architecture invariant tests.
//
// Wired up with the package rather than after it: this is the file that would
// otherwise be added a month later, once a voice id, a personal agent slug or a
// vendor URL had already been baked into a provider. One scanner from
// @nodal-agents/test-kit, no local copy to drift.

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
// reads every product source file of the monorepo (git's view of what is
// source, from test-kit's `sourceFilesUnder`), tests excluded, and fails
// on a second text-to-speech call site: the AI SDK's speech entry point, an
// SDK speech model, or a request to a speech endpoint outside this package's
// providers.

const repoRoot = join(srcDir, '..', '..', '..');

/** A test reads or fakes these calls on purpose; product code may not. */
const isTest = (rel: string): boolean =>
  /(^|\/)(tests|__tests__)\//.test(rel) || /\.(test|spec)\.[cm]?[tj]sx?$/.test(rel);

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
    const files = ['packages', 'apps']
      .flatMap((r) => sourceFilesUnder(join(repoRoot, r)))
      .map((file) => ({ file, rel: relative(repoRoot, file).replaceAll('\\', '/') }))
      .filter(({ rel }) => /\.[cm]?[tj]sx?$/.test(rel) && !isTest(rel));
    // The scan must have read the monorepo, not an empty folder.
    expect(files.map((f) => f.rel)).toContain('packages/tools/src/builtin/generate-speech.ts');
    const found: string[] = [];
    for (const { file, rel } of files) {
      if (rel.startsWith('packages/speech/src/providers/')) continue;
      const text = readFileSync(file, 'utf8');
      for (const { what, re } of SECOND_PATH) {
        if (re.test(text)) found.push(`${rel}: ${what}`);
      }
    }
    expect(found).toEqual([]);
  });
});

// ── Channel-neutral (#948, owner's rule of 2026-11-03) ───────────────────────
//
// Everything in the voice plan is usable from an external module (a desktop
// companion, a speaker, a small device), not only from the dashboard. The
// runner calls these adapters for any channel's audio: a dashboard upload, a
// device stream, a messaging voice note. So the package speaks in bytes,
// async iterables of bytes and media types, and never in a browser's or a web
// framework's terms. Comments may NAME the browser (the measured notes on
// MediaRecorder containers); code may not depend on it.

const BROWSER_OR_WEB = [
  {
    what: 'a browser type or global',
    re: /\b(Blob|File|FileReader|FormData|MediaRecorder|MediaStream|AudioContext|HTMLAudioElement|navigator|window|document)\b/,
  },
  { what: 'a web framework import', re: /from\s+['"](next|react|react-dom)(\/[^'"]*)?['"]/ },
];

/** The code of a source file, comments removed, so a measured note can name the browser. */
const codeOnly = (text: string): string =>
  text.replace(/\/\*[\s\S]*?\*\//g, '').replace(/(^|[^:'"`])\/\/.*$/gm, '$1');

describe('channel-neutral speech package (#948)', () => {
  it('no source of packages/speech depends on a browser or a web framework', () => {
    const files = sourceFilesUnder(srcDir)
      .map((file) => ({ file, rel: relative(repoRoot, file).replaceAll('\\', '/') }))
      .filter(({ rel }) => /\.[cm]?[tj]sx?$/.test(rel) && !isTest(rel));
    expect(files.map((f) => f.rel)).toContain('packages/speech/src/speech-adapter.ts');
    const found: string[] = [];
    for (const { file, rel } of files) {
      const code = codeOnly(readFileSync(file, 'utf8'));
      for (const { what, re } of BROWSER_OR_WEB) {
        const hit = re.exec(code);
        if (hit) found.push(`${rel}: ${what} (${hit[0]})`);
      }
    }
    expect(found).toEqual([]);
  });
});
