// La chaîne de règles d'approbation — l'ORDRE que la porte suit, et que la
// carte montre. Issue #346 : la carte promettait « ça tournera sans demander »
// pendant qu'une règle plus précise continuait de demander, parce que l'ordre
// n'était lisible nulle part.
//
// Ces tests portent sur la fonction PURE (`explainApprovalRules`) ET sur
// `matchApprovalRule`, qui en dérive : si les deux divergeaient, la carte
// mentirait de nouveau.

import { describe, it, expect } from 'vitest';
import {
  explainApprovalRules,
  matchApprovalRule,
  normaliseWorkspacePath,
  workspaceMatches,
  resolveToolDefaultApproval,
} from '../index';
import type { ApprovalRule } from '../types';

const AGENT = 'agent-1';
const OTHER_AGENT = 'agent-2';
const ENTITY = 'entity-1';
const TOOL = 'mcp_playwright__browser_run_code_unsafe';

function rule(over: Partial<ApprovalRule> & { id: string }): ApprovalRule {
  return {
    toolName: TOOL,
    action: 'auto_approve',
    agentId: AGENT,
    entityId: ENTITY,
    ...over,
  };
}

describe('explainApprovalRules @cap:approuver-une-action/moteur', () => {
  it('orders every matching rule most specific first, and marks only the first as winning', () => {
    const rules: ApprovalRule[] = [
      rule({ id: 'entity-wildcard', toolName: '*', agentId: null, action: 'require_approval' }),
      rule({ id: 'agent-server', toolName: 'mcp_playwright__*', action: 'auto_approve' }),
      rule({ id: 'entity-tool', agentId: null, action: 'require_approval' }),
      rule({ id: 'agent-wildcard', toolName: '*', action: 'auto_approve' }),
      rule({
        id: 'entity-server',
        toolName: 'mcp_playwright__*',
        agentId: null,
        action: 'block',
      }),
      rule({ id: 'agent-tool', action: 'block' }),
    ];

    const chain = explainApprovalRules(rules, TOOL, AGENT, ENTITY);

    expect(chain.map((r) => r.id)).toEqual([
      'agent-tool',
      'entity-tool',
      'agent-server',
      'entity-server',
      'agent-wildcard',
      'entity-wildcard',
    ]);
    expect(chain.map((r) => r.wins)).toEqual([true, false, false, false, false, false]);
    expect(chain.map((r) => r.tier)).toEqual([
      'agent-tool',
      'entity-tool',
      'agent-server',
      'entity-server',
      'agent-all',
      'entity-all',
    ]);
    expect(chain.map((r) => r.scope)).toEqual([
      'agent',
      'entity',
      'agent',
      'entity',
      'agent',
      'entity',
    ]);
  });

  it('reproduces issue #346: an Everyone rule NAMING the tool beats the agent server wildcard', () => {
    const rules: ApprovalRule[] = [
      // 2026-09-18, entity-wide, names the exact tool.
      rule({ id: 'everyone-exact', agentId: null, action: 'require_approval' }),
      // 2026-09-21, the "Always for this server" answer.
      rule({ id: 'agent-server', toolName: 'mcp_playwright__*', action: 'auto_approve' }),
    ];

    const chain = explainApprovalRules(rules, TOOL, AGENT, ENTITY);

    expect(chain[0]).toMatchObject({
      id: 'everyone-exact',
      action: 'require_approval',
      scope: 'entity',
      wins: true,
    });
    expect(chain[1]).toMatchObject({ id: 'agent-server', wins: false });
    expect(matchApprovalRule(rules, TOOL, AGENT, ENTITY)?.id).toBe('everyone-exact');
  });

  it('ignores rules belonging to another agent or another entity', () => {
    const rules: ApprovalRule[] = [
      rule({ id: 'other-agent', agentId: OTHER_AGENT, action: 'block' }),
      rule({ id: 'other-entity', agentId: null, entityId: 'entity-9', action: 'block' }),
      rule({ id: 'mine', toolName: '*', action: 'auto_approve' }),
    ];

    expect(explainApprovalRules(rules, TOOL, AGENT, ENTITY).map((r) => r.id)).toEqual(['mine']);
  });

  it('returns an empty chain when nothing matches, so the caller falls back to the tool default', () => {
    expect(explainApprovalRules([], TOOL, AGENT, ENTITY)).toEqual([]);
    expect(matchApprovalRule([], TOOL, AGENT, ENTITY)).toBeUndefined();
  });

  it('hands back the WINNING row even when two rules share an id', () => {
    // Nothing in the type says ids are distinct, and the test-kit builders hand
    // out the same one. Looking the winner up by id made the gate return the
    // first rule of the array instead - a `require_approval` silently becoming
    // an `auto_approve`.
    const rules: ApprovalRule[] = [
      rule({ id: 'same', toolName: '*', agentId: null, action: 'auto_approve' }),
      rule({ id: 'same', action: 'require_approval' }),
    ];
    expect(matchApprovalRule(rules, TOOL, AGENT, ENTITY)?.action).toBe('require_approval');
    expect(explainApprovalRules(rules, TOOL, AGENT, ENTITY)[0]?.sourceIndex).toBe(1);
  });

  it('never marks a second winner, whatever the array order', () => {
    const rules: ApprovalRule[] = [
      rule({ id: 'agent-wildcard', toolName: '*' }),
      rule({ id: 'agent-tool' }),
    ];
    expect(explainApprovalRules(rules, TOOL, AGENT, ENTITY).filter((r) => r.wins)).toHaveLength(1);
    expect(explainApprovalRules(rules, TOOL, AGENT, ENTITY)[0]?.id).toBe('agent-tool');
  });
});

