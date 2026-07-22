// skill-tool-groups.test.ts — pure unit tests for isToolGroupSkill. No DB.

import { describe, it, expect } from 'vitest';
import { isToolGroupSkill } from '../skill-tool-groups.ts';

describe('isToolGroupSkill', () => {
  it('matches a system skill that gates native builtins (office-editing shape)', () => {
    expect(
      isToolGroupSkill({
        systemKind: 'capability',
        requiredBuiltins: ['xlsx_read', 'xlsx_create'],
      }),
    ).toBe(true);
  });

  it('rejects a system skill with no gated builtins (citation-discipline shape)', () => {
    expect(
      isToolGroupSkill({
        systemKind: 'baseline',
        requiredBuiltins: [],
      }),
    ).toBe(false);
  });

  it('rejects a community skill with bundled scripts but no requiredBuiltins gate', () => {
    expect(
      isToolGroupSkill({
        systemKind: null,
        requiredBuiltins: [],
      }),
    ).toBe(false);
  });

  it('rejects a learned skill (no systemKind, no requiredBuiltins)', () => {
    expect(
      isToolGroupSkill({
        systemKind: null,
        requiredBuiltins: [],
      }),
    ).toBe(false);
  });
});
