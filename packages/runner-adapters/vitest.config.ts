import { defineConfig, mergeConfig } from 'vitest/config';
import { fileURLToPath } from 'node:url';
import { baseConfig, WORKSPACES_ROOT_SETUP } from '../../vitest.base.ts';

// A test that reaches the network fails (packages/test-kit/src/no-network.ts).
const NO_NETWORK = fileURLToPath(new URL('../test-kit/src/setup-no-network.ts', import.meta.url));

// Shared timeouts, environment and exclusions come from the repository's
// vitest.base.ts; this package adds nothing of its own. The config exists (and
// merges the base FIRST) so that nothing depends on vitest looking in a parent
// directory — see packages/test-kit/src/tests/vitest-base.test.ts.
export default mergeConfig(
  baseConfig,
  defineConfig({
    test: {
      setupFiles: [WORKSPACES_ROOT_SETUP, NO_NETWORK],
      // The connector conformance suite runs its ~170 operations concurrently
      // (each waits on timers, not on the CPU).
      maxConcurrency: 64,
    },
  }),
);
