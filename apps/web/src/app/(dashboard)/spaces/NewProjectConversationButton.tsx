// NewProjectConversationButton — ouvrir une conversation neuve SUR ce projet
// (P8). Elle naît ancrée : l'agent sait de quel dossier on parle dès le premier
// message, sans qu'on ait à le lui dire.
//
// #248 — le bouton créait la ligne, puis menait au fil. Il MÈNE maintenant à
// l'écran de conversation neuve, qui PORTE le projet (`/?project=<id>`), et
// c'est le premier envoi qui crée la conversation ancrée. Un dossier ouvert et
// refermé sans un mot ne laisse plus de fil vide derrière lui.
//
// Plus de `'use client'`, plus de transition, plus d'état : un lien n'a besoin
// de rien. L'échec que le clic attrapait (pas de ROOT) est dit par l'écran
// d'arrivée, là où la saisie serait.

import PrimaryButton from '@/components/ui/PrimaryButton';

export default function NewProjectConversationButton({ projectId }: { projectId: string }) {
  return (
    <PrimaryButton variant="neutral" size="sm" href={`/?project=${encodeURIComponent(projectId)}`}>
      New conversation
    </PrimaryButton>
  );
}
