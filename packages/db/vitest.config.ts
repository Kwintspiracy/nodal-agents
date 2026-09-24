import { defineConfig } from 'vitest/config';

/**
 * Les suites `*.pg.test.ts` démarrent un VRAI Postgres embarqué — ici pour
 * appliquer les VRAIES migrations, que le SQL inline de `src/tests/helpers.ts`
 * n'applique jamais.
 *
 * ELLES NE PEUVENT PAS TOURNER SUR LE RUNNER WINDOWS DE GITHUB, pour la raison
 * déjà mesurée et écrite dans `apps/runner/vitest.config.ts` : PostgreSQL
 * refuse de démarrer sous un compte ADMINISTRATEUR, et c'est sous ce compte que
 * GitHub exécute ses jobs `windows-latest`. `initdb` réussit, `pg_ctl start`
 * rejette. Sur une machine Windows ordinaire (session utilisateur) elles
 * passent — vérifié ici avant ce commit.
 *
 * Ce n'est PAS un « vert par absence » : le job Linux de la même CI les exécute
 * à chaque run, et le harnais échoue FORT quand le binaire manque (le démarrage
 * est un test, jamais un `beforeAll`). Ce qui change ici, c'est seulement l'OS
 * qui porte la garantie. Le message ci-dessous le dit dans le journal du job
 * plutôt que de laisser croire à une suite complète.
 *
 * ⚠️ Cette config par paquet SHADOWE entièrement la `vitest.config.ts` de la
 * racine : ses réglages (globals, environment, timeouts généreux) doivent être
 * répliqués ici, sinon les tests de ce paquet retombent sur le défaut de 5 s et
 * flakent sur un runner CI sursouscrit.
 */
const isWindowsCi = process.platform === 'win32' && !!process.env['CI'];
if (isWindowsCi) {
  console.warn(
    '[vitest] suites *.pg.test.ts non exécutées sur Windows CI (postmaster refusé sous compte administrateur) — le job Linux les exécute',
  );
}

const EXCLUDE = [
  '**/node_modules/**',
  '**/dist/**',
  '**/.next/**',
  '**/.turbo/**',
  '**/.claude/**',
];
const PG_TESTS = '**/*.pg.test.ts';

export default defineConfig({
  test: {
    globals: true,
    environment: 'node',
    exclude: EXCLUDE,
    testTimeout: 60_000,
    hookTimeout: 60_000,
    // Les `.pg` partagent UN Postgres par run (#471) : voir la config racine et
    // packages/test-kit/src/shared-postgres.ts. Pas de projet `pg` du tout sur
    // Windows CI, où ils ne tournent pas.
    projects: [
      { extends: true, test: { name: 'unit', exclude: [...EXCLUDE, PG_TESTS] } },
      ...(isWindowsCi
        ? []
        : [
            {
              extends: true,
              test: {
                name: 'pg',
                include: [PG_TESTS],
                globalSetup: ['../test-kit/src/pg-global-setup.ts'],
              },
            },
          ]),
    ],
  },
});
