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

    // Wrapping the payload in a general-purpose interpreter's inline-eval
    // flag (`python -c`, `node -e`, `sh -c`, `powershell -Command`, …) hands
    // the classifier an opaque program that could do anything the payload
    // wants — including a plain `rm -rf /` that would otherwise be caught
    // below. Undecidable payload → always gate, never "safe" (checked on the
    // RAW tokens, before wrapper-unwrapping, so it also catches this nested
    // one level deep, e.g. `cmd /c python -c "…"`).
    if (hasInlineInterpreterEval(tokens)) return true;

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

// ── Destructive / heavy actions (for the `destructive_gate` autonomy level) ──────
// BROADER than the catastrophic floor: actions that mutate the machine in a heavy
// or hard-to-undo way — file deletions, software installs / large downloads, disk
// ops, process/service control, recursive permission changes, destructive VCS.
// Under `destructive_gate`, ordinary work auto-approves but THESE still require a
// human OK. We deliberately err toward asking: a false "ask" is cheap, a silent
// 13 GB install (`comfy install`) or an `rm` is not.
const DESTRUCTIVE_PATTERNS: RegExp[] = [
  /\b(rm|rmdir|unlink|shred)\b/i, // delete (unix)
  /\bdel\s|\bRemove-Item\b|\brd\s+\/s/i, // delete (windows/ps)
  /\bfind\b[^\n]*-delete\b/i, // find … -delete
  /\b(pip3?|npm|pnpm|yarn|apt|apt-get|yum|dnf|brew|pacman|choco|winget|uvx|pipx|cargo|gem|conda|comfy)\b[^\n]*\binstall\b/i, // pkg install
  /\bgo\s+install\b|\bcomfy\b[^\n]*\bmodel\s+download\b|\bpip3?\b[^\n]*\bdownload\b/i, // go install / model dl
  /\bwget\b|\bgit\s+clone\b|\bcurl\b[^\n]*\s-[oO]\b|\bInvoke-WebRequest\b|\biwr\b[^\n]*-OutFile/i, // large download / clone
  /\b(kill|pkill|killall|taskkill)\b|\bStop-Process\b|\bStop-Service\b/i, // process kill
  /\bsystemctl\b|\bsc\s+(stop|delete)\b|\bservice\b[^\n]*\b(stop|restart)\b/i, // service control
  /\bmkfs(\.\w+)?\b|\bdd\b[^\n]*\bof=|\b(format|fdisk|parted|diskpart)\b/i, // disk ops
  /\bchmod\s+-\S*R|\bchown\s+-\S*R|\bicacls\b/i, // recursive perms/ownership
  /\bgit\s+push\b[^\n]*(--force|-f\b)|\bgit\s+reset\s+--hard\b|\bgit\s+clean\s+-\S*f|\bgit\s+branch\s+-D\b/i, // destructive VCS
];

/**
 * True when `cmd` performs a destructive or heavy, hard-to-undo action. Used by
 * the `destructive_gate` autonomy level: such a command keeps its approval gate
 * while ordinary commands auto-run. Catastrophic commands are a subset (always
 * true here too).
 */
export function isDestructiveOrHeavyCommand(cmd: string): boolean {
  if (typeof cmd !== 'string' || cmd.trim() === '') return false;
  if (isCatastrophicCommand(cmd)) return true;
  const c = normalizeSlashes(cmd.trim());
  return DESTRUCTIVE_PATTERNS.some((re) => re.test(c));
}
