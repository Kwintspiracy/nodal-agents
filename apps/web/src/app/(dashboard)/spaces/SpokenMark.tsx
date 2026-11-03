// SpokenMark — « Spoken · 0:03 » sous une demande DITE (#942).
//
// Une seule définition pour les deux endroits qui la montrent : le fil rendu
// (`ConversationFeedView`, la durée rangée par le runner) et la copie en
// attente (`PendingTurn`, la durée que la route du tour vient de dire, #943).
// Deux copies du même marquage finiraient par ne plus se ressembler, et la
// demande sauterait quand le fil relu remplace la copie.

import { Microphone } from '@phosphor-icons/react/dist/ssr';
import { clockDuration } from './format.ts';

export default function SpokenMark({ ms, testId }: { ms: number; testId: string }) {
  return (
    <p
      className="mt-1.5 flex items-center justify-end gap-1 text-mono-11 text-ink-4"
      data-testid={testId}
    >
      <Microphone size={12} weight="regular" aria-hidden="true" />
      {`Spoken · ${clockDuration(ms)}`}
    </p>
  );
}
