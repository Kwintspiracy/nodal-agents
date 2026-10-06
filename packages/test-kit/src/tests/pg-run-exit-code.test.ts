// pg-run-exit-code.test.ts — un run vitest rouge sort en échec, même quand il a
// chargé Postgres (issue #698).
//
// `embedded-postgres` pose, au chargement, un `beforeExit` qui finit le
// processus par `process.exit(0)`. Le `globalSetup` du projet `pg` le charge
// dans le processus PRINCIPAL de vitest : tout run contenant un `.pg` rendait
// donc 0, ses échecs imprimés mais jamais comptés — turbo voyait la tâche
// réussie et la CI Linux passait au vert sur un test rouge.
//
// La preuve passe par un VRAI run vitest, en sous-processus, dont le
// `globalSetup` charge le paquet par le chemin du harnais (`loadEmbeddedPostgres`)
// et dont on lit le code de sortie. Aucun cluster n'est démarré : le chargement
// suffit à poser le crochet, et la garde tient ainsi sur tous les OS.

import { describe, it, expect } from 'vitest';
import { spawnSync } from 'node:child_process';
import { createRequire } from 'node:module';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const FIXTURE = join(dirname(fileURLToPath(import.meta.url)), 'fixtures', 'pg-run-exit-code');
const VITEST_BIN = join(
  dirname(createRequire(import.meta.url).resolve('vitest/package.json')),
  'vitest.mjs',
);

function runFixture(verdict: 'red' | 'green'): { status: number | null; output: string } {
  const run = spawnSync(
    process.execPath,
    [VITEST_BIN, 'run', '--root', FIXTURE, '--config', join(FIXTURE, 'vitest.config.ts')],
    {
      cwd: FIXTURE,
      env: { ...process.env, PG_RUN_EXIT_CODE_VERDICT: verdict, NO_COLOR: '1' },
      encoding: 'utf-8',
      timeout: 50_000,
    },
  );
  return { status: run.status, output: `${run.stdout}${run.stderr}` };
}

describe('a vitest run that loaded embedded-postgres keeps its own verdict', () => {
  it('a failing test makes the run exit 1', () => {
    const { status, output } = runFixture('red');
    expect(output).toContain('EMBEDDED_POSTGRES_LOADED');
    expect(output).toMatch(/Tests\s+1 failed/);
    expect(status).toBe(1);
  });

  it('a passing run still exits 0', () => {
    const { status, output } = runFixture('green');
    expect(output).toContain('EMBEDDED_POSTGRES_LOADED');
    expect(output).toMatch(/Tests\s+1 passed/);
    expect(status).toBe(0);
  });
});
