// Un run vitest MINUSCULE, lancé en sous-processus par pg-run-exit-code.test.ts.
// Son `globalSetup` charge `embedded-postgres` dans le processus PRINCIPAL,
// exactement comme le fait `pg-global-setup.ts` — sans démarrer de cluster, ce
// qui garde la preuve valable sur tous les OS, Windows CI compris.
import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    include: ['verdict.fixture.ts'],
    globalSetup: ['./global-setup.ts'],
  },
});
