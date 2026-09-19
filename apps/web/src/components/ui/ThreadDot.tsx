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
// Deux couleurs, et deux seulement : `attention` quand le fil a quelque chose
// pour la personne, `ink-4` sinon. Il ne clignote pas — ce n'est pas un
// `LiveDot`, qui dit « ça bouge en ce moment » ; celui-ci dit « il y a de quoi
// revenir ». Ce que ce rouge veut dire exactement, et ce qu'il ne veut PAS
// dire, vit avec la règle : `threadCallsFor`, lib/chat-folders.ts.

import { threadCallsFor, type FolderThread } from '@/lib/chat-folders.ts';

export default function ThreadDot({
  thread,
}: {
  thread: Pick<FolderThread, 'waiting' | 'running' | 'unread'>;
}) {
  const appelle = threadCallsFor(thread);
  return (
    <span className="flex h-3.5 w-3.5 shrink-0 items-center justify-center">
      <span
        data-testid="thread-dot"
        data-calls={appelle ? 'yes' : 'no'}
        className={`h-1.5 w-1.5 rounded-full ${appelle ? 'bg-attention' : 'bg-ink-4'}`}
      />
    </span>
  );
}
