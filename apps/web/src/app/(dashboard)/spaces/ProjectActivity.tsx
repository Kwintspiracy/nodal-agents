// ProjectActivity — UNE liste, deux sortes de lignes (#143, planche 444:347).
//
// Le principe, dans les mots de la planche : « a conversation row (what was
// said last, and how many sessions it started) opens the thread, where the
// sessions unfold; a session row without a conversation opens the run page ».
//
// Le composant de ligne est celui des boîtes de réception : même boîte, mêmes
// signes, même géométrie. Ce qui change est ce qu'il y a DEDANS, et c'est
// `activity-rows.ts` qui le décide — pas ce fichier, qui ne fait que dessiner.

import ConversationRow from '@/components/ui/ConversationRow';
import EmptyState from '@/components/ui/EmptyState';
import type { ConversationRowModel } from '@/app/(dashboard)/chat/conversation-rows.ts';

export default function ProjectActivity({ rows }: { rows: ConversationRowModel[] }) {
  if (rows.length === 0) {
    return (
      <EmptyState
        title="Nothing has happened here yet"
        description="Open a conversation on this project, or let an agent write in its folder."
      />
    );
  }

  return (
    <>
      {/* Pas d'écart entre les lignes : un trait les sépare dans une seule
          boîte, et `overflow-hidden` fait suivre les coins arrondis à la
          première et à la dernière — la même boîte que les dossiers de chat. */}
      <div
        className="divide-y divide-rule-2 overflow-hidden rounded-xl border border-rule-2 bg-paper"
        data-testid="project-activity"
      >
        {rows.map(({ key, ...ligne }) => (
          // `lead="title"` : dans un projet l'agent CHANGE d'une ligne à
          // l'autre — son avatar distingue les lignes — mais ce qui identifie
          // une ligne est ce qui a été demandé, pas qui l'a fait.
          <ConversationRow key={key} rowKey={key} lead="title" {...ligne} />
        ))}
      </div>
      <p className="mt-3 text-body-12 text-ink-4">
        Two kinds of rows, one list: a conversation row opens the thread, where its sessions unfold.
        A session row without a conversation opens the run page.
      </p>
    </>
  );
}