describe('explainApprovalRules — the folder condition @cap:approuver-une-action/moteur', () => {
  const FOLDER = 'D:/APPS/NodalAI';
  const conditioned = rule({
    id: 'in-folder',
    toolName: 'run_command',
    action: 'auto_approve',
    conditionJson: { workspacePath: FOLDER },
  });

  it('applies, and wins over everything, when the job works in that folder', () => {
    const rules: ApprovalRule[] = [
      rule({ id: 'everyone-exact', toolName: 'run_command', agentId: null, action: 'block' }),
      conditioned,
    ];
    const chain = explainApprovalRules(rules, 'run_command', AGENT, ENTITY, [
      { label: 'nodal', path: FOLDER },
    ]);

    expect(chain[0]).toMatchObject({
      id: 'in-folder',
      tier: 'agent-tool-in-folder',
      workspacePath: FOLDER,
      workspaceLabel: 'nodal',
      wins: true,
    });
    expect(chain[1]).toMatchObject({ id: 'everyone-exact', wins: false });
    expect(
      matchApprovalRule(rules, 'run_command', AGENT, ENTITY, [{ label: 'nodal', path: FOLDER }])
        ?.action,
    ).toBe('auto_approve');
  });

  it('is left out entirely when the job works somewhere else, and the next rule decides', () => {
    const rules: ApprovalRule[] = [
      rule({ id: 'everyone-exact', toolName: 'run_command', agentId: null, action: 'block' }),
      conditioned,
    ];
    const chain = explainApprovalRules(rules, 'run_command', AGENT, ENTITY, [
      { label: 'elsewhere', path: 'D:/APPS/Other' },
    ]);

    expect(chain.map((r) => r.id)).toEqual(['everyone-exact']);
    expect(chain[0]?.wins).toBe(true);
    expect(
      matchApprovalRule(rules, 'run_command', AGENT, ENTITY, [
        { label: 'elsewhere', path: 'D:/APPS/Other' },
      ])?.action,
    ).toBe('block');
  });

  it('is inapplicable when the caller supplies no workspaces at all', () => {
    expect(explainApprovalRules([conditioned], 'run_command', AGENT, ENTITY)).toEqual([]);
    expect(matchApprovalRule([conditioned], 'run_command', AGENT, ENTITY)).toBeUndefined();
  });

  it('matches the same folder written with backslashes and a different case, on win32', () => {
    const chain = explainApprovalRules(
      [conditioned],
      'run_command',
      AGENT,
      ENTITY,
      [{ label: 'nodal', path: 'd:\\apps\\nodalai\\' }],
      'win32',
    );
    expect(chain.map((r) => r.id)).toEqual(['in-folder']);
  });

  it('keeps case significant on a POSIX platform', () => {
    const posix = rule({
      id: 'posix',
      toolName: 'run_command',
      conditionJson: { workspacePath: '/home/q/Apps' },
    });
    expect(
      explainApprovalRules(
        [posix],
        'run_command',
        AGENT,
        ENTITY,
        [{ label: 'a', path: '/home/q/apps' }],
        'linux',
      ),
    ).toEqual([]);
    expect(
      explainApprovalRules(
        [posix],
        'run_command',
        AGENT,
        ENTITY,
        [{ label: 'a', path: '/home/q/Apps/' }],
        'linux',
      ).map((r) => r.id),
    ).toEqual(['posix']);
  });

  it('treats an empty condition object as no condition', () => {
    const empty = rule({ id: 'empty', toolName: 'run_command', conditionJson: {} });
    const chain = explainApprovalRules([empty], 'run_command', AGENT, ENTITY);
    expect(chain.map((r) => r.id)).toEqual(['empty']);
    expect(chain[0]?.tier).toBe('agent-tool');
    expect(chain[0]?.workspacePath).toBeNull();
  });
});

