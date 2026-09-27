import StatusPill from '@/components/ui/StatusPill';
import type { SkillUpdateDetail } from '@/lib/actions.ts';
import { sourceProblemLabel, sourceProblemTitle } from '@/lib/skill-source-problem.ts';

/**
 * The warning shown in place of the update badge when the last check could
 * not read the skill's source as this skill. Renders nothing otherwise.
 */
export default function SkillSourceProblemPill({ detail }: { detail: SkillUpdateDetail | null }) {
  if (!detail?.sourceProblem) return null;
  return (
    <span title={sourceProblemTitle(detail)}>
      <StatusPill variant="warn" label={sourceProblemLabel(detail.sourceProblem)} />
    </span>
  );
}
