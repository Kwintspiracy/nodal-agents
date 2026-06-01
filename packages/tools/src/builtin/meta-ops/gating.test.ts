// gating.test.ts — proves meta-tools are only in the whitelist for the root agent,
// and only for grants that are enabled.
//
// This tests the integration of:
//   1. registerBuiltins() — registers meta-tools in the registry
//   2. computeToolWhitelist() — applies the alwaysOn union
//   3. enabledMetaTools() / parseRootGrants() — determines which tools are on
//
// The runner's execute.ts wires these together by:
//   a. Querying entities.rootAgentId + rootGrants
//   b. Computing isRoot = (rootAgentId === agentRow.id)
//   c. Building metaToolNames = isRoot ? enabledMetaTools(parseRootGrants(rootGrants)) : []
//   d. Unioning those into alwaysOn before calling computeToolWhitelist
//
// We replicate that exact pattern here at the unit level without seeding the
// target whitelist by hand — the real enabledMetaTools/whitelist path is exercised.

import { describe, it, expect } from 'vitest';
import { createToolRegistry } from '../../registry';
import { registerBuiltins, ALWAYS_ON_TOOLS } from '../index';
import { computeToolWhitelist } from '../../whitelist';
import { META_TOOLS } from './index';
import { enabledMetaTools, parseRootGrants } from '@nodal-agents/shared';
import type { RootGrants } from '@nodal-agents/shared';

const META_TOOL_NAMES = META_TOOLS.map((t) => t.name);

// ─── Fixtures ─────────────────────────────────────────────────────────────────

function makeRegistry() {
  const registry = createToolRegistry();
  registerBuiltins(registry);
  return registry;
}

/**
 * Simulate execute.ts worker branch for the ROOT agent with all grants enabled.
 * Mirrors the gating logic verbatim.
 */
function computeForRootAgent(grants: RootGrants) {
  const registry = makeRegistry();
  const metaToolNames = enabledMetaTools(parseRootGrants(grants)).filter(
    (name: string) => registry.get(name) !== undefined,
  );
  return computeToolWhitelist(
    {
      agentId: 'root-agent-id',
      configuredTools: [],
      alwaysOn: [...ALWAYS_ON_TOOLS, ...metaToolNames],
    },
    registry,
  );
}

/** Simulate a non-root agent — no metaToolNames injected. */
function computeForNonRootAgent() {
  const registry = makeRegistry();
  return computeToolWhitelist(
    {
      agentId: 'non-root-agent-id',
      configuredTools: [],
      alwaysOn: [...ALWAYS_ON_TOOLS], // no meta tools
    },
    registry,
  );
}

// ─── Tests ────────────────────────────────────────────────────────────────────

describe('meta-tool gating via root agent + grants', () => {
  it('meta-tools ARE registered in the registry after registerBuiltins()', () => {
    const registry = makeRegistry();
    for (const name of META_TOOL_NAMES) {
      expect(registry.get(name), `${name} should be in registry`).toBeDefined();
    }
  });

  it('meta-tools are NOT in ALWAYS_ON_TOOLS', () => {
    const alwaysOnSet = new Set<string>(ALWAYS_ON_TOOLS);
    for (const name of META_TOOL_NAMES) {
      expect(alwaysOnSet.has(name), `${name} must NOT be always-on`).toBe(false);
    }
  });

  it('root agent with all grants enabled gets all meta-tools in whitelist', () => {
    const allGrantsOn: RootGrants = {
      createAgent: true,
      createSkill: true,
      updateSkill: true,
      assignSkill: true,
      createMcp: true,
      createConnector: true,
      autonomy: 'fully_autonomous',
    };
    const tools = computeForRootAgent(allGrantsOn);
    const names = new Set(tools.map((t) => t.name));
    for (const name of META_TOOL_NAMES) {
      expect(names.has(name), `root agent whitelist should include ${name}`).toBe(true);
    }
  });

  it('non-root agent does NOT get any meta-tools in whitelist', () => {
    const tools = computeForNonRootAgent();
    const names = new Set(tools.map((t) => t.name));
    for (const name of META_TOOL_NAMES) {
      expect(names.has(name), `non-root whitelist must NOT include ${name}`).toBe(false);
    }
  });

  it('root agent with createAgent=false does NOT get create_agent in whitelist', () => {
    const grants: RootGrants = {
      createAgent: false,
      createSkill: true,
      updateSkill: true,
      assignSkill: true,
      createMcp: true,
      createConnector: true,
      autonomy: 'propose_confirm',
    };
    const tools = computeForRootAgent(grants);
    const names = new Set(tools.map((t) => t.name));
    expect(names.has('create_agent'), 'create_agent should be absent when grant is off').toBe(
      false,
    );
    expect(names.has('create_skill'), 'create_skill should be present').toBe(true);
    expect(names.has('attach_skill'), 'attach_skill should be present').toBe(true);
  });

  it('root agent with updateSkill=false does NOT get update_skill in whitelist', () => {
    const grants: RootGrants = {
      createAgent: true,
      createSkill: true,
      updateSkill: false,
      assignSkill: true,
      createMcp: true,
      createConnector: true,
      autonomy: 'propose_confirm',
    };
    const tools = computeForRootAgent(grants);
    const names = new Set(tools.map((t) => t.name));
    expect(names.has('update_skill'), 'update_skill should be absent when grant is off').toBe(
      false,
    );
    expect(names.has('create_skill'), 'create_skill should be present').toBe(true);
  });

  it('root agent with all grants off gets no meta-tools', () => {
    const grants: RootGrants = {
      createAgent: false,
      createSkill: false,
      updateSkill: false,
      assignSkill: false,
      createMcp: false,
      createConnector: false,
      autonomy: 'propose_confirm',
    };
    const tools = computeForRootAgent(grants);
    const names = new Set(tools.map((t) => t.name));
    for (const name of META_TOOL_NAMES) {
      expect(names.has(name), `${name} should be absent when grant is off`).toBe(false);
    }
  });

  it('always-on tools remain in whitelist regardless of root status', () => {
    const allGrantsOn: RootGrants = {
      createAgent: true,
      createSkill: true,
      updateSkill: true,
      assignSkill: true,
      createMcp: true,
      createConnector: true,
      autonomy: 'fully_autonomous',
    };
    const rootTools = computeForRootAgent(allGrantsOn);
    const nonRootTools = computeForNonRootAgent();

    for (const name of ALWAYS_ON_TOOLS) {
      const inRoot = rootTools.some((t) => t.name === name);
      const inNonRoot = nonRootTools.some((t) => t.name === name);
      expect(inRoot, `always-on ${name} should be present for root agent`).toBe(true);
      expect(inNonRoot, `always-on ${name} should be present for non-root agent`).toBe(true);
    }
  });

  it('parseRootGrants falls back to defaults for empty object (matching DB default {})', () => {
    // entities.rootGrants defaults to '{}' — parseRootGrants must handle this gracefully.
    const grants = parseRootGrants({});
    // DEFAULT_ROOT_GRANTS has all three grants = true
    expect(grants.createAgent).toBe(true);
    expect(grants.createSkill).toBe(true);
    expect(grants.updateSkill).toBe(true);
    expect(grants.assignSkill).toBe(true);
    // createMcp is a newer grant: absent → opt-in default FALSE (never granted
    // retroactively), unlike the original grants which default true.
    expect(grants.createMcp).toBe(false);
    expect(grants.createConnector).toBe(false);
  });
});
