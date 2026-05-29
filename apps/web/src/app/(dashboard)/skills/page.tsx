import { listSkillsAction, listAgentsAction } from '@/lib/actions.ts';
import SkillsClient from './SkillsClient.tsx';

export const dynamic = 'force-dynamic';

/**
 * Skills page — composes the design system's two-tab pattern (Assigned
 * table + Library card grid). All interactive state (tab, search, modal)
 * lives in the client shell; the server side just delivers the row list.
 * Agents are also fetched here so the Skills library modal can show the
 * agent picker without a second round-trip.
 */
export default async function SkillsPage() {
  const [skillsResult, agentsResult] = await Promise.all([listSkillsAction(), listAgentsAction()]);

  if (!skillsResult.ok) {
    return (
      <div className="py-7">
        <h1 className="text-[28px] font-semibold leading-[1.15] tracking-[-0.015em] text-ink">
          Skills
        </h1>
        <div className="mt-4 rounded-2xl border border-warn/40 bg-warn-bg p-5 text-sm text-warn">
          {skillsResult.message}
        </div>
      </div>
    );
  }

  return (
    <SkillsClient skills={skillsResult.data} agents={agentsResult.ok ? agentsResult.data : []} />
  );
}