describe('normaliseWorkspacePath @cap:approuver-une-action/moteur', () => {
  it('unifies separators, drops trailing ones and collapses . and .. segments', () => {
    expect(normaliseWorkspacePath('D:\\APPS\\NodalAI\\', 'linux')).toBe('D:/APPS/NodalAI');
    expect(normaliseWorkspacePath('/a/b/../c/./d//', 'linux')).toBe('/a/c/d');
  });

  it('lowercases on win32 only', () => {
    expect(normaliseWorkspacePath('D:/Apps', 'win32')).toBe('d:/apps');
    expect(normaliseWorkspacePath('D:/Apps', 'linux')).toBe('D:/Apps');
  });

  it('keeps a bare drive prefix, so C: and D: stay different places', () => {
    // Les deux tombaient sur la chaine vide, donc etaient egaux (revue
    // Reviewer C, passe 1).
    expect(normaliseWorkspacePath('C:', 'win32')).not.toBe(normaliseWorkspacePath('D:', 'win32'));
    expect(normaliseWorkspacePath('C:', 'win32')).toBe('c:/');
    expect(normaliseWorkspacePath('D:\\', 'win32')).toBe('d:/');
  });

  it('workspaceMatches says no when the list is empty', () => {
    expect(workspaceMatches('/a', [], 'linux')).toBe(false);
    expect(workspaceMatches('/a', undefined, 'linux')).toBe(false);
  });
});

describe('une condition ne change pas de tier @cap:approuver-une-action/moteur', () => {
  it('un joker conditionne ne bat PAS un block pose sur l agent et l outil exact', () => {
    // Hisser toute regle conditionnee en tete de chaine etait une elevation de
    // privilege : `setAgentApprovalRuleAction` accepte un `toolName` libre, donc
    // un joker conditionne est ecrivable, et il annulait un `block` explicite
    // (revue Reviewer C, passe 1).
    const rules: ApprovalRule[] = [
      rule({
        id: 'joker-conditionne',
        toolName: '*',
        action: 'auto_approve',
        conditionJson: { workspacePath: '/w' },
      }),
      rule({ id: 'block-exact', action: 'block' }),
    ];
    const chain = explainApprovalRules(rules, TOOL, AGENT, ENTITY, [{ label: 'w', path: '/w' }]);
    expect(chain.map((r) => r.id)).toEqual(['block-exact', 'joker-conditionne']);
    expect(
      matchApprovalRule(rules, TOOL, AGENT, ENTITY, [{ label: 'w', path: '/w' }])?.action,
    ).toBe('block');
  });
});

describe('resolveToolDefaultApproval @cap:approuver-une-action/moteur', () => {
  it('asks first for every MCP tool, whatever the server', () => {
    expect(resolveToolDefaultApproval('mcp_anything__whatever')).toBe('require_approval');
  });

  it('asks first for the safe-by-default product tools', () => {
    expect(resolveToolDefaultApproval('run_command')).toBe('require_approval');
    expect(resolveToolDefaultApproval('code_task')).toBe('require_approval');
    expect(resolveToolDefaultApproval('create_agent')).toBe('require_approval');
  });

  it('runs without asking for an ordinary tool', () => {
    expect(resolveToolDefaultApproval('file_read')).toBe('auto_approve');
    expect(resolveToolDefaultApproval('query_memory')).toBe('auto_approve');
  });
});
