// gating.test.ts — proves office tools are only in the whitelist for agents
// that hold the office-editing skill.
//
// This tests the integration of:
//   1. registerBuiltins() — registers office tools in the registry
//   2. computeToolWhitelist() — applies the alwaysOn union
//   3. requiredBuiltins in officeEditingSkill — the skill's tool list
//
// The runner's execute.ts wires these together by:
//   a. JOINing agentSkillAssignments → agentSkills to get requiredBuiltins
//   b. Unioning those into alwaysOn before calling computeToolWhitelist
//
// We replicate that exact pattern here at the unit level.

import { describe, it, expect } from 'vitest';
import { createToolRegistry } from '../../registry';
import { registerBuiltins, ALWAYS_ON_TOOLS } from '../index';
import { computeToolWhitelist } from '../../whitelist';
import { OFFICE_TOOLS } from './index';

// The canonical requiredBuiltins for the office-editing skill.
// Kept in sync with packages/catalog/src/skills/office-editing.ts.
const OFFICE_EDITING_REQUIRED_BUILTINS = [
  'xlsx_read',
  'xlsx_set_cell',
  'xlsx_set_range',
  'xlsx_append_rows',
  'xlsx_add_sheet',
  'xlsx_create',
  'xlsx_delete_rows',
  'docx_read',
  'docx_create',
  'docx_append_paragraphs',
  'pptx_read',
  'pptx_create',
];

const OFFICE_TOOL_NAMES = OFFICE_TOOLS.map((t) => t.name);

// ─── Fixtures ─────────────────────────────────────────────────────────────────

function makeRegistry() {
  const registry = createToolRegistry();
  registerBuiltins(registry);
  return registry;
}

// Simulate execute.ts worker branch for an agent WITH the office-editing skill.
function computeForAgentWithOfficeSkill() {
  const registry = makeRegistry();
  // Simulate the runner: union requiredBuiltins from assigned skills into alwaysOn
  const skillBuiltins = OFFICE_EDITING_REQUIRED_BUILTINS;
  const registeredSkillBuiltins = skillBuiltins.filter(
    (n: string) => registry.get(n) !== undefined,
  );

  return computeToolWhitelist(
    {
      agentId: 'agent-with-skill',
      configuredTools: [], // no extra configured tools
      alwaysOn: [...ALWAYS_ON_TOOLS, ...registeredSkillBuiltins],
    },
    registry,
  );
}

// Simulate execute.ts worker branch for an agent WITHOUT the office-editing skill.
function computeForAgentWithoutOfficeSkill() {
  const registry = makeRegistry();
  // No requiredBuiltins from skills
  return computeToolWhitelist(
    {
      agentId: 'agent-without-skill',
      configuredTools: [],
      alwaysOn: [...ALWAYS_ON_TOOLS], // only always-on, no skill builtins
    },
    registry,
  );
}

// ─── Tests ────────────────────────────────────────────────────────────────────

describe('office tool gating via requiredBuiltins', () => {
  it('office tools ARE registered in the registry after registerBuiltins()', () => {
    const registry = makeRegistry();
    for (const name of OFFICE_TOOL_NAMES) {
      expect(registry.get(name), `${name} should be in registry`).toBeDefined();
    }
  });

  it('office tools are NOT in ALWAYS_ON_TOOLS', () => {
    const alwaysOnSet = new Set<string>(ALWAYS_ON_TOOLS);
    for (const name of OFFICE_TOOL_NAMES) {
      expect(alwaysOnSet.has(name), `${name} must NOT be always-on`).toBe(false);
    }
  });

  it('agent WITH office-editing skill gets all 12 office tools in whitelist', () => {
    const tools = computeForAgentWithOfficeSkill();
    const names = new Set(tools.map((t) => t.name));
    for (const name of OFFICE_TOOL_NAMES) {
      expect(names.has(name), `whitelist should include ${name}`).toBe(true);
    }
  });

  it('agent WITHOUT office-editing skill does NOT get any office tools in whitelist', () => {
    const tools = computeForAgentWithoutOfficeSkill();
    const names = new Set(tools.map((t) => t.name));
    for (const name of OFFICE_TOOL_NAMES) {
      expect(names.has(name), `whitelist must NOT include ${name} without skill`).toBe(false);
    }
  });

  it('OFFICE_EDITING_REQUIRED_BUILTINS contains exactly the 12 office tool names', () => {
    const expected = new Set(OFFICE_TOOL_NAMES);
    const actual = new Set(OFFICE_EDITING_REQUIRED_BUILTINS);
    expect(actual.size).toBe(expected.size);
    for (const name of expected) {
      expect(actual.has(name), `requiredBuiltins should list ${name}`).toBe(true);
    }
  });

  it('always-on tools remain in whitelist regardless of skill', () => {
    const withSkill = computeForAgentWithOfficeSkill();
    const withoutSkill = computeForAgentWithoutOfficeSkill();

    for (const name of ALWAYS_ON_TOOLS) {
      const inWith = withSkill.some((t) => t.name === name);
      const inWithout = withoutSkill.some((t) => t.name === name);
      expect(inWith, `always-on ${name} should be present with skill`).toBe(true);
      expect(inWithout, `always-on ${name} should be present without skill`).toBe(true);
    }
  });
});
