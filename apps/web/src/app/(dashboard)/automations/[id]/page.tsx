// /automations/[id] — LA page d'une automatisation (#202).
//
// Une seule route pour les deux genres : un schedule et un webhook sont « une
// automatisation » pour qui la regarde, et la liste ne dit pas lequel est
// lequel dans son lien. C'est le chargeur qui tranche, en base.
//
// La route ne dessine rien elle-même : elle charge et rend `AutomationScreen`.

import { notFound } from 'next/navigation';
import { getAutomationAction, listAgentsAction } from '@/lib/actions.ts';
import PageShell from '@/components/ui/PageShell';
import AutomationScreen from './AutomationScreen.tsx';

// Force dynamic — les réglages et les runs se lisent à chaque requête.
export const dynamic = 'force-dynamic';

export default async function AutomationPage({ params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  const [result, agentsResult] = await Promise.all([getAutomationAction(id), listAgentsAction()]);

  if (!result.ok) {
    if (result.code === 'not_found') notFound();
    return (
      <PageShell title="Automation">
        <div className="rounded-xl border border-err/25 bg-paper px-6 py-8 text-sm text-err">
          {result.message}
        </div>
      </PageShell>
    );
  }

  return <AutomationScreen view={result.data} agents={agentsResult.ok ? agentsResult.data : []} />;
}
