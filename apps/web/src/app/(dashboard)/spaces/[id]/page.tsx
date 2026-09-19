// /spaces/[id] — LA PAGE D'UN PROJET (#143, planche 444:347 v2).
//
// Ouvrir un projet, c'était atterrir dans le fil de SA conversation (P8,
// 07/09). Ce n'est plus le cas, et la planche v2 dit pourquoi : un projet a
// PLUSIEURS conversations, et des sessions qui n'en ont aucune — les runs
// lancés depuis le CLI, le serveur MCP ou un harnais dans son dossier, ce que
// l'onglet Code listait. Atterrir dans une seule de ces histoires cachait
// toutes les autres.
//
// L'écran vit dans `ProjectScreen` : `/spaces/[id]/files` le rend aussi, à un
// détail près — voir là-bas.

import ProjectScreen from '../ProjectScreen.tsx';

// Force dynamic — le projet et son activité sont relus à chaque requête.
export const dynamic = 'force-dynamic';

export default async function ProjectPage({ params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  return <ProjectScreen id={id} />;
}
