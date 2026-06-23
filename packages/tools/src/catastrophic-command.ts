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
const DD_TO_DEVICE = /\bdd\b[^\n]*\bof=\/dev\/[a-z]/i;
const POWER_STATE = /\b(shutdown|reboot|halt|poweroff)\b/i;
const INIT_RUNLEVEL = /\binit\s+[06]\b/;
const OVERWRITE_DEVICE = />\s*\/dev\/(sd[a-z]|nvme\d|disk\d|hd[a-z])/i;

/**
 * True when `cmd` contains a catastrophic, machine-wide-destructive operation
 * that must always require explicit human approval (never auto-run).
 */
export function isCatastrophicCommand(cmd: string): boolean {
  if (typeof cmd !== 'string' || cmd.trim() === '') return false;
  const c = cmd.trim();

  if (
    FORK_BOMB.test(c) ||
    MKFS.test(c) ||
    DD_TO_DEVICE.test(c) ||
    POWER_STATE.test(c) ||
    INIT_RUNLEVEL.test(c) ||
    OVERWRITE_DEVICE.test(c)
  ) {
    return true;
  }

  // `rm` recursive + force against a machine-wide target (/, /*, ~, $HOME, bare *).
  // Inspect each shell segment so `foo && rm -rf /` is still caught.
  for (const seg of c.split(/[;&|]+/)) {
    const s = seg.trim();
    if (!/^(sudo\s+)?rm\b/i.test(s)) continue;
    const recursive = /\s-\S*r/i.test(s) || /\s--recursive\b/i.test(s);
    const force = /\s-\S*f/i.test(s) || /\s--force\b/i.test(s);
    if (!recursive || !force) continue;
    if (/\s--no-preserve-root\b/i.test(s)) return true;
    // a root / home / wildcard target anywhere in the segment
    if (/(\s|=)(\/|\/\*|~|~\/\*?|\$HOME\/?\*?|\*)(\s|$|"|')/.test(s)) return true;
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
  const c = cmd.trim();
  return DESTRUCTIVE_PATTERNS.some((re) => re.test(c));
}
