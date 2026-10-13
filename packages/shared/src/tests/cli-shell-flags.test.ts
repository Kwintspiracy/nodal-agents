// cli-shell-flags.test.ts — la posture shell devient les drapeaux de Claude en
// un seul endroit (#494, revue Nodal de #551) : le tour d'agent et le
// code_task les lisent tous les deux.

import { describe, it, expect } from 'vitest';
import { claudeShellFlags, claudeShellTools, cliShellPosture } from '../cli-shell';

describe('claudeShellFlags @cap:executer-une-commande/moteur', () => {
  it('each shell tool is either granted up front or removed from the palette, never left pending', () => {
    const cases: [Parameters<typeof cliShellPosture>[1], boolean, string[]][] = [
      [null, false, ['--disallowedTools', 'Bash,PowerShell']],
      [{ mode: 'write', shell: 'auto' }, false, ['--allowedTools', 'Bash,PowerShell']],
      // Le frein retire le shell de Claude sans refuser le tour.
      [{ mode: 'write', shell: 'auto' }, true, ['--disallowedTools', 'Bash,PowerShell']],
      [
        { mode: 'write', shell: 'auto', extraDisallowed: ['Bash'] },
        false,
        ['--allowedTools', 'PowerShell', '--disallowedTools', 'Bash'],
      ],
    ];
    for (const [perms, autoRunPaused, expected] of cases) {
      const posture = cliShellPosture('claude', perms, { autoRunPaused });
      expect(claudeShellFlags(claudeShellTools(posture)), JSON.stringify(perms)).toEqual(expected);
    }
  });

  it('extra disallowed tools join the removed ones', () => {
    expect(claudeShellFlags(['Bash'], ['WebSearch'])).toEqual([
      '--allowedTools',
      'Bash',
      '--disallowedTools',
      'PowerShell,WebSearch',
    ]);
  });

  it('Codex has no Claude shell tools: its sandbox decides', () => {
    expect(claudeShellTools(cliShellPosture('codex', null, { autoRunPaused: false }))).toEqual([]);
  });
});
