// @nodal-agents/device-client — architecture invariant tests.

import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import {
  assertNoViolations,
  scanForAgentSlugs,
  scanForDbDriverImports,
  scanForHardcodedUuids,
} from '@nodal-agents/test-kit';

const srcDir = join(fileURLToPath(import.meta.url), '..', '..');

describe('architecture invariants', () => {
  it('no agent or server slug hardcoded in source (invariant #1)', () => {
    assertNoViolations('slugs d’agent', scanForAgentSlugs({ srcDir }));
  });

  it('no per-user UUID in source (invariant #6)', () => {
    assertNoViolations('UUID en dur', scanForHardcodedUuids({ srcDir, skipDirs: ['tests'] }));
  });

  it('does not import a database driver (only packages/db may)', () => {
    assertNoViolations('driver DB', scanForDbDriverImports({ srcDir }));
  });

  it('the client imports nothing but its generated protocol: no runtime dependency', () => {
    const source = readFileSync(join(srcDir, 'nodal-device.ts'), 'utf8');
    const specifiers = [
      ...source.matchAll(/^\s*(?:import|export)\b[^;]*?\bfrom\s+'([^']+)'/gm),
    ].map((m) => m[1]);
    expect(new Set(specifiers)).toEqual(new Set(['./protocol.generated.ts']));
    const generated = readFileSync(join(srcDir, 'protocol.generated.ts'), 'utf8');
    expect(generated).not.toMatch(/\bfrom\s+'|\bimport\(/);
  });
});
