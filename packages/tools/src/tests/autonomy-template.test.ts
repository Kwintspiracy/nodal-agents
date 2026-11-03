// autonomy-template.test.ts — the value a NEW autonomy row is written with (#917).
//
// The workspace autonomy level used to be read at run time, for a tool with no
// rule. It is a template now: it gives a row its first value, and nothing
// else. These cases are the meaning each level had at run time, now stated at
// the one place that applies it, on the REAL tool definitions.

import { describe, it, expect } from 'vitest';
import { REPLACE_SHARED_FILE_SETTING } from '@nodal-agents/shared';
import { levelTemplate, sharedFileLevelTemplate, templateAutonomy } from '../autonomy-template';
import { createToolRegistry } from '../registry';
import { registerBuiltins } from '../builtin/index';
import type { ApprovalRule } from '../types';

const registry = createToolRegistry();
registerBuiltins(registry);
const real = (name: string) => {
  const t = registry.get(name);
  if (!t) throw new Error(`${name} is not registered`);
  return t;
};

const SCOPE = { agentId: 'agent-1', entityId: 'entity-1' };
const LEVELS = ['propose_confirm', 'destructive_gate', 'fully_autonomous'] as const;

describe('levelTemplate: what each level writes for a tool @cap:regler-autonomie/moteur', () => {
  it('a tool that does not ask by itself starts Autonomous under every level', () => {
    for (const level of LEVELS) {
      expect(levelTemplate(real('file_read'), level), level).toBe('auto_approve');
      expect(levelTemplate(real('file_move'), level), level).toBe('auto_approve');
    }
  });

  it('propose_confirm keeps every asking tool on Ask first', () => {
    for (const name of ['run_command', 'create_agent', 'run_skill_script', 'code_task']) {
      expect(levelTemplate(real(name), 'propose_confirm'), name).toBe('require_approval');
    }
  });

  it('fully_autonomous lets them run, EXCEPT what runs code on this machine', () => {
    expect(levelTemplate(real('create_agent'), 'fully_autonomous')).toBe('auto_approve');
    for (const name of ['run_command', 'run_skill_script', 'code_task', 'create_mcp']) {
      expect(levelTemplate(real(name), 'fully_autonomous'), name).toBe('require_approval');
    }
  });

  it('destructive_gate: ordinary work runs, a destructive tool asks, a command is judged by the checklist', () => {
    expect(levelTemplate(real('create_agent'), 'destructive_gate')).toBe('auto_approve');
    // Opaque content, declared destructive: it asks.
    expect(levelTemplate(real('run_skill_script'), 'destructive_gate')).toBe('require_approval');
    expect(levelTemplate(real('code_task'), 'destructive_gate')).toBe('require_approval');
    // Its `destructive` level is a blanket: each command is judged instead.
    expect(levelTemplate(real('run_command'), 'destructive_gate')).toBe('auto_approve');
    expect(levelTemplate(real('declare_verification'), 'destructive_gate')).toBe('auto_approve');
  });

  it('an MCP tool asks by default, runs under the autonomous levels unless destructive', () => {
    const mcp = { name: 'srv__get_post', defaultApproval: 'require_approval' as const };
    expect(levelTemplate({ ...mcp, riskLevel: 'read' }, 'propose_confirm')).toBe(
      'require_approval',
    );
    expect(levelTemplate({ ...mcp, riskLevel: 'read' }, 'destructive_gate')).toBe('auto_approve');
    expect(levelTemplate({ ...mcp, riskLevel: 'destructive' }, 'destructive_gate')).toBe(
      'require_approval',
    );
    expect(levelTemplate({ ...mcp, riskLevel: 'destructive' }, 'fully_autonomous')).toBe(
      'auto_approve',
    );
  });

  it('the shared-file setting starts Ask first, Autonomous only under full autonomy', () => {
    expect(sharedFileLevelTemplate('propose_confirm')).toBe('require_approval');
    expect(sharedFileLevelTemplate('destructive_gate')).toBe('require_approval');
    expect(sharedFileLevelTemplate('fully_autonomous')).toBe('auto_approve');
    expect(
      templateAutonomy(
        { name: REPLACE_SHARED_FILE_SETTING, riskLevel: 'write' },
        { level: 'fully_autonomous', rules: [], ...SCOPE },
      ),
    ).toBe('auto_approve');
  });
});

describe('templateAutonomy: a rule the owner set gives the new row its value @cap:regler-autonomie/moteur', () => {
  const rule = (over: Partial<ApprovalRule>): ApprovalRule => ({
    id: 'r',
    toolName: '*',
    action: 'auto_approve',
    agentId: SCOPE.agentId,
    entityId: SCOPE.entityId,
    ...over,
  });

  it('a server the owner trusted: its new tool starts with that trust, whatever the level', () => {
    const rules = [rule({ toolName: 'srv__*', action: 'auto_approve' })];
    const tool = {
      name: 'srv__new_tool',
      riskLevel: 'write' as const,
      defaultApproval: 'require_approval' as const,
    };
    for (const level of LEVELS) {
      expect(templateAutonomy(tool, { level, rules, ...SCOPE }), level).toBe('auto_approve');
    }
  });

  it('a rule for every agent naming the tool comes before the server', () => {
    const rules = [
      rule({ toolName: 'srv__*', action: 'auto_approve' }),
      rule({ toolName: 'srv__purge', agentId: null, action: 'block' }),
    ];
    expect(
      templateAutonomy(
        { name: 'srv__purge', riskLevel: 'destructive' },
        { level: 'fully_autonomous', rules, ...SCOPE },
      ),
    ).toBe('block');
  });

  it('a `*` Autonomous never makes a code-running tool Autonomous; hardening still applies', () => {
    const permissive = [rule({ toolName: '*', action: 'auto_approve' })];
    expect(
      templateAutonomy(real('run_command'), {
        level: 'propose_confirm',
        rules: permissive,
        ...SCOPE,
      }),
    ).toBe('require_approval');
    expect(
      templateAutonomy(real('file_read'), {
        level: 'propose_confirm',
        rules: permissive,
        ...SCOPE,
      }),
    ).toBe('auto_approve');
    const strict = [rule({ toolName: '*', action: 'block' })];
    expect(
      templateAutonomy(real('run_command'), { level: 'fully_autonomous', rules: strict, ...SCOPE }),
    ).toBe('block');
  });

  it('a row the agent already holds is not a template: only the level and template rules count', () => {
    // The writer never overwrites an existing row; the template does not even
    // read it.
    const rules = [rule({ toolName: 'run_command', action: 'auto_approve' })];
    expect(
      templateAutonomy(real('run_command'), { level: 'propose_confirm', rules, ...SCOPE }),
    ).toBe('require_approval');
  });
});
