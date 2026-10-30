// runner-images.test.mjs — no workflow runs on a moving `*-latest` image
// (issue #882).
//
// The first block proves the parser-based detector on small workflows, among
// them the two defects the independent review (pass 1) found in the line-based
// first version; the second applies it to the REAL workflows, so a
// `runs-on: ubuntu-latest` coming back fails here and names the file and line.
//
// Run from the repo root: pnpm test:scripts

import { readFileSync, readdirSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, it, expect } from 'vitest';
import { describeFinding, findMovingLabels } from '../lib/runner-images.mjs';

const WORKFLOWS = join(
  resolve(dirname(fileURLToPath(import.meta.url)), '..', '..'),
  '.github',
  'workflows',
);

const wf = (...lines) => lines.join('\n') + '\n';
const where = (found) => found.map(({ line, value }) => ({ line, value }));

describe('findMovingLabels', () => {
  it('names the line and the label of each moving image, whatever the quoting', () => {
    const text = wf(
      'jobs:',
      '  a:',
      '    runs-on: ubuntu-latest',
      '  b:',
      '    runs-on: ubuntu-24.04',
      '  c:',
      '    runs-on: windows-latest # comment',
      '  d:',
      '    runs-on: "macos-latest"',
    );
    expect(findMovingLabels(text).map(({ line, value, kind }) => ({ line, value, kind }))).toEqual([
      { line: 3, value: 'ubuntu-latest', kind: 'moving' },
      { line: 7, value: 'windows-latest', kind: 'moving' },
      { line: 9, value: 'macos-latest', kind: 'moving' },
    ]);
  });

  it('does not read a name, a run script or a comment (false red of review pass 1)', () => {
    const text = wf(
      '# not ubuntu-latest, not windows-latest',
      'jobs:',
      '  a:',
      '    name: Playwright (ex ubuntu-latest)',
      '    runs-on: ubuntu-24.04 # was ubuntu-latest',
      '    steps:',
      '      - name: "ex ubuntu-latest"',
      '        run: echo "migrated off ubuntu-latest (#882)"',
      '      - run: |',
      '          echo windows-latest',
    );
    expect(findMovingLabels(text)).toEqual([]);
  });

  it('reads past a `#` inside a quoted string (false green of review pass 1)', () => {
    const text = wf(
      'jobs:',
      '  a:',
      '    name: "see #882" # why',
      '    runs-on: "ubuntu-latest"',
      '    steps:',
      '      - run: echo "see #882, ubuntu-latest was the problem"',
    );
    expect(where(findMovingLabels(text))).toEqual([{ line: 4, value: 'ubuntu-latest' }]);
  });

  it('compares without regard to case, as GitHub does', () => {
    const text = wf(
      'jobs:',
      '  a:',
      '    runs-on: Ubuntu-Latest',
      '  b:',
      '    runs-on: WINDOWS-LATEST',
    );
    expect(findMovingLabels(text).map((f) => f.value)).toEqual(['Ubuntu-Latest', 'WINDOWS-LATEST']);
  });

  it('reads every form of `runs-on`: list, and { group, labels }', () => {
    const text = wf(
      'jobs:',
      '  a:',
      '    runs-on: [self-hosted, ubuntu-latest]',
      '  b:',
      '    runs-on:',
      '      - self-hosted',
      '      - macos-latest',
      '  c:',
      '    runs-on:',
      '      group: ubuntu-latest-group',
      '      labels: [windows-latest]',
      '  d:',
      '    runs-on:',
      '      group: big-runners',
      '      labels: ubuntu-24.04',
      '  e:',
      '    runs-on: ubuntu-latest-8-cores',
    );
    expect(where(findMovingLabels(text))).toEqual([
      { line: 3, value: 'ubuntu-latest' },
      { line: 7, value: 'macos-latest' },
      { line: 11, value: 'windows-latest' },
      { line: 17, value: 'ubuntu-latest-8-cores' },
    ]);
  });

  it('follows `${{ matrix.os }}` into the matrix list and its includes', () => {
    const text = wf(
      'jobs:',
      '  a:',
      '    strategy:',
      '      matrix:',
      '        os: [ubuntu-24.04, windows-latest]',
      '        include:',
      '          - os: ubuntu-latest',
      '            node: 24',
      '    runs-on: ${{ matrix.os }}',
    );
    expect(where(findMovingLabels(text))).toEqual([
      { line: 5, value: 'windows-latest' },
      { line: 7, value: 'ubuntu-latest' },
    ]);
  });

  it('accepts a matrix whose values are explicit images, and ignores unrelated axes', () => {
    const text = wf(
      'jobs:',
      '  a:',
      '    strategy:',
      '      matrix:',
      '        os: [ubuntu-24.04]',
      '        npm: [lts, latest]',
      '    runs-on: ${{ matrix.os }}',
    );
    expect(findMovingLabels(text)).toEqual([]);
  });

  it('refuses a `runs-on` composed at run time, naming it', () => {
    const text = wf(
      'jobs:',
      '  a:',
      '    runs-on: ${{ vars.E2E_OS }}',
      '  b:',
      '    runs-on: ${{ fromJSON(inputs.os) }}',
      '  c:',
      "    runs-on: ${{ github.event_name == 'push' && 'ubuntu-24.04' || 'ubuntu-latest' }}",
      '  d:',
      '    runs-on: ${{ matrix.os }}',
      '  e:',
      '    strategy:',
      '      matrix:',
      '        os: ${{ fromJSON(needs.plan.outputs.os) }}',
      '    runs-on: ${{ matrix.os }}',
    );
    const found = findMovingLabels(text);
    expect(found.map(({ line, kind }) => ({ line, kind }))).toEqual([
      { line: 3, kind: 'unverifiable' },
      { line: 5, kind: 'unverifiable' },
      { line: 7, kind: 'unverifiable' },
      { line: 9, kind: 'unverifiable' },
      { line: 13, kind: 'unverifiable' },
    ]);
    expect(describeFinding('w.yml', found[0])).toContain('w.yml:3: ${{ vars.E2E_OS }}');
    expect(describeFinding('w.yml', found[0])).toContain('cannot be verified');
  });

  it('fails loud on a file that is not YAML', () => {
    expect(() => findMovingLabels('jobs:\n  a: [unclosed\n')).toThrow(/not a valid YAML/);
  });

  it('has nothing to say about a job without `runs-on` (reusable workflow call)', () => {
    expect(findMovingLabels(wf('jobs:', '  a:', '    uses: ./.github/workflows/x.yml'))).toEqual(
      [],
    );
  });
});

describe('the repository workflows', () => {
  const files = readdirSync(WORKFLOWS).filter((f) => /\.ya?ml$/.test(f));

  it('finds the workflows it is meant to guard', () => {
    expect(files).toEqual(expect.arrayContaining(['ci.yml', 'ci-windows.yml', 'qa.yml']));
  });

  it('runs no job on a moving or unverifiable image', () => {
    const offenders = files.flatMap((f) =>
      findMovingLabels(readFileSync(join(WORKFLOWS, f), 'utf-8')).map((finding) =>
        describeFinding(`.github/workflows/${f}`, finding),
      ),
    );
    expect(
      offenders,
      `a workflow must name its runner image (issue #882); found:\n${offenders.join('\n')}`,
    ).toEqual([]);
  });
});
