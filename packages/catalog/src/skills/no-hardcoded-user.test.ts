// no-hardcoded-user.test.ts — Finding I-5: a system skill must never hardcode
// a specific user's name (invariant #6, "no per-user hardcoded values"). This
// scans every shipped system skill's content for the operator's own name so
// the regression can't silently reappear in a future skill edit.

import { describe, it, expect } from 'vitest';
import { systemSkills } from '../index';

describe('system skill catalog — no hardcoded per-user values (I-5)', () => {
  it('no skill content mentions "Quentin"', () => {
    for (const skill of systemSkills) {
      expect(skill.content, `${skill.slug} must not reference a specific user by name`).not.toMatch(
        /quentin/i,
      );
    }
  });
});
