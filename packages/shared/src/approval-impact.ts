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
    case 'run_command':
      return 'Runs a shell command on the host.';
    case 'run_skill_script':
      return `Runs script "${str(input['script'])}" from skill "${str(input['skill'])}".`;
    case 'skill_file_write':
      return `Writes a file into skill "${str(input['skill'])}"'s bundle.`;
    default:
      return `${toolName}: irreversible or destructive action.`;
  }
}
