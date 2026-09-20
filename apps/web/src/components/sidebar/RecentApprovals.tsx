'use client';

// RecentApprovals — la section RECENTS du panneau Approvals (#258).
//
// Ce qui a REÇU une réponse : approuvé, refusé, ou expiré. Chaque ligne avec
// un point GRIS — gris parce que plus rien n'attend là, par opposition au
// rouge de la section au-dessus.
//
// ⚠️ UNE LIGNE NE NAVIGUE PAS (Quentin, 20/09 : « ça doit pas naviguer, ça
// doit afficher le résumé de la demande »). C'est un BOUTON qui déplie, sous
// la ligne, le résumé de la demande : ce qu'elle voulait faire, qui la posait
// et par quel outil, ce qui a été décidé et quand. Rien ne s'allume par
// défaut : aucune ligne n'est « la page où l'on est », puisque aucune n'est
// une page.
//
// La ligne dit CE QUE la demande voulait faire — la phrase que la page des
// approbations écrit en titre de sa carte — et pas le nom de l'agent, qui ne
// disait rien à quatre exemplaires.

import { useCallback, useState } from 'react';
import {
  listSidebarRecentApprovalsAction,
  type SidebarApprovalRow,
} from '@/lib/sidebar-actions.ts';
import { useSidebarRead } from '@/lib/use-sidebar-read.ts';
import { FOLDER_THREADS_PROBE, unfoldedRows } from '@/lib/chat-folders.ts';
import SidebarRow, { SIDEBAR_NOTE } from '../ui/SidebarRow';
import SidebarEmpty from '../ui/SidebarEmpty';
import SidebarCaret from '../ui/SidebarCaret';
import ThreadDot from '../ui/ThreadDot';

const DECISION: Record<SidebarApprovalRow['status'], string> = {
  approved: 'Approved',
  rejected: 'Rejected',
  expired: 'Expired',
};

function quand(iso: string | null): string {
  if (iso === null) return '';
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return '';
  return new Intl.DateTimeFormat('en-GB', {
    day: '2-digit',
    month: 'short',
    hour: '2-digit',
    minute: '2-digit',
  }).format(d);
}

export default function RecentApprovals() {
  const lire = useCallback(() => listSidebarRecentApprovalsAction(FOLDER_THREADS_PROBE), []);
  const { rows, erreur } = useSidebarRead<SidebarApprovalRow>(lire);
  // UNE seule ligne dépliée à la fois : deux résumés ouverts dans une colonne
  // de 300 px repousseraient tout hors de vue.
  const [ouverte, setOuverte] = useState<string | null>(null);

  const lignes = rows === null ? null : unfoldedRows(rows).rows;

  return (
    <div className="flex flex-col gap-0" data-testid="sidebar-list-recents">
      {erreur !== null ? (
        <p className={SIDEBAR_NOTE}>{erreur}</p>
      ) : lignes === null ? (
        <p className={SIDEBAR_NOTE}>Loading</p>
      ) : lignes.length === 0 ? (
        <SidebarEmpty>No Recent Decision</SidebarEmpty>
      ) : (
        lignes.map((a) => {
          const open = ouverte === a.id;
          const basculer = () => setOuverte((o) => (o === a.id ? null : a.id));
          return (
            <div key={a.id}>
              <SidebarRow
                onToggle={basculer}
                expanded={open}
                title={`${a.name} · ${a.toolName}`}
                depth="thread"
                testId="sidebar-row-recents"
                caret={
                  <SidebarCaret
                    open={open}
                    onToggle={basculer}
                    label={a.what}
                    testId="recent-caret"
                  />
                }
              >
                <ThreadDot thread={{ waiting: false, running: false, unread: false }} />
                <span className="flex-1 truncate leading-5">{a.what}</span>
              </SidebarRow>
              {open && (
                <div
                  data-testid="recent-summary"
                  className="mx-2 mb-1 flex flex-col gap-1 rounded-lg border border-rule-2 bg-paper px-3 py-2 text-body-12 text-ink-2"
                >
                  <p className="text-ink">{a.what}</p>
                  <p className="text-ink-3">
                    {a.name} · {a.toolName}
                  </p>
                  <p className="text-ink-3">
                    {DECISION[a.status]}
                    {quand(a.resolvedAt) !== '' ? ` · ${quand(a.resolvedAt)}` : ''}
                  </p>
                  {a.answer !== null && a.answer !== '' && (
                    <p className="text-ink-2">Answer: {a.answer}</p>
                  )}
                </div>
              )}
            </div>
          );
        })
      )}
    </div>
  );
}
