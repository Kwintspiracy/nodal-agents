'use client';

// NewConversationBody — le milieu de l'écran de conversation neuve (#248) :
// l'accueil et la saisie, posés au TIERS de la hauteur (`pt-[30vh]`, 20/09 :
// environ 350 px sur un écran de bureau, et la même proportion sur un écran
// plus petit, plutôt qu'un pixel figé), pas au centre du vide.
//
// Pourquoi un composant client pour si peu : parce que l'accueil doit CÉDER LA
// PLACE dès qu'un message part. Le premier envoi crée la conversation, la
// réponse met le temps qu'elle met, et l'écran ne s'en va sur `/chat/<id>`
// qu'une fois le tour joué. Sans ça, on cliquait « Send », la zone se vidait,
// et il ne se passait plus rien à l'écran pendant plusieurs secondes — le même
// reproche que Quentin a fait au fil le 18/09 (« ça ne fonctionne comme ça dans
// aucun LLM existant »). Le message envoyé paraît donc ICI, avec l'agent qui
// réfléchit, exactement là où l'accueil était.
//
// Et l'accueil ne reste pas au-dessus : une question posée ne se lit pas sous
// « what are we building today? ».

import type { ReactNode } from 'react';
import PendingTurn, { usePendingTurn } from './PendingTurn.tsx';

export default function NewConversationBody({
  greeting,
  composer,
  agentName,
  agentAvatarUrl = null,
}: {
  /** La ligne d'accueil, déjà composée (`welcome-line.ts`). */
  greeting: string;
  /** La saisie, ou le mot qui la remplace quand il n'y a pas de ROOT. */
  composer: ReactNode;
  /** Qui réfléchit, le temps que la réponse vienne. */
  agentName: string;
  agentAvatarUrl?: string | null;
}) {
  const { pending, inFlight } = usePendingTurn();
  const parti = pending.length > 0 || inFlight;

  return (
    // `overflow-y-auto` : un premier message long ne doit pas pousser la saisie
    // hors de l'écran — la colonne défile, la saisie reste.
    <div className="flex min-h-0 flex-1 flex-col items-center justify-start gap-8 overflow-y-auto px-5 pt-[30vh] sm:px-8 lg:px-9">
      {parti ? (
        <div className="w-full">
          <PendingTurn agentName={agentName} agentAvatarUrl={agentAvatarUrl} />
        </div>
      ) : (
        // Display/28 de la planche, avec l'interlettrage du titre de page — la
        // même paire que `PageHeader`, pas une valeur inventée ici.
        <p className="text-center text-display-28 tracking-[-0.015em] text-ink">{greeting}</p>
      )}
      <div className="w-full">{composer}</div>
    </div>
  );
}
