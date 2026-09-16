// shell-programs.test.ts — what a command allowlist must never contain.
//
// @cap:assigner-outils/moteur

import { describe, it, expect } from 'vitest';
import { SHELL_PROGRAMS, isShellProgram } from '../shell-programs';

describe('isShellProgram @cap:assigner-outils/moteur', () => {
  it('names a shell as a shell, whatever the spelling of the entry', () => {
    // An entry `cmd` on an allowlist reads as "this agent may run cmd" and
    // MEANS "this agent may run anything", because `cmd /c <x>` starts x.
    for (const program of ['cmd', 'cmd.exe', 'CMD', 'powershell', 'pwsh', 'sh', 'bash', 'zsh']) {
      expect(isShellProgram(program), `${program} should be a shell`).toBe(true);
    }
  });

  it('reads the PROGRAM of a multi-word entry, not the whole string', () => {
    expect(isShellProgram('bash -lc')).toBe(true);
    expect(isShellProgram('wsl npm test')).toBe(true);
  });

  it('names the LAUNCHERS too, which are not shells but start anything', () => {
    // A shell is not the only program whose job is to run another one.
    // `env FOO=1 curl x`, `xargs curl`, `sudo anything`, `start calc`,
    // `timeout 5 curl x` — each reads as one listed word and grants the rest.
    for (const program of [
      'env',
      'start',
      'nohup',
      'xargs',
      'timeout',
      'sudo',
      'runas',
      'call',
      'for',
      'doskey',
      'exec',
      'eval',
      'script',
    ]) {
      expect(isShellProgram(program), `${program} should be refused`).toBe(true);
    }
  });

  it('leaves node alone — running a snippet IS the intended use', () => {
    // node can spawn too. It is the entry a reviewer actually needs, and the
    // limit is stated in run-command.ts's security model rather than pretended
    // away here.
    expect(isShellProgram('node')).toBe(false);
    expect(isShellProgram('node -e')).toBe(false);
  });

  it('leaves ordinary programs alone', () => {
    for (const program of ['node', 'npx vitest', 'git', 'python', 'shellcheck', 'bashful']) {
      expect(isShellProgram(program), `${program} should not be a shell`).toBe(false);
    }
  });

  it('is not fooled by a path, which the allowlist refuses anyway', () => {
    // The allowlist matcher refuses a path against a bare entry, so this only
    // has to avoid claiming such an entry is harmless.
    expect(isShellProgram('C:\\Windows\\System32\\cmd.exe')).toBe(true);
    expect(isShellProgram('/bin/bash')).toBe(true);
  });

  it('ignores an empty entry rather than calling it a shell', () => {
    expect(isShellProgram('')).toBe(false);
    expect(isShellProgram('   ')).toBe(false);
  });

  it('exposes the list so a message can name what was refused', () => {
    expect(SHELL_PROGRAMS).toContain('cmd');
    expect(SHELL_PROGRAMS).toContain('powershell');
    expect(SHELL_PROGRAMS).toContain('bash');
  });
});
