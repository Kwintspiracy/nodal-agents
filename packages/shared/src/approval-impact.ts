// approval-impact.ts — deterministic, code-generated IMPACT line for a gated
// tool call.
//
// WHY this exists: an approval card used to lean entirely on the AGENT's own
// optional `purpose`/`impact` free-text fields — short on explanation when
// the agent forgot to fill them, and inconsistent across tools. This is the
// opposite of that: a fixed, per-tool sentence computed HERE, in code, never
// by the LLM. Invariant #2 ("no hardcoded user-facing text in runner — LLM
// speaks or runner stays silent") does not apply to this line: it is
// platform UI describing what the ACTION does, not the agent's voice. It
// complements (never replaces) the agent's own `purpose` line, which still
// carries the "why".
//
// Used identically by the Telegram approval card (apps/runner) and the
// dashboard approvals page (apps/web) so a reviewer sees the same
// plain-language "what actually happens" regardless of channel.

import {
  isCatastrophicCommand,
  isDestructiveOrHeavyCommand,
  isInlineInterpreterEvalCommand,
} from './catastrophic-command';

/**
 * Extract the executable names a shell command actually runs — the basename of
 * the first token of each pipeline/sequence segment (split on |, &&, ||, ;),
 * skipping env-var prefixes (FOO=bar cmd) and sudo. Capped at 3 names so the
 * line stays a line. Purely descriptive — the security verdict comes from the
 * classifiers below, never from this list.
 */
function commandBinaries(cmd: string): string[] {
  const names: string[] = [];
  for (const segment of cmd.split(/\||&&|\|\||;/)) {
    // Tokenize keeping quoted strings whole — a Windows path with spaces
    // ("C:\Program Files\...\node.exe") is ONE token, not two.
    const tokens = segment.trim().match(/"[^"]*"|'[^']*'|\S+/g) ?? [];
    let head = '';
    for (const t of tokens) {
      if (t === '' || t === 'sudo' || /^[A-Za-z_][A-Za-z0-9_]*=/.test(t)) continue;
      head = t;
      break;
    }
    if (!head) continue;
    // basename, strip quotes/extension noise: "C:\bin\python.exe" → python
    const base = head
      .replace(/^["']|["']$/g, '')
      .split(/[\\/]/)
      .pop();
    if (base) names.push(base.replace(/\.(exe|cmd|bat)$/i, ''));
    if (names.length >= 3) break;
  }
  return names;
}

/**
 * Descriptive risk verdict for a shell command, derived from the SAME
 * classifiers the approval gate uses (single source of truth — the card can
 * never say "read-only" about a command the gate flagged destructive).
 */
function describeCommandImpact(cmd: string): string {
  const bins = commandBinaries(cmd);
  const ran = bins.length > 0 ? `Runs \`${bins.join('` → `')}\`` : 'Runs a shell command';
  if (isCatastrophicCommand(cmd)) {
    return `${ran} — MACHINE-WIDE DESTRUCTIVE: refused even if approved (hardline floor).`;
  }
  if (isInlineInterpreterEvalCommand(cmd)) {
    return `${ran} — executes arbitrary inline code through an interpreter.`;
  }
  if (isDestructiveOrHeavyCommand(cmd)) {
    return `${ran} — destructive or heavy: deletes/moves files, installs software, or changes system state.`;
  }
  return `${ran} — no destructive pattern detected (likely read/inspect).`;
}

/**
 * Deterministic one-line impact summary for a gated tool call. Only called
 * for calls that ARE gated (an approval_requests row exists) — every branch
 * below assumes the call already crossed some destructive/require-approval
 * threshold, so the wording doesn't hedge on "if" it matters.
 */
export function computeApprovalImpactLine(toolName: string, toolInput: unknown): string {
  const input = (toolInput ?? {}) as Record<string, unknown>;
  const str = (v: unknown): string => (typeof v === 'string' && v.length > 0 ? v : '?');
  switch (toolName) {
    case 'file_write':
    case 'file_edit':
      return `Overwrites the existing file "${str(input['path'])}" in the shared workspace.`;
    case 'run_command': {
      const cmd = input['command'];
      return typeof cmd === 'string' && cmd.trim().length > 0
        ? describeCommandImpact(cmd)
        : 'Runs a shell command on the host.';
    }
    case 'run_skill_script':
      return `Runs script "${str(input['script'])}" from skill "${str(input['skill'])}".`;
    case 'skill_file_write':
      return `Writes a file into skill "${str(input['skill'])}"'s bundle.`;
    default:
      return `${toolName}: irreversible or destructive action.`;
  }
}
