// Un run vitest MINUSCULE, lancé en sous-processus par vitest-worker-exit.test.ts,
// sur la configuration PARTAGÉE (vitest.base.ts) : ce qu'il prouve vaut pour
// chaque paquet du dépôt, pas pour une configuration écrite pour le test.
import { defineConfig, mergeConfig } from 'vitest/config';
import { baseConfig } from '../../../../../../vitest.base.ts';

export default mergeConfig(
  baseConfig,
  defineConfig({
    test: {
      include: [
        process.env['WORKER_EXIT_FIXTURE'] === 'dies' ? 'dies.fixture.ts' : 'lives.fixture.ts',
      ],
    },
  }),
);
