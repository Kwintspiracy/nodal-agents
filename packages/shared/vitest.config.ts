import { defineConfig, mergeConfig } from 'vitest/config';
import { baseConfig, WORKSPACES_ROOT_SETUP } from '../../vitest.base.ts';

// Shared timeouts, environment and exclusions come from the repository's
// vitest.base.ts; this package adds nothing of its own. The config exists (and
// merges the base FIRST) so that nothing depends on vitest looking in a parent
// directory — see packages/test-kit/src/tests/vitest-base.test.ts.
export default mergeConfig(
  baseConfig,
  defineConfig({
    test: { setupFiles: [WORKSPACES_ROOT_SETUP] },
  }),
);
