// shell-programs.ts — the programs a command allowlist must never contain.
//
// WHY. `agents.command_allowlist` names the programs `run_command` may start.
// An entry that IS a shell defeats the whole thing: `cmd` on the list reads as
// "this agent may run cmd" and means "this agent may run anything", because
// `cmd /c <x>` starts x, and the allowlist check has already passed by then.
// The same holds for `powershell -c`, `sh -c`, `bash -lc`, `wsl <x>`.
//
// Refused at the WRITE path (the settings action), not at execution time. An
// owner typing `cmd` is expressing an intention the product cannot honour, and
// the honest moment to say so is when they save it — not silently, three weeks
// later, when an agent uses it. It also keeps the runtime check on what it is
// good at: comparing a program name.
//
// Lives in `shared` because both sides need the same list: the web action that
// validates what an owner writes, and `command-allowlist.ts`, which documents
// the limit in its own header.

/**
 * Programs whose PURPOSE is to start another program of the caller's choosing.
 * Lower-case, without an executable suffix — `isShellProgram` normalises before
 * comparing.
 *
 * Two families, and the second is the one that gets forgotten:
 *
 *  - SHELLS, which read a command line: cmd, powershell, sh, bash, wsl…
 *  - LAUNCHERS, which are not shells and start anything all the same:
 *    `env FOO=1 curl x`, `xargs curl`, `sudo anything`, `start calc`,
 *    `timeout 5 curl x`. Each reads as one listed word on an allowlist and
 *    hands over the rest of the line.
 *
 * `node` is deliberately NOT here. It can spawn too, but running a snippet is
 * the intended use and the entry a reviewer actually needs; that limit is
 * stated in `run-command.ts`'s security model rather than pretended away by a
 * list that refuses the only useful entry.
 */
export const SHELL_PROGRAMS: readonly string[] = [
  'cmd',
  'command',
  'powershell',
  'pwsh',
  'sh',
  'bash',
  'zsh',
  'ksh',
  'csh',
  'tcsh',
  'dash',
  'fish',
  'wsl',
  'busybox',
  // Launchers: not shells, same effect.
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
];

/**
 * Is the PROGRAM of `entry` one of those shells?
 *
 * Reads the first word, because an entry may be several (`bash -lc` is just as
 * open as `bash`). Compares case-insensitively and without an executable
 * suffix, and looks past a directory so `/bin/bash` and
 * `C:\Windows\System32\cmd.exe` are not mistaken for something harmless — even
 * though the allowlist matcher refuses a path against a bare entry anyway.
 */
export function isShellProgram(entry: string): boolean {
  const program = entry.trim().split(/\s+/)[0];
  if (program === undefined || program === '') return false;
  const base = program.toLowerCase().split(/[/\\]/).pop();
  if (base === undefined || base === '') return false;
  const withoutSuffix = base.replace(/\.(exe|cmd|bat|com|ps1)$/, '');
  return SHELL_PROGRAMS.includes(withoutSuffix);
}
