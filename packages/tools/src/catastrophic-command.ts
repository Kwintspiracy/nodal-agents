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
