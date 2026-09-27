// ci-budgets.test.mjs — les bornes de la CI tiennent par la machine (#517).
//
// Voir scripts/lib/ci-budgets.mjs pour le pourquoi. Ce fichier prouve les trois
// règles sur des workflows écrits exprès, puis sur les VRAIS workflows du dépôt.

import { describe, it, expect } from 'vitest';
import { readFileSync, readdirSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { lireWorkflow, verifierWorkflow, estTriviale } from '../lib/ci-budgets.mjs';

const tete = `name: T
on:
  push:
jobs:
`;

describe('lireWorkflow', () => {
  it('lit les jobs, leur borne, et chaque étape avec la sienne, bloc `run: |` compris', () => {
    const jobs = lireWorkflow(`${tete}  build:
    runs-on: ubuntu-latest
    timeout-minutes: 20
    steps:
      - uses: actions/checkout@v5
      - name: Install
        timeout-minutes: 10
        run: pnpm install
      - name: Script
        run: |
          # un commentaire
          pnpm test
          echo fini
`);
    expect(jobs).toHaveLength(1);
    expect(jobs[0].nom).toBe('build');
    expect(jobs[0].timeout).toBe(20);
    expect(jobs[0].etapes.map((e) => [e.nom, e.genre, e.timeout])).toEqual([
      ['uses', 'uses', undefined],
      ['Install', 'run', 10],
      ['Script', 'run', undefined],
    ]);
    expect(jobs[0].etapes[2].run).toBe('pnpm test\necho fini');
  });
});

describe('verifierWorkflow', () => {
  it('une étape run sans borne est un constat qui la nomme', () => {
    const c = verifierWorkflow(
      'x.yml',
      `${tete}  checks:
    timeout-minutes: 30
    steps:
      - name: Lint
        run: pnpm lint
`,
    );
    expect(c).toEqual(['x.yml › checks › "Lint" (line 8): a run step without timeout-minutes']);
  });

  it('un job sans borne est un constat', () => {
    const c = verifierWorkflow(
      'x.yml',
      `${tete}  deploy:
    runs-on: ubuntu-latest
    steps:
      - uses: actions/deploy-pages@v4
`,
    );
    expect(c).toEqual(['x.yml › deploy (line 5): the job has no numeric timeout-minutes']);
  });

  it('la borne du job doit couvrir la somme des étapes plus la marge de mise en place', () => {
    const c = verifierWorkflow(
      'x.yml',
      `${tete}  e2e:
    timeout-minutes: 30
    steps:
      - name: Install
        timeout-minutes: 10
        run: pnpm install
      - name: Journeys
        timeout-minutes: 20
        run: pnpm e2e
`,
    );
    expect(c).toEqual([
      'x.yml › e2e: job timeout 30 min < steps 30 min + 5 min for setup steps; a job timeout would cut a step before its own bound',
    ]);
  });

  it('un workflow tenu ne rend rien, et une étape triviale n’a pas besoin de borne', () => {
    const c = verifierWorkflow(
      'x.yml',
      `${tete}  ok:
    timeout-minutes: 20
    steps:
      - uses: actions/checkout@v5
      - name: Prepare
        run: mkdir -p out && echo ready
      - name: Test
        timeout-minutes: 10
        run: pnpm test
`,
    );
    expect(c).toEqual([]);
  });

  it('une borne qui n’est pas un nombre est un constat, jamais un vert', () => {
    const c = verifierWorkflow(
      'x.yml',
      `${tete}  m:
    timeout-minutes: \${{ matrix.t }}
    steps:
      - name: T
        timeout-minutes: \${{ matrix.s }}
        run: pnpm test
`,
    );
    expect(c).toHaveLength(2);
    expect(c[0]).toContain('the job has no numeric timeout-minutes');
    expect(c[1]).toContain('timeout-minutes is not a number');
  });
});

describe('estTriviale', () => {
  it('echo, mkdir, rm… oui ; une commande qui fait des I/O ou lance une suite, non', () => {
    expect(estTriviale('echo a && mkdir -p b; rm -f c')).toBe(true);
    expect(estTriviale('pnpm test')).toBe(false);
    expect(estTriviale('echo a\ncurl https://x')).toBe(false);
  });
});

describe('les workflows du dépôt', () => {
  it('tiennent tous les trois règles', () => {
    const dossier = join(
      dirname(fileURLToPath(import.meta.url)),
      '..',
      '..',
      '.github',
      'workflows',
    );
    const constats = readdirSync(dossier)
      .filter((f) => /\.ya?ml$/.test(f))
      .flatMap((f) => verifierWorkflow(f, readFileSync(join(dossier, f), 'utf8')));
    expect(constats).toEqual([]);
  });
});
