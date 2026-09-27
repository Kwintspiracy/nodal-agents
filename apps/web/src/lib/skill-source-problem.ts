import type { SkillSourceProblem, SkillUpdateDetail } from '@/lib/actions.ts';

// The words for a source problem the runner recorded (update_detail.
// sourceProblem): the runner stores the code, the dashboard says it. Shared by
// the catalog card, the workspace table and the notifications bell.

export function sourceProblemLabel(problem: SkillSourceProblem): string {
  return problem === 'identity_changed' ? 'Source serves another skill' : 'Source not found';
}

export function sourceProblemTitle(
  detail: Extract<SkillUpdateDetail, { sourceProblem: string }>,
): string {
  return detail.sourceProblem === 'identity_changed'
    ? `Its source now serves the skill "${detail.upstreamSlug ?? 'unknown'}". Updates are paused.`
    : 'Nothing was found at its source on the last check. Updates are paused.';
}
