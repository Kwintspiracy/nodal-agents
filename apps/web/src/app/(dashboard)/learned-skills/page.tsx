import {
  listLearnedSkillsAction,
  getReflectionEnabledAction,
  getSkillAssignmentModeAction,
  listAssignableAgentsAction,
} from '@/lib/learned-skills-actions.ts';
import PageShell from '@/components/ui/PageShell';
import LearnedSkillsClient from './_components/LearnedSkillsClient.tsx';

export const dynamic = 'force-dynamic';

export default async function LearnedSkillsPage() {
  const [skillsResult, reflectionResult, modeResult, agentsResult] = await Promise.all([
    listLearnedSkillsAction(),
    getReflectionEnabledAction(),
    getSkillAssignmentModeAction(),
    listAssignableAgentsAction(),
  ]);

  if (!skillsResult.ok) {
    return (
      <PageShell title="Learned Skills">
        <div className="rounded-xl border border-err/25 bg-paper px-6 py-8 text-sm text-err">
          {skillsResult.message}
        </div>
      </PageShell>
    );
  }

  const reflectionEnabled = reflectionResult.ok ? reflectionResult.data : false;
  const assignmentMode = modeResult.ok ? modeResult.data : 'approval';
  const assignableAgents = agentsResult.ok ? agentsResult.data : [];

  return (
    <LearnedSkillsClient
      skills={skillsResult.data}
      reflectionEnabled={reflectionEnabled}
      assignmentMode={assignmentMode}
      assignableAgents={assignableAgents}
    />
  );
}
