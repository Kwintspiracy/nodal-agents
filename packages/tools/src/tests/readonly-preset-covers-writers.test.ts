// readonly-preset-covers-writers.test.ts — the read-only preset blocks EVERY
// always-on tool that writes the agent's folders (#1082).
//
// The preset ("read-only reviewer", READONLY_PRESET_TOOLS) is a hand list in
// @nodal-agents/shared. A writing tool given to every agent and missing from
// it lets a reviewer the owner made read-only write files the day the tool
// ships: `render_pdf` was the third such tool after `file_write` and
// `file_move`. This guard reads the registry, the only source of "which
// always-on tools write", so the next one cannot be forgotten.

import { describe, it, expect } from 'vitest';
import { READONLY_PRESET_TOOLS } from '@nodal-agents/shared';
import { createToolRegistry } from '../registry';
import { ALWAYS_ON_TOOLS, registerBuiltins } from '../builtin/index';

describe('the read-only preset covers every always-on writer @cap:approuver-une-action/moteur', () => {
  it('each always-on tool that mutates the workspace is blocked by the preset', () => {
    const registry = createToolRegistry();
    registerBuiltins(registry);
    const writers = ALWAYS_ON_TOOLS.filter((name) => registry.get(name)?.mutatesWorkspace === true);
    // The scan must have found the writers, not an empty list.
    expect(writers).toEqual(expect.arrayContaining(['file_write', 'file_move', 'render_pdf']));
    const missing = writers.filter(
      (name) => !(READONLY_PRESET_TOOLS as readonly string[]).includes(name),
    );
    expect(missing).toEqual([]);
  });
});
