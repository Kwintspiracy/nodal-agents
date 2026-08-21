// office-skill-split.test.ts — TOKEN-002 (audit 2026-08-07).
//
// `office-editing` granted all 24 Office tools at once: ~7.2k tokens of tool
// schema on every turn, measured on the real definitions (xlsx 4.1k, pptx 1.7k,
// docx 1.3k). Most agents need one format. The per-format skills let them carry
// only that one; the aggregate stays for the agents that genuinely need all
// three, and for every agent already assigned to it.
//
// What must hold: the split changes WHO gets which tools, never WHICH tools
// exist. An agent on `office-editing` must come out of this with exactly the
// same palette as before.

import { describe, it, expect } from 'vitest';
import {
  systemSkills,
  officeEditingSkill,
  spreadsheetEditingSkill,
  documentEditingSkill,
  presentationEditingSkill,
} from '../index';

const FAMILIES = [
  { skill: spreadsheetEditingSkill, prefix: 'xlsx_', count: 16 },
  { skill: documentEditingSkill, prefix: 'docx_', count: 4 },
  { skill: presentationEditingSkill, prefix: 'pptx_', count: 4 },
];

describe('per-format Office skills', () => {
  it.each(FAMILIES)('$skill.slug grants only its own family', ({ skill, prefix, count }) => {
    const tools = skill.requiredBuiltins ?? [];
    expect(tools).toHaveLength(count);
    // The whole point: no cross-format tool rides along.
    expect(tools.every((t) => t.startsWith(prefix))).toBe(true);
  });

  it('all three are in the shipped catalog and assignable', () => {
    for (const { skill } of FAMILIES) {
      const found = systemSkills.find((s) => s.slug === skill.slug);
      expect(found, `${skill.slug} missing from systemSkills`).toBeDefined();
      // `capability` (the default) = shown in the library, user-assignable.
      expect(found!.kind ?? 'capability').toBe('capability');
    }
  });
});

describe('office-editing aggregate', () => {
  it('grants EXACTLY the union of the three families — no tool lost in the split', () => {
    const union = FAMILIES.flatMap(({ skill }) => skill.requiredBuiltins ?? []).sort();
    expect([...(officeEditingSkill.requiredBuiltins ?? [])].sort()).toEqual(union);
  });

  it('still grants all 24 tools, as before the split', () => {
    expect(officeEditingSkill.requiredBuiltins).toHaveLength(24);
  });

  it('keeps its slug so existing assignments keep working', () => {
    // Renaming or dropping this slug would silently strip Office tools from
    // every agent already assigned to it.
    expect(officeEditingSkill.slug).toBe('office-editing');
  });
});
