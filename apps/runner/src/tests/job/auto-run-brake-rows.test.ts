// auto-run-brake-rows.test.ts — the workspace brake holds the agent's ROW (#917).
//
// The gate reads the agent's row for a tool and nothing else. The brake must
// therefore leave every code-running tool with an agent row on Ask first: a
// template rule left behind (a rule for every agent, a server) holds nothing at
// run time, and the call would be refused for a missing row instead of asking.

import { describe, it, expect } from 'vitest';
import { CODE_EXECUTION_TOOL_NAMES, matchApprovalRule } from '@nodal-agents/tools';
import type { ApprovalRule } from '@nodal-agents/tools';
import { applyAutoRunBrake } from '../../job/approval-rules.ts';

const AGENT = 'agent-1';
const ENTITY = 'entity-1';

const row = (
  toolName: string,
  action: ApprovalRule['action'],
  agentId: string | null = AGENT,
): ApprovalRule => ({
  id: `r-${toolName}-${agentId}`,
  toolName,
  action,
  agentId,
  entityId: ENTITY,
});

describe('the auto-run brake acts on rows (#917) @cap:executer-une-commande/moteur', () => {
  it('engaged: every code-running tool of the agent asks, its Autonomous row dormant', () => {
    const rules = [row('run_command', 'auto_approve'), row('file_read', 'auto_approve')];
    const braked = applyAutoRunBrake(rules, {
      autoRunPaused: true,
      agentId: AGENT,
      entityId: ENTITY,
    });
    for (const tool of CODE_EXECUTION_TOOL_NAMES) {
      expect(matchApprovalRule(braked, tool, AGENT, ENTITY)?.action, tool).toBe('require_approval');
    }
    // A tool that runs no code keeps its row.
    expect(matchApprovalRule(braked, 'file_read', AGENT, ENTITY)?.action).toBe('auto_approve');
  });

  it('a rule for every agent on run_command does not stand in for the agent row: the brake still writes one', () => {
    const rules = [row('run_command', 'require_approval', null)];
    const braked = applyAutoRunBrake(rules, {
      autoRunPaused: true,
      agentId: AGENT,
      entityId: ENTITY,
    });
    expect(matchApprovalRule(braked, 'run_command', AGENT, ENTITY)?.action).toBe(
      'require_approval',
    );
  });

  it('a Block row stays Block: the brake only hardens', () => {
    const braked = applyAutoRunBrake([row('run_command', 'block')], {
      autoRunPaused: true,
      agentId: AGENT,
      entityId: ENTITY,
    });
    expect(matchApprovalRule(braked, 'run_command', AGENT, ENTITY)?.action).toBe('block');
  });

  it('released: the rows are applied as they are', () => {
    const rules = [row('run_command', 'auto_approve')];
    expect(
      applyAutoRunBrake(rules, { autoRunPaused: false, agentId: AGENT, entityId: ENTITY }),
    ).toEqual(rules);
  });
});
