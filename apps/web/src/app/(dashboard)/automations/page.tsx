import { listAgentsAction, listSchedulesAction, listWebhookTriggersAction } from '@/lib/actions.ts';
import PageShell from '@/components/ui/PageShell';
import AutomationsClient from './AutomationsClient.tsx';

export const dynamic = 'force-dynamic';

type PageProps = {
  /**
   * `?new=schedule` ou `?new=webhook` ouvre le formulaire de création en
   * arrivant : c'est ce que le « + » d'une section de la barre latérale
   * demande (Quentin, 20/09 : cliquer « + » ne faisait rien, la page était
   * déjà là). Toute autre valeur n'ouvre rien.
   */
  searchParams?: Promise<{ new?: string }>;
};

export default async function AutomationsPage({ searchParams }: PageProps) {
  const sp = searchParams === undefined ? {} : await searchParams;
  const wanted: 'schedule' | 'webhook' | null =
    sp.new === 'schedule' || sp.new === 'webhook' ? sp.new : null;
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

  return (
    // `key` : un second « + » depuis la même page change le paramètre, et la
    // page cliente est REMONTÉE sur lui, donc le formulaire s'ouvre de nouveau.
    <AutomationsClient
      key={wanted ?? 'none'}
      agents={agents}
      schedules={schedulesResult.data}
      webhooks={webhooks}
      initialNew={wanted}
    />
  );
}
