// skill-provenance.test.ts — unit tests for provenance helpers (learning-loop Phase A)
// These are pure functions with no DB dependency — fast, always green.

import { describe, it, expect } from 'vitest';
import { isAgentCurated, isProtectedSkill } from '../entities/skill';
import type { SkillCreatedBy } from '../entities/skill';

describe('isAgentCurated', () => {
  it('returns true only for agent-created skills', () => {
    expect(isAgentCurated({ createdBy: 'agent' })).toBe(true);
  });

  it('returns false for user-created skills', () => {
    expect(isAgentCurated({ createdBy: 'user' })).toBe(false);
  });

  it('returns false for system-created skills', () => {
    expect(isAgentCurated({ createdBy: 'system' })).toBe(false);
  });

  it('covers every SkillCreatedBy value — isAgentCurated is exclusive to "agent"', () => {
    const values: SkillCreatedBy[] = ['user', 'system', 'agent'];
    const results = values.map((v) => isAgentCurated({ createdBy: v }));
    // Exactly one value should be true
    expect(results.filter(Boolean)).toHaveLength(1);
    expect(results).toEqual([false, false, true]);
  });
});

describe('isProtectedSkill', () => {
  it('returns true for user-created skills', () => {
    expect(isProtectedSkill({ createdBy: 'user' })).toBe(true);
  });

  it('returns true for system-created skills', () => {
    expect(isProtectedSkill({ createdBy: 'system' })).toBe(true);
  });

  it('returns false for agent-created skills', () => {
    expect(isProtectedSkill({ createdBy: 'agent' })).toBe(false);
  });

  it('covers every SkillCreatedBy value — isProtectedSkill excludes "agent"', () => {
    const values: SkillCreatedBy[] = ['user', 'system', 'agent'];
    const results = values.map((v) => isProtectedSkill({ createdBy: v }));
    expect(results).toEqual([true, true, false]);
  });

  it('isProtectedSkill and isAgentCurated are mutually exclusive across all values', () => {
    const values: SkillCreatedBy[] = ['user', 'system', 'agent'];
    for (const v of values) {
      const skill = { createdBy: v };
      // They cannot both be true for the same skill
      expect(isProtectedSkill(skill) && isAgentCurated(skill)).toBe(false);
    }
  });
});
