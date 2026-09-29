// /scheduled/[id] — UNE PORTE QUI NE DÉCIDE RIEN (#501).
//
// Cette route rendait la page de n'importe quel run : un run d'automatisation
// (P8), mais aussi celui d'une conversation, puisque « Open run » d'un fil Work
// y menait. Le rail lit sa section de l'adresse seule : ouvrir un run par ici
// l'aurait allumé sur Scheduled, quel que soit le run (revue Nodal de #621).
//
// Aucun écran ne l'écrit plus : l'adresse d'un run vient de `lib/run-page.ts`.
// Elle reste pour les liens déjà envoyés et les favoris, et elle REDIRIGE vers
// `/runs/<id>`, qui range le run par la tête de sa chaîne. Elle ne dessine rien.

import { redirect } from 'next/navigation';
import { openRunHref } from '@/lib/run-page.ts';

export default async function ScheduledRunPage({
  params,
}: {
  params: Promise<{ id: string }>;
}): Promise<never> {
  const { id } = await params;
  redirect(openRunHref(id));
}
