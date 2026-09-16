/**
 * The workflow gate in `homepage.test.tsx` is only as trustworthy as the reader
 * underneath it. A parser that quietly returned an empty mapping would make
 * every assertion above it vacuous, so the shapes `docs.yml` is made of are
 * pinned here, including the ones that read nothing like their source text:
 * a folded `>-` scalar, a `|` block, a sequence of mappings.
 */
import { describe, expect, it } from 'vitest';

import { parseYaml } from './yaml-lite';

describe('yaml-lite reads the shapes a GitHub workflow is made of', () => {
  it('reads nested mappings, flow sequences and quoted scalars', () => {
    expect(
      parseYaml(
        [
          'name: Deploy',
          'on:',
          '  push:',
          '    branches: [main]',
          '  workflow_run:',
          "    workflows: ['Quality — full measurement']",
          '  workflow_dispatch:',
        ].join('\n'),
      ),
    ).toEqual({
      name: 'Deploy',
      on: {
        push: { branches: ['main'] },
        workflow_run: { workflows: ['Quality — full measurement'] },
        workflow_dispatch: null,
      },
    });
  });

  it('reads a sequence of mappings, each with its own nested mapping', () => {
    expect(
      parseYaml(
        [
          'steps:',
          '  - uses: actions/checkout@v5',
          '    with:',
          '      ref: main',
          '  - name: Build docs',
          '    run: pnpm build',
        ].join('\n'),
      ),
    ).toEqual({
      steps: [
        { uses: 'actions/checkout@v5', with: { ref: 'main' } },
        { name: 'Build docs', run: 'pnpm build' },
      ],
    });
  });

  it('folds a `>-` scalar onto one line and keeps a `|` block as written', () => {
    expect(
      parseYaml(
        [
          'if: >-',
          "  github.event_name != 'workflow_run' ||",
          "  github.event.workflow_run.conclusion == 'success'",
          'run: |',
          '  mkdir -p out/qa',
          '  cp a b',
        ].join('\n'),
      ),
    ).toEqual({
      if: "github.event_name != 'workflow_run' || github.event.workflow_run.conclusion == 'success'",
      run: 'mkdir -p out/qa\ncp a b',
    });
  });

  it('drops comments, and leaves a `#` inside quotes alone', () => {
    expect(
      parseYaml(['# a whole line', 'cron: "41 * * * *" # every hour', 'tag: "a#b"'].join('\n')),
    ).toEqual({ cron: '41 * * * *', tag: 'a#b' });
  });

  it('refuses what it cannot read, rather than returning half a document', () => {
    expect(() => parseYaml('base: &anchor\n  a: 1')).toThrow(/anchors/);
    expect(() => parseYaml('map: { a: 1 }')).toThrow(/flow mappings/);
    expect(() => parseYaml('a: [1, 2')).toThrow(/unterminated/);
    expect(() => parseYaml('not a mapping at all')).toThrow(/cannot read line/);
  });
});
