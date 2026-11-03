// La chaîne de règles d'approbation — l'ORDRE que la porte suit, et que la
// carte montre. Issue #346 : la carte promettait « ça tournera sans demander »
// pendant qu'une règle plus précise continuait de demander, parce que l'ordre
// n'était lisible nulle part.
//
// Depuis #917 la chaîne d'EXÉCUTION n'a plus que deux crans : la ligne de
// l'agent confinée au dossier où le job travaille, puis la ligne de l'agent
// pour l'outil. Les règles qui nomment un serveur, tous les outils ou tous les
// agents sont des MODÈLES : elles donnent la valeur d'une ligne quand elle est
// écrite (`explainTemplateRules`), jamais une décision pour un appel.
//
// Ces tests portent sur les fonctions PURES ET sur `matchApprovalRule`, qui en
// dérive : si les deux divergeaient, la carte mentirait de nouveau.

import { describe, it, expect } from 'vitest';
import {
  explainApprovalRules,
  explainTemplateRules,
  matchApprovalRule,
  normaliseWorkspacePath,
  workspaceMatches,
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

const EVERY_TIER: ApprovalRule[] = [
  rule({ id: 'entity-wildcard', toolName: '*', agentId: null, action: 'require_approval' }),
  rule({ id: 'agent-server', toolName: 'mcp_playwright__*', action: 'auto_approve' }),
  rule({ id: 'entity-tool', agentId: null, action: 'require_approval' }),
  rule({ id: 'agent-wildcard', toolName: '*', action: 'auto_approve' }),
  rule({ id: 'entity-server', toolName: 'mcp_playwright__*', agentId: null, action: 'block' }),
  rule({ id: 'agent-tool', action: 'block' }),
];

describe('explainApprovalRules: the agent row decides @cap:approuver-une-action/moteur', () => {
  it('at run time only the agent row for the exact tool applies, whatever else exists', () => {
    const chain = explainApprovalRules(EVERY_TIER, TOOL, AGENT, ENTITY);
    expect(chain.map((r) => r.id)).toEqual(['agent-tool']);
    expect(chain[0]).toMatchObject({ tier: 'agent-tool', scope: 'agent', wins: true });
    expect(matchApprovalRule(EVERY_TIER, TOOL, AGENT, ENTITY)?.action).toBe('block');
  });

  it('a server, a `*` or an Everyone rule decides NOTHING for a tool without a row', () => {
    const templatesOnly = EVERY_TIER.filter((r) => r.id !== 'agent-tool');
    expect(explainApprovalRules(templatesOnly, TOOL, AGENT, ENTITY)).toEqual([]);
    // No row: the gate refuses the call, it never borrows a template's value.
    expect(matchApprovalRule(templatesOnly, TOOL, AGENT, ENTITY)).toBeUndefined();
  });

  it('ignores rows belonging to another agent', () => {
    const rules: ApprovalRule[] = [
      rule({ id: 'other-agent', agentId: OTHER_AGENT, action: 'block' }),
      rule({ id: 'mine', action: 'require_approval' }),
    ];
    expect(explainApprovalRules(rules, TOOL, AGENT, ENTITY).map((r) => r.id)).toEqual(['mine']);
  });

  it('hands back the WINNING row even when two rules share an id', () => {
    // Nothing in the type says ids are distinct, and the test-kit builders hand
    // out the same one.
    const rules: ApprovalRule[] = [
      rule({ id: 'same', toolName: '*', action: 'auto_approve' }),
      rule({ id: 'same', action: 'require_approval' }),
    ];
    expect(matchApprovalRule(rules, TOOL, AGENT, ENTITY)?.action).toBe('require_approval');
    expect(explainApprovalRules(rules, TOOL, AGENT, ENTITY)[0]?.sourceIndex).toBe(1);
  });
});

describe('explainTemplateRules: what a NEW row inherits @cap:regler-autonomie/moteur', () => {
  it('orders the template rules most specific first, the agent row left out', () => {
    const chain = explainTemplateRules(EVERY_TIER, TOOL, AGENT, ENTITY);
    expect(chain.map((r) => r.id)).toEqual([
      'entity-tool',
      'agent-server',
      'entity-server',
      'agent-wildcard',
      'entity-wildcard',
    ]);
    expect(chain.map((r) => r.wins)).toEqual([true, false, false, false, false]);
    expect(chain.map((r) => r.tier)).toEqual([
      'entity-tool',
      'agent-server',
      'entity-server',
      'agent-all',
      'entity-all',
    ]);
  });

  it('issue #357: a server trusted, one of its NEW tools inherits that trust', () => {
    const rules: ApprovalRule[] = [
      rule({ id: 'serveur', toolName: 'mcp_playwright__*', action: 'auto_approve' }),
    ];
    expect(
      explainTemplateRules(rules, 'mcp_playwright__browser_snapshot', AGENT, ENTITY)[0],
    ).toMatchObject({ id: 'serveur', action: 'auto_approve' });
    // A built-in never matches a server pattern.
    expect(explainTemplateRules(rules, 'file_read', AGENT, ENTITY)).toEqual([]);
  });

  it('a rule confined to a folder is never a template: a new row is valid everywhere', () => {
    const rules: ApprovalRule[] = [
      rule({
        id: 'joker-dossier',
        toolName: '*',
        action: 'auto_approve',
        conditionJson: { workspacePath: '/w' },
      }),
    ];
    expect(explainTemplateRules(rules, TOOL, AGENT, ENTITY)).toEqual([]);
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
  const everywhere = rule({ id: 'tool-row', toolName: 'run_command', action: 'block' });

  it('applies, and comes before the tool row, when the job works in that folder', () => {
    const rules: ApprovalRule[] = [everywhere, conditioned];
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
    expect(chain[1]).toMatchObject({ id: 'tool-row', wins: false });
    expect(
      matchApprovalRule(rules, 'run_command', AGENT, ENTITY, [{ label: 'nodal', path: FOLDER }])
        ?.action,
    ).toBe('auto_approve');
  });

  it('is left out entirely when the job works somewhere else, and the tool row decides', () => {
    const rules: ApprovalRule[] = [everywhere, conditioned];
    const chain = explainApprovalRules(rules, 'run_command', AGENT, ENTITY, [
      { label: 'elsewhere', path: 'D:/APPS/Other' },
    ]);

    expect(chain.map((r) => r.id)).toEqual(['tool-row']);
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
    expect(normaliseWorkspacePath('C:', 'win32')).not.toBe(normaliseWorkspacePath('D:', 'win32'));
    expect(normaliseWorkspacePath('C:', 'win32')).toBe('c:/');
    expect(normaliseWorkspacePath('D:\\', 'win32')).toBe('d:/');
  });

  it('keeps a UNC path distinct from a POSIX one', () => {
    expect(normaliseWorkspacePath('\\\\serveur\\part', 'linux')).toBe('//serveur/part');
    expect(normaliseWorkspacePath('/serveur/part', 'linux')).toBe('/serveur/part');
    expect(normaliseWorkspacePath('\\\\serveur\\part', 'linux')).not.toBe(
      normaliseWorkspacePath('/serveur/part', 'linux'),
    );
  });

  it('workspaceMatches says no when the list is empty', () => {
    expect(workspaceMatches('/a', [], 'linux')).toBe(false);
    expect(workspaceMatches('/a', undefined, 'linux')).toBe(false);
  });
});

describe('une condition ne change pas de tier @cap:approuver-une-action/moteur', () => {
  it('un joker conditionne ne decide RIEN : la ligne de l outil gagne', () => {
    // Un joker n'est plus une décision à l'exécution (#917) : même confiné au
    // dossier où le job travaille, il n'annule pas un `block` explicite.
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
    expect(chain.map((r) => r.id)).toEqual(['block-exact']);
    expect(
      matchApprovalRule(rules, TOOL, AGENT, ENTITY, [{ label: 'w', path: '/w' }])?.action,
    ).toBe('block');
  });
});
