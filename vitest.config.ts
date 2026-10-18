import { fileURLToPath } from 'node:url';
import { defineConfig, mergeConfig } from 'vitest/config';
import { baseConfig, EXCLUDE } from './vitest.base.ts';

const PG_TESTS = '**/*.pg.test.ts';
// Même garde que packages/db et apps/runner (revue de la PR #499) : sur Windows
// CI, le postmaster est refusé sous compte administrateur et les `.pg` ne
// tournent pas. `pnpm test` passe par turbo, donc par les configs des paquets,
// mais un `vitest run` lancé à la racine sur ce runner les aurait lancés.
const isWindowsCi = process.platform === 'win32' && !!process.env['CI'];

export default mergeConfig(
  baseConfig,
  defineConfig({
    test: {
      globals: true,
      environment: 'node',
      exclude: EXCLUDE,
      // Every package, not only apps/runner: since #506 the team block builds
      // each agent's run folders, shared one included, and creating that folder
      // under a synthetic entity id must never touch the real home directory.
      setupFiles: [
        fileURLToPath(new URL('./packages/test-kit/src/setup-workspaces-root.ts', import.meta.url)),
      ],
      // Deux projets (#471). Les fichiers `.pg.test.ts` partagent UN Postgres
      // par run, démarré par le `globalSetup` de leur projet — vitest ne
      // l'appelle que si le run contient au moins un de ces fichiers. Voir
      // packages/test-kit/src/shared-postgres.ts.
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
                  globalSetup: ['./packages/test-kit/src/pg-global-setup.ts'],
                },
              },
            ]),
      ],
      coverage: {
        provider: 'v8',
        reporter: ['text', 'json-summary'],
        exclude: [
          '**/node_modules/**',
          '**/dist/**',
          '**/.next/**',
          '**/.turbo/**',
          '**/*.config.*',
          '**/coverage/**',
        ],
      },
    },
  }),
);
