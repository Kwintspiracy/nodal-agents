// code-task-shell-rule.test.ts — l'argv d'un code_task Claude lit la règle
// shell de la plateforme (`cliShellPosture`, @nodal-agents/shared), il ne la
// recopie pas (revue Nodal de #551).
//
// L'en-tête de packages/shared/src/cli-shell.ts nomme le code_task comme
// lecteur n°2 de la règle unique. L'argv portait pourtant `Bash,PowerShell` en
// dur : une règle qui changeait (un réglage shell pour les code_task, un
// troisième outil shell) laissait cette copie derrière elle. La règle est donc
// SIMULÉE ici, et l'argv doit la suivre, quelle qu'elle soit.

import { describe, it, expect, vi, beforeEach } from 'vitest';
import type * as SharedModule from '@nodal-agents/shared';

const rule = vi.hoisted(() => ({
  posture: null as null | ReturnType<typeof SharedModule.cliShellPosture>,
  asked: [] as unknown[][],
}));

vi.mock('@nodal-agents/shared', async (importOriginal) => {
  const actual = await importOriginal<typeof SharedModule>();
  return {
    ...actual,
    cliShellPosture: (...a: Parameters<typeof actual.cliShellPosture>) => {
      rule.asked.push(a);
      return rule.posture ?? actual.cliShellPosture(...a);
    },
  };
});

import { buildProviderArgs } from '../builtin/code-task/providers';

const valueOf = (args: string[], flag: string): string | null =>
  args.includes(flag) ? (args[args.indexOf(flag) + 1] ?? null) : null;

describe('code_task argv follows the platform shell rule @cap:executer-une-commande/moteur', () => {
  beforeEach(() => {
    rule.posture = null;
    rule.asked = [];
  });

  it('claude write: the rule, asked for Claude with no setting, decides the shell flags', () => {
    const args = buildProviderArgs('claude', 'write');
    // Un code_task n'a pas de réglage shell : la règle est interrogée pour
    // Claude, sans réglage.
    expect(rule.asked).toEqual([['claude', null, { autoRunPaused: false }]]);
    // Et sa réponse réelle : aucun shell, les deux outils hors palette.
    expect(valueOf(args, '--allowedTools')).toBeNull();
    expect(valueOf(args, '--disallowedTools')).toBe('Bash,PowerShell');
  });

  it('claude write: a rule that grants a shell tool reaches the argv', () => {
    rule.posture = { kind: 'shell', tools: ['Bash'] };
    const args = buildProviderArgs('claude', 'write');
    expect(valueOf(args, '--allowedTools')).toBe('Bash');
    expect(valueOf(args, '--disallowedTools')).toBe('PowerShell');
    expect(valueOf(args, '--permission-mode')).toBe('acceptEdits');
  });
});
