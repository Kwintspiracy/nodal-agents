// /jobs/[id] — LE RUN OUVERT DEPUIS ACTIVITY.
//
// 18/09 — cette route dessinait son propre écran : une grille de métadonnées
// brutes (chain count, delegation depth, duration ms) et le transcript en
// `<pre>`. Deux pages pour la même chose, et celle-ci montrait le moins. Elle
// rend maintenant `RunPage`, la MÊME page que /scheduled/[id], depuis le même
// chargeur (`getSpaceConversationAction` accepte n'importe quel job : sa seule
// garde est `not_found`). Ce qui n'existait qu'ici et qui compte — le bouton
// d'annulation tant que le run court — est gardé. Les délégations, elles, ne
// sont plus une liste de liens : elles se lisent DANS la chronologie du run,
// dépliables, là où elles ont eu lieu (décision Quentin, 18/09).

import { notFound } from 'next/navigation';
import BackButton from '@/components/ui/BackButton';
import { getSpaceConversationAction } from '@/lib/actions.ts';
import PageShell from '@/components/ui/PageShell';
import RunPage from '@/app/(dashboard)/runs/RunPage.tsx';
import { runIsLive } from '@/app/(dashboard)/runs/run-view.ts';
import { runBackLink } from '@/lib/back-links.ts';
import CancelJobButton from '../CancelJobButton.tsx';

// Force dynamic — this page reads per-request DB state.
export const dynamic = 'force-dynamic';

export default async function JobDetailPage({ params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  const result = await getSpaceConversationAction(id);
  if (!result.ok) {
    if (result.code === 'not_found') notFound();
    return (
      <PageShell title="Run">
        {/* #232 — même sur un échec de lecture, le retour ramène d'où l'on vient. */}
        <BackButton parent="/logs" label="Activity" className="text-xs hover:text-ink-2" />
        <p className="mt-4 text-sm text-err">{result.message}</p>
      </PageShell>
    );
  }

  const { job } = result.data;
  return (
    <RunPage
      data={result.data}
      back={runBackLink(job)}
      actions={runIsLive(job.status) ? <CancelJobButton jobId={job.id} /> : null}
    />
  );
}
