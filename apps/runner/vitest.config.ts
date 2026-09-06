import { defineConfig } from 'vitest/config';

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

export default defineConfig({
  test: {
    setupFiles: ['./src/tests/setup-workspaces-root.ts'],
    ...(isWindowsCi ? { exclude: ['**/node_modules/**', '**/dist/**', '**/*.pg.test.ts'] } : {}),
    // This per-package config SHADOWS the root vitest.config.ts entirely —
    // the root's generous timeouts must be replicated here or runner tests
    // fall back to the 5s default and flake on oversubscribed CI runners
    // (see the root config's comment; observed on install.test.ts, CI run
    // 29939729072: 100MB-buffer zip-guard tests + pglite spin-up > 5s).
    testTimeout: 60_000,
    hookTimeout: 60_000,
  },
});
