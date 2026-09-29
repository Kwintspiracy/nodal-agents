// /runs/[id] — OUVRIR UN RUN SANS SAVOIR D'OÙ IL VIENT (#501).
//
// La cloche, une approbation, la liste des runs et la table Runs ouvrent un run
// sans connaître sa section. Ils pointaient `/jobs/<id>`, et le rail, qui lit
// sa section de l'adresse seule, basculait sur Scheduled pour n'importe quel
// run. Ils pointent maintenant ici, et cette route ne dessine RIEN : elle lit
// la tête de la chaîne du run et redirige vers l'adresse de sa section
// (`lib/run-page.ts`). La redirection REMPLACE l'entrée d'historique : le
// retour du navigateur ne repasse pas par cette étape.
//
// Quand la chaîne ne se lit pas (`lineage_broken`), la section est inconnue.
// La page le DIT, et garde un accès au run : la page de run sous Work, la
// section que le rail montre déjà ici, puisque `/runs` n'est dans aucune
// (revue Nodal de #621, passe 2). Sans ce lien, un run que `/jobs/<id>` ouvrait
// encore devenait inaccessible par cette porte et par `/scheduled/<id>`.

import { notFound, redirect } from 'next/navigation';
import { resolveRunPageHrefAction } from '@/lib/conversation-actions.ts';
import PageShell from '@/components/ui/PageShell';
import PrimaryButton from '@/components/ui/PrimaryButton';
import { runPageHref } from '@/lib/run-page.ts';

// L'adresse dépend de la base, lue à chaque ouverture.
export const dynamic = 'force-dynamic';

export default async function OpenRunPage({ params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  const result = await resolveRunPageHrefAction(id);
  if (!result.ok) {
    if (result.code === 'not_found') notFound();
    return (
      <PageShell title="Run">
        <p className="text-body-13 text-err">{result.message}</p>
        {result.code === 'lineage_broken' && (
          <div className="mt-3">
            <PrimaryButton variant="neutral" size="sm" href={runPageHref(id)}>
              Open the run
            </PrimaryButton>
          </div>
        )}
      </PageShell>
    );
  }
  redirect(result.data);
}
