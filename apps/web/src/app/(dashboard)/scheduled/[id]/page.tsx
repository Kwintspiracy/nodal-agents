// /scheduled/[id] — LE RUN D'UNE AUTOMATISATION (P2-P4, déménagé ici par P8).
//
// Cette page était /spaces/[id] tant que Spaces listait des jobs. Spaces liste
// maintenant des PROJETS, et /spaces/[id] est la page d'un projet : le run d'un
// TRAVAIL n'a plus qu'un point d'entrée, celui d'une automatisation qui
// « ouvre son run » (garde de P9).
//
// 18/09 — la route ne dessine plus rien elle-même : elle charge et rend
// `RunPage`, la page partagée avec /jobs/[id]. Un run est un tableau de bord,
// pas un fil (décision Quentin) ; l'ordre des blocs vit dans `runs/RunPage.tsx`.

import { notFound } from 'next/navigation';
import { getSpaceConversationAction } from '@/lib/actions.ts';
import PageShell from '@/components/ui/PageShell';
import RunPage from '@/app/(dashboard)/runs/RunPage.tsx';

// Force dynamic — the feed is read per request, and re-read while the job runs.
export const dynamic = 'force-dynamic';

export default async function ScheduledRunPage({ params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  const result = await getSpaceConversationAction(id);
  if (!result.ok) {
    if (result.code === 'not_found') notFound();
    return (
      <PageShell title="Run">
        <p className="text-sm text-err">{result.message}</p>
      </PageShell>
    );
  }

  // Le retour ramène là d'où le run s'ouvre : SON automatisation pour un run
  // de cron (#202 — la page Scheduled où il ramenait n'existe plus), la
  // conversation pour son run, Activity pour le reste (Quentin, 17/09 : « ce
  // problème est à plusieurs endroits »).
  return <RunPage data={result.data} />;
}
