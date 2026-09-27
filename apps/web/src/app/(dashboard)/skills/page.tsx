import { listSkillsAction, listAgentsAction } from '@/lib/actions.ts';
import PageShell from '@/components/ui/PageShell';
import SkillsClient from './SkillsClient.tsx';
import Banner from '@/components/ui/Banner';

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
      <PageShell title="Skills">
        <Banner variant="warn">{skillsResult.message}</Banner>
      </PageShell>
    );
  }

  return (
    <SkillsClient skills={skillsResult.data} agents={agentsResult.ok ? agentsResult.data : []} />
  );
}
