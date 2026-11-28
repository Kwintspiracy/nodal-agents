// setup-no-network.ts — vitest setupFile: the test file fails if it reached the network.
//
// Listed in `setupFiles` by every connector adapter package and by
// runner-adapters (where the connector conformance suite runs). See
// no-network.ts for how the guard works and what it lets through (this
// machine only).

import { afterAll } from 'vitest';
import {
  installNetworkGuard,
  networkAttemptsMessage,
  takeUnscopedNetworkAttempts,
} from './no-network.ts';

// Installed when the file loads, before any test module runs its own code.
installNetworkGuard();

afterAll(() => {
  const attempts = takeUnscopedNetworkAttempts();
  if (attempts.length > 0) throw new Error(networkAttemptsMessage(attempts));
});
