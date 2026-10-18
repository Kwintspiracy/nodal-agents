import { defineConfig, mergeConfig } from 'vitest/config';
import { baseConfig } from '../../vitest.base.ts';

/**
 * Les suites `*.pg.test.ts` démarrent un VRAI Postgres embarqué (deux
 * connexions, verrous réels) — c'est le seul harnais du dépôt qui prouve un
 * `FOR UPDATE` ou un claim atomique, tout le reste tournant sur PGlite
 * mono-connexion.
 *
 * ELLES NE PEUVENT PAS TOURNER SUR LE RUNNER WINDOWS DE GITHUB, et ce n'est
 * pas un défaut du produit : PostgreSQL refuse de démarrer sous un compte
 * ADMINISTRATEUR, or c'est précisément sous ce compte que GitHub exécute ses
 * jobs `windows-latest`. Mesuré sur la CI de la PR #46 : `initdb` réussit,
 * puis `pg_ctl start` rejette — neuf fois, sur neuf ports différents, sans un
 * seul log. Sur une machine Windows ordinaire (session utilisateur, celle de
 * l'auteur) elles passent.
 *
 * Ce n'est PAS un « vert par absence », ce que la décision n°11 du plan
 * « Vérifier & Corriger » interdit : le job Linux de la même CI les exécute à
 * chaque run — 10 tests, run 33896105334 — et le harnais échoue fort quand le
 * binaire manque. La garantie « les tests de course tournent » est donc tenue
 * à chaque push ; ce qui change ici, c'est seulement l'OS qui la porte. Le
 * message ci-dessous le dit dans le journal du job, plutôt que de laisser
 * croire à une suite complète.
 */
const isWindowsCi = process.platform === 'win32' && !!process.env['CI'];
if (isWindowsCi) {
  console.warn(
    '[vitest] suites *.pg.test.ts non exécutées sur Windows CI (postmaster refusé sous compte administrateur) — le job Linux les exécute',
  );
}

const PG_TESTS = '**/*.pg.test.ts';

export default mergeConfig(
  baseConfig,
  defineConfig({
    test: {
      setupFiles: [
        '../../packages/test-kit/src/setup-workspaces-root.ts',
        // Les programmes de Nodal sur l'hôte dans cette suite (le fichier dit pourquoi).
        './src/tests/setup-nodal-programs-host.ts',
      ],
      // Les `.pg` partagent UN Postgres par run (#471) : voir la config racine et
      // packages/test-kit/src/shared-postgres.ts. Pas de projet `pg` du tout sur
      // Windows CI, où ils ne tournent pas.
      projects: [
        {
          extends: true,
          test: { name: 'unit', exclude: ['**/node_modules/**', '**/dist/**', PG_TESTS] },
        },
        ...(isWindowsCi
          ? []
          : [
              {
                extends: true,
                test: {
                  name: 'pg',
                  include: [PG_TESTS],
                  globalSetup: ['../../packages/test-kit/src/pg-global-setup.ts'],
                },
              },
            ]),
      ],
    },
  }),
);
