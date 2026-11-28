// architecture.test.ts — the invariants of @nodal-agents/checkpoints, applied
// mechanically by the shared scanners (@nodal-agents/test-kit).
//
// Born with the launcher of Nodal's own git: this package runs more git than
// any other (snapshot, status, diff, restore), on folders agents write, and
// every one of those processes must go through `runInternalGit` /
// `spawnInternalGit` (@nodal-agents/shared/internal-git). Its tests live in
// `src/` beside the code; the scanner does not read test files.

import { describe, it } from 'vitest';
import { dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { assertNoViolations, scanForGitSpawnOutsideLauncher } from '@nodal-agents/test-kit';

const srcDir = dirname(fileURLToPath(import.meta.url));

describe('architecture invariants', () => {
  it('starts git for itself only through the launcher (@nodal-agents/shared/internal-git)', () => {
    assertNoViolations('git lancé hors du lanceur', scanForGitSpawnOutsideLauncher({ srcDir }));
  });
});
