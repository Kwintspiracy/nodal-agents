// `SAFE_BY_DEFAULT_TOOL_NAMES` (@nodal-agents/shared) is what the approval card
// reads to say "Tool default: Ask first" when no rule matches. The dashboard
// cannot import the tool registry, so that list is a copy — and a copy that
// drifts turns the card's explanation into a lie, which is exactly the failure
// issue #346 was about.
//
// This test is the thing that stops the drift: it walks the REAL registry and
// fails in BOTH directions — a tool that became safe-by-default and was not
// added, and a name in the list that no tool declares any more.

import { describe, it, expect } from 'vitest';
import { SAFE_BY_DEFAULT_TOOL_NAMES, resolveToolDefaultApproval } from '../index';
import { createToolRegistry } from '../registry';
import { registerBuiltins } from '../builtin/index';

function builtinRegistry() {
  const registry = createToolRegistry();
  registerBuiltins(registry);
  return registry;
}

describe('the tool-default list the approval card reads @cap:approuver-une-action/moteur', () => {
  it('agrees with every built-in tool the registry actually holds', () => {
    const disagreements = builtinRegistry()
      .list()
      .map((tool) => ({
        name: tool.name,
        registry: tool.defaultApproval ?? 'auto_approve',
        shared: resolveToolDefaultApproval(tool.name),
      }))
      .filter((row) => row.registry !== row.shared);

    expect(disagreements).toEqual([]);
  });

  it('lists no name the registry does not know, apart from the connector tools it declares', () => {
    const known = new Set(
      builtinRegistry()
        .list()
        .map((t) => t.name),
    );
    // Connector tools are built per attached connector, so they are not in the
    // builtin registry. These two are the only ones declaring
    // `defaultApproval: 'require_approval'` (packages/adapters/cloudflare).
    const connectorTools = new Set(['cloudflare_deploy', 'cloudflare_delete_worker']);
    const orphans = SAFE_BY_DEFAULT_TOOL_NAMES.filter(
      (name) => !known.has(name) && !connectorTools.has(name),
    );

    expect(orphans).toEqual([]);
  });

  it('stays sorted, so a hand edit never hides a duplicate', () => {
    expect([...SAFE_BY_DEFAULT_TOOL_NAMES]).toEqual([...SAFE_BY_DEFAULT_TOOL_NAMES].sort());
    expect(new Set(SAFE_BY_DEFAULT_TOOL_NAMES).size).toBe(SAFE_BY_DEFAULT_TOOL_NAMES.length);
  });
});
