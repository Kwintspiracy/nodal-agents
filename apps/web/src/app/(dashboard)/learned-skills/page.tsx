import { listLearnedSkillsAction, getReflectionEnabledAction } from '@/lib/learned-skills-actions.ts';
import LearnedSkillsClient from './_components/LearnedSkillsClient.tsx';

export const dynamic = 'force-dynamic';

export default async function LearnedSkillsPage() {
  const [skillsResult, reflectionResult] = await Promise.all([
    listLearnedSkillsAction(),
    getReflectionEnabledAction(),
  ]);

  if (!skillsResult.ok) {
    return (
      <div className="py-7">
        <h1 className="text-[28px] font-semibold leading-[1.15] tracking-[-0.015em] text-ink">
          Learned Skills
        </h1>
        <div className="mt-4 rounded-2xl border border-warn/40 bg-warn-bg p-5 text-sm text-warn">
          {skillsResult.message}
        </div>
      </div>
    );
  }

  const reflectionEnabled = reflectionResult.ok ? reflectionResult.data : false;

  return (
    <LearnedSkillsClient
      skills={skillsResult.data}
      reflectionEnabled={reflectionEnabled}
    />
  );
}
