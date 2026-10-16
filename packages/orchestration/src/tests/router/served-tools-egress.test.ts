// served-tools-egress.test.ts — every tool Nodal can serve says what it reaches
// beyond Nodal.
//
// `egress` is a declaration, like `riskLevel`: no scanner proves what a
// function contacts. This test makes it mandatory for every definition of the
// served-tool catalog (`servedToolDefinitions`: the registry, every per-job
// factory of @nodal-agents/tools, and this package's delegation tools). It
// reads the SAME list as the bench space's pre-trial check
// (packages/bench/src/space/guard.ts), which names the tools it does not cover:
// a tool added without a declaration turns this test red instead of passing,
// silently, for a local one.

import { describe, it, expect } from 'vitest';
import { DELIVERY_TOOL_NAMES } from '@nodal-agents/tools';
import { servedToolDefinitions } from '../../router/served-tools';

const served = servedToolDefinitions();

describe('egress — what a served tool reaches beyond Nodal @cap:assigner-outils/moteur', () => {
  it('the catalog holds the per-job tools, not only the registry', () => {
    const names = served.map((t) => t.name);
    for (const n of [
      'load_tools',
      'list_conversations',
      'assign_teammate',
      'create_task',
      'list_tasks',
      ...DELIVERY_TOOL_NAMES,
    ]) {
      expect(names, n).toContain(n);
    }
  });

  it('every served tool declares it', () => {
    expect(served.filter((t) => t.egress === undefined).map((t) => t.name)).toEqual([]);
  });

  it('the delivery tools, and only they, reach a channel', () => {
    const channel = served.filter((t) => t.egress === 'channel').map((t) => t.name);
    expect(channel.sort()).toEqual([...DELIVERY_TOOL_NAMES].sort());
  });

  it('the tools that reach the network on their own, beyond a channel', () => {
    // A change here is a decision about what the bench check says it does not
    // cover: it is read, not updated by reflex.
    const reach = Object.fromEntries(
      served
        .filter((t) => t.egress !== 'none' && t.egress !== 'channel')
        .map((t) => [t.name, t.egress])
        .sort(([a], [b]) => String(a).localeCompare(String(b))),
    );
    expect(reach).toEqual({
      code_task: 'process',
      declare_verification: 'process',
      generate_speech: 'model-provider',
      run_command: 'process',
      run_skill_script: 'process',
      save_memory: 'model-provider',
      web_search: 'internet',
    });
  });
});
