// /jobs/[id] — LA PAGE D'UN RUN DE SCHEDULED (#501).
//
// L'adresse d'un run se décide dans `lib/run-page.ts` : un run né d'une
// automatisation (cron, webhook) s'ouvre ici, sous Scheduled ; tout autre run
// sous `/chat/runs/[id]`, qui réexporte CETTE page pour que le rail reste sur
// Work. `/runs/[id]` et `/scheduled/[id]` ne rendent rien : ils redirigent.
//
// 18/09 — cette route dessinait son propre écran : une grille de métadonnées
// brutes (chain count, delegation depth, duration ms) et le transcript en
// `<pre>`. Deux pages pour la même chose, et celle-ci montrait le moins. Elle
// rend maintenant `RunPage`, depuis un chargeur qui accepte n'importe quel job
// (`getSpaceConversationAction` : sa seule garde est `not_found`). Ce qui
// n'existait qu'ici et qui compte — le bouton d'arrêt tant que le run court —
// est dessiné par `RunPage` elle-même (#252). Les
// délégations, elles, ne
// sont plus une liste de liens : elles se lisent DANS la chronologie du run,
// dépliables, là où elles ont eu lieu (décision Quentin, 18/09).

import { notFound } from 'next/navigation';
import { getSpaceConversationAction } from '@/lib/actions.ts';
import PageShell from '@/components/ui/PageShell';
import RunPage from '@/app/(dashboard)/runs/RunPage.tsx';

// Force dynamic — this page reads per-request DB state.
export const dynamic = 'force-dynamic';

export default async function JobDetailPage({ params }: { params: Promise<{ id: string }> }) {
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

  // Le bouton d'arrêt n'est plus passé d'ici (#252) : `RunPage` le dessine
  // elle-même, dans sa rangée d'actions, sous ses deux adresses (celle-ci et
  // `/chat/runs/[id]`).
  return <RunPage data={result.data} />;
}
