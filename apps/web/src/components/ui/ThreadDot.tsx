// ThreadDot — le point devant un fil, dans la barre latérale.
//
// Il vivait dans `ChatFolderGroup` ; il est ici depuis le 19/09/2026 (#230),
// parce que la section « Recent » du panneau Talk montre les mêmes fils, et
// qu'un point de deux couleurs écrit à deux endroits finit par dire deux choses
// différentes du même fil.
//
// Le point est dans la COLONNE de l'icône de son dossier — même largeur, même
// retrait, si bien que les points d'un sous-menu et les icônes des dossiers
// tombent sur une seule verticale.
//
// TROIS ÉTATS, DEUX COULEURS depuis le 22/09/2026 (décision du propriétaire) :
// rouge quand quelque chose ATTEND UNE RÉPONSE, lime quand il s'y passe
// quelque chose — un run qui tourne, du non-lu — et gris au repos. Le lime est
// celui de `LiveDot`, le même jeton, parce que « il s'y passe quelque chose »
// se dit d'une seule façon dans le produit.
//
// Il ne BAT PAS, même en lime : seul ce qui tourne en ce moment bat, et le
// point d'un fil dit aussi bien « il y a du non-lu », qui ne bouge pas. Ce que
// chaque couleur veut dire exactement vit avec la règle : `threadDotTone`,
// lib/chat-folders.ts.

import { threadCallsFor, threadDotTone, type FolderThread } from '@/lib/chat-folders.ts';

/** La couleur de chaque sens. Le gris est celui d'un FILET, pas d'un texte. */
const FOND: Record<ReturnType<typeof threadDotTone>, string> = {
  attention: 'bg-attention',
  activite: 'bg-agent-vivid',
  repos: 'bg-rule-2',
};

export default function ThreadDot({
  thread,
}: {
  thread: Pick<FolderThread, 'waiting' | 'running' | 'unread'>;
}) {
  const appelle = threadCallsFor(thread);
  const sens = threadDotTone(thread);
  return (
    <span className="flex h-3.5 w-3.5 shrink-0 items-center justify-center">
      <span
        data-testid="thread-dot"
        data-calls={appelle ? 'yes' : 'no'}
        // CE QU'IL DIT, lisible par un test sans passer par la classe : une
        // couleur se renomme, un sens non.
        data-tone={sens}
        // 8 px, et le gris est celui d'un filet (`rule-2`), pas d'un texte : la
        // planche 25:1062 (20/09) dessine le point au repos à peine plus clair
        // que le fond, pour que seul ce qui appelle se voie.
        className={`h-2 w-2 rounded-full ${FOND[sens]}`}
      />
    </span>
  );
}
