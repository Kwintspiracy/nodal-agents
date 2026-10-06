// Un run vitest MINUSCULE, lancé en sous-processus par pg-run-exit-code.test.ts.
// Son `globalSetup` charge `embedded-postgres` dans le processus PRINCIPAL,
// exactement comme le fait `pg-global-setup.ts` — sans démarrer de cluster, ce
// qui garde la preuve valable sur tous les OS, Windows CI compris. Avec
// `PG_RUN_EXIT_CODE_SETUP=bypass`, le paquet est chargé une première fois SANS
// la porte, puis par elle.
import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    include: ['verdict.fixture.ts'],
    globalSetup: [
      process.env['PG_RUN_EXIT_CODE_SETUP'] === 'bypass'
        ? './global-setup-bypass.ts'
        : './global-setup.ts',
    ],
  },
});
