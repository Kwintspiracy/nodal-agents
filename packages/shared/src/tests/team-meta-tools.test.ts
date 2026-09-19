// team-meta-tools.test.ts — `metaToolsForAgent`, the filter behind the per-agent
// "May change its own team" setting (issue #137).
//
// @cap:assigner-outils/moteur
//
// What this proves: the three tools that recompose a team leave the list when
// the setting is off, and NOTHING else leaves it. The assertions are on the
// returned array — the real names an agent would be handed — never on a call
// count.
//
// The wiring into a real job's toolset is proved by
// `apps/runner/src/tests/job/may-change-team.test.ts`, which runs an actual job
// and reads the tools the model received.

import { describe, it, expect } from 'vitest';
import {
  metaToolsForAgent,
  enabledMetaTools,
  isTeamChangingMetaTool,
  TEAM_CHANGING_META_TOOLS,
  DEFAULT_ROOT_GRANTS,
  type RootGrants,
} from '../root-agent';

const ALL_ON: RootGrants = {
  createAgent: true,
  updateAgent: true,
  attachAgent: true,
  createSkill: true,
  updateSkill: true,
  assignSkill: true,
  createMcp: true,
  attachMcp: true,
  createConnector: true,
  attachConnector: true,
  manageSchedules: true,
  autonomy: 'fully_autonomous',
};

describe('metaToolsForAgent @cap:assigner-outils/moteur', () => {
  it('drops create_agent, attach_agent and detach_agent when the setting is off', () => {
    const names = metaToolsForAgent(ALL_ON, { mayChangeTeam: false });
    expect(names).not.toContain('create_agent');
    expect(names).not.toContain('attach_agent');
    expect(names).not.toContain('detach_agent');
  });

  it('keeps every other meta-tool the grants enable', () => {
    const off = metaToolsForAgent(ALL_ON, { mayChangeTeam: false });
    const all = enabledMetaTools(ALL_ON);
    const removed = all.filter((n) => !off.includes(n));
    // Exactly the three, and the rest of the list is untouched.
    expect([...removed].sort()).toEqual(['attach_agent', 'create_agent', 'detach_agent']);
    expect(off).toEqual(all.filter((n) => !removed.includes(n)));
    expect(off).toContain('update_agent');
    expect(off).toContain('attach_skill');
    expect(off).toContain('create_schedule');
  });

  it('returns the full granted list when the setting is on', () => {
    const on = metaToolsForAgent(ALL_ON, { mayChangeTeam: true });
    expect(on).toEqual(enabledMetaTools(ALL_ON));
    expect(on).toContain('create_agent');
    expect(on).toContain('attach_agent');
    expect(on).toContain('detach_agent');
  });

  it('never ADDS a tool the grants refuse — the setting can only take away', () => {
    const noTeamGrants: RootGrants = { ...ALL_ON, createAgent: false, attachAgent: false };
    const on = metaToolsForAgent(noTeamGrants, { mayChangeTeam: true });
    expect(on).not.toContain('create_agent');
    expect(on).not.toContain('attach_agent');
    expect(on).not.toContain('detach_agent');
  });

  it('leaves an agent with no grants at all with nothing, either way', () => {
    const noGrants: RootGrants = {
      createAgent: false,
      updateAgent: false,
      attachAgent: false,
      createSkill: false,
      updateSkill: false,
      assignSkill: false,
      createMcp: false,
      attachMcp: false,
      createConnector: false,
      attachConnector: false,
      manageSchedules: false,
      autonomy: 'propose_confirm',
    };
    expect(metaToolsForAgent(noGrants, { mayChangeTeam: false })).toEqual([]);
    expect(metaToolsForAgent(noGrants, { mayChangeTeam: true })).toEqual([]);
  });

  it('the workspace defaults still hand out the three only when the agent may', () => {
    // DEFAULT_ROOT_GRANTS has createAgent and attachAgent ON — that is exactly
    // the state the 2026-09-15 incident ran in, and the setting is what now
    // stands between those grants and the tools.
    expect(metaToolsForAgent(DEFAULT_ROOT_GRANTS, { mayChangeTeam: false })).not.toContain(
      'attach_agent',
    );
    expect(metaToolsForAgent(DEFAULT_ROOT_GRANTS, { mayChangeTeam: true })).toContain(
      'attach_agent',
    );
  });
});

describe('isTeamChangingMetaTool @cap:assigner-outils/moteur', () => {
  it('names the three team tools and nothing else', () => {
    expect([...TEAM_CHANGING_META_TOOLS].sort()).toEqual([
      'attach_agent',
      'create_agent',
      'detach_agent',
    ]);
    for (const name of TEAM_CHANGING_META_TOOLS) {
      expect(isTeamChangingMetaTool(name)).toBe(true);
    }
    for (const name of ['update_agent', 'attach_skill', 'attach_mcp', 'create_connector']) {
      expect(isTeamChangingMetaTool(name)).toBe(false);
    }
  });
});
