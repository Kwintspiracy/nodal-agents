// runner-images.test.mjs — no workflow runs on a moving `*-latest` image
// (issue #882).
//
// The first block proves the detector on small texts; the second applies it to
// the REAL workflows, so a `runs-on: ubuntu-latest` coming back fails here and
// names the file and the line.
//
// Run from the repo root: pnpm test:scripts

import { readFileSync, readdirSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, it, expect } from 'vitest';
import { findMovingLabels } from '../lib/runner-images.mjs';

const WORKFLOWS = join(
  resolve(dirname(fileURLToPath(import.meta.url)), '..', '..'),
  '.github',
  'workflows',
);

describe('findMovingLabels', () => {
  it('names the line and the label of each moving image', () => {
    const text = [
      'jobs:',
      '  a:',
      '    runs-on: ubuntu-latest',
      '  b:',
      '    runs-on: ubuntu-24.04',
      '  c:',
      '    runs-on: windows-latest # comment',
      '  d:',
      '    runs-on: "macos-latest"',
    ].join('\n');
    expect(findMovingLabels(text)).toEqual([
      { line: 3, label: 'ubuntu-latest' },
      { line: 7, label: 'windows-latest' },
      { line: 9, label: 'macos-latest' },
    ]);
  });

  it('catches a label hidden in a matrix list, in either list syntax', () => {
    const text = [
      '    strategy:',
      '      matrix:',
      '        os: [ubuntu-24.04, windows-latest]',
      '        include:',
      '          - os: ubuntu-latest',
      '    runs-on: ${{ matrix.os }}',
    ].join('\r\n');
    expect(findMovingLabels(text)).toEqual([
      { line: 3, label: 'windows-latest' },
      { line: 5, label: 'ubuntu-latest' },
    ]);
  });

  it('accepts explicit images and ignores comments, including a whole-line one', () => {
    const text = [
      '# not ubuntu-latest, not windows-latest',
      'jobs:',
      '  a:',
      '    runs-on: windows-2025-vs2026',
      '  b:',
      '    runs-on: windows-11-arm',
      '  c:',
      '    runs-on: ubuntu-24.04 # was ubuntu-latest',
    ].join('\n');
    expect(findMovingLabels(text)).toEqual([]);
  });
});

describe('the repository workflows', () => {
  const files = readdirSync(WORKFLOWS).filter((f) => /\.ya?ml$/.test(f));

  it('finds the workflows it is meant to guard', () => {
    expect(files).toEqual(expect.arrayContaining(['ci.yml', 'ci-windows.yml', 'qa.yml']));
  });

  it('runs no job on a moving `*-latest` image', () => {
    const offenders = files.flatMap((f) =>
      findMovingLabels(readFileSync(join(WORKFLOWS, f), 'utf-8')).map(
        ({ line, label }) => `.github/workflows/${f}:${line}: ${label}`,
      ),
    );
    expect(
      offenders,
      `a workflow must name its runner image (issue #882); found:\n${offenders.join('\n')}`,
    ).toEqual([]);
  });
});
