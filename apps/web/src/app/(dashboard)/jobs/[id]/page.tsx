// /jobs/[id] — LE RUN OUVERT DEPUIS ACTIVITY.
//
// 18/09 — cette route dessinait son propre écran : une grille de métadonnées
// brutes (chain count, delegation depth, duration ms) et le transcript en
// `<pre>`. Deux pages pour la même chose, et celle-ci montrait le moins. Elle
// rend maintenant `RunPage`, la MÊME page que /scheduled/[id], depuis le même
// chargeur (`getSpaceConversationAction` accepte n'importe quel job : sa seule
// garde est `not_found`). Ce qui n'existait qu'ici et qui compte — le bouton
// d'arrêt tant que le run court — est devenu celui des DEUX routes (#252). Les
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
  // elle-même, dans sa rangée d'actions, pour ses DEUX routes. Il n'existait
  // que sur celle-ci, et `/scheduled/[id]` montrait le même run sans lui.
  return <RunPage data={result.data} />;
}
