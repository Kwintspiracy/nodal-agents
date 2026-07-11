import { listAgentsAction, listSchedulesAction, listWebhookTriggersAction } from '@/lib/actions.ts';
import PageShell from '@/components/ui/PageShell';
import AutomationsClient from './AutomationsClient.tsx';

export const dynamic = 'force-dynamic';

export default async function AutomationsPage() {
  const [agentsResult, schedulesResult, webhooksResult] = await Promise.all([
    listAgentsAction(),
    listSchedulesAction(),
    listWebhookTriggersAction(),
  ]);

  if (!schedulesResult.ok) {
    return (
      <PageShell title="Automations">
        <div className="rounded-xl border border-err/25 bg-paper px-6 py-8 text-sm text-err">
          {schedulesResult.message}
        </div>
      </PageShell>
    );
  }

  const agents = agentsResult.ok ? agentsResult.data : [];
  const webhooks = webhooksResult.ok ? webhooksResult.data : [];

  return <AutomationsClient agents={agents} schedules={schedulesResult.data} webhooks={webhooks} />;
}
