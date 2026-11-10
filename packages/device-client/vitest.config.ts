import { defineConfig, mergeConfig } from 'vitest/config';
import { baseConfig } from '../../vitest.base.ts';

// Shared timeouts, environment and exclusions come from the repository's
// vitest.base.ts (see packages/test-kit/src/tests/vitest-base.test.ts).
export default mergeConfig(baseConfig, defineConfig({}));
