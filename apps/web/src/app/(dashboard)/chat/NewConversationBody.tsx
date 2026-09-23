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
import ThreadScroller from './[id]/ThreadScroller.tsx';

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
    // Deux dispositions, UN seul arbre. Au repos, l'accueil et la saisie sont
    // posés au tiers de la hauteur. Dès qu'un message part, c'est un fil : la
    // réponse défile dans SA zone et la saisie reste ANCRÉE en bas, comme sur
    // `/chat/<id>`. Avant (Quentin, 23/09), la saisie vivait dans la colonne
    // qui défile, sous la réponse : une réponse longue la poussait hors de
    // l'écran au fil de l'écriture, et le bouton Stop avec elle.
    //
    // La saisie garde la MÊME place dans l'arbre dans les deux cas : la
    // déplacer la remonterait, et le compositeur perdrait la conversation dont
    // la réponse s'écrit — Stop ne saurait plus quoi arrêter.
    <div
      className={`flex min-h-0 flex-1 flex-col items-center justify-start px-5 sm:px-8 lg:px-9 ${
        parti ? '' : 'gap-8 pt-[30vh]'
      }`}
    >
      {parti ? (
        // La MÊME zone que le fil (`ThreadScroller`) : elle suit le bas pendant
        // que la réponse s'écrit, comme dans tout chat — le dernier mot reste
        // visible au-dessus de la saisie, le texte monte (Quentin, 23/09 : avant,
        // il continuait sous la saisie). Remonter pour relire coupe le suivi.
        <ThreadScroller className="min-h-0 w-full flex-1 overflow-y-auto pt-6 pb-4 [scrollbar-gutter:stable]">
          {/* Un seul enfant : c'est LUI dont la hauteur est observée. */}
          <div>
            <PendingTurn agentName={agentName} agentAvatarUrl={agentAvatarUrl} />
          </div>
        </ThreadScroller>
      ) : (
        <div className="w-full">
          {/* Display/28 de la planche, avec l'interlettrage du titre de page —
              la même paire que `PageHeader`, pas une valeur inventée ici. */}
          <p className="text-center text-display-28 tracking-[-0.015em] text-ink">{greeting}</p>
        </div>
      )}
      <div className={`w-full ${parti ? 'shrink-0 pt-2 pb-3' : ''}`}>{composer}</div>
    </div>
  );
}
