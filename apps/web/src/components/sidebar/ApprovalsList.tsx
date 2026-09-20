'use client';

// ApprovalsList — la section APPROVALS du panneau du même nom (#258).
//
// Ce qui ATTEND une réponse, une ligne par demande, au nom de l'agent qui la
// pose. Vide, le cadre en pointillés de la planche : « No Approval Requests ».
//
// ⚠️ ELLE NE LIT RIEN. C'est la seule des sept listes du panneau dans ce cas,
// et c'est voulu : `ApprovalsProvider` tient déjà le compte des demandes en
// attente pour la pastille du rail et pour la cloche, et il le relit sur la
// cadence de la barre. Une seconde lecture des mêmes lignes aurait fait dire
// deux nombres différents à la même barre — la pastille disant trois, la liste
// en montrant deux le temps d'un tour d'horloge.
//
// Toutes les lignes mènent à la page des approbations : une demande n'a pas de
// page à elle, c'est la carte de cette page qui porte les deux boutons.

import SidebarRow from '../ui/SidebarRow';
import SidebarEmpty from '../ui/SidebarEmpty';
import ThreadDot from '../ui/ThreadDot';
import { useApprovals } from '../ApprovalsProvider';
import { FOLDER_THREADS_MAX } from '@/lib/chat-folders.ts';

export default function ApprovalsList() {
  const { pending } = useApprovals();

  if (pending.length === 0) return <SidebarEmpty>No Approval Requests</SidebarEmpty>;

  // Le MÊME plafond que les sous-menus : une barre latérale ne devient pas la
  // page, et la pastille du rail porte déjà le compte exact.
  const lignes = pending.slice(0, FOLDER_THREADS_MAX);

  return (
    <div className="flex flex-col gap-0" data-testid="sidebar-list-approvals">
      {lignes.map((a) => (
        <SidebarRow
          key={a.id}
          href="/approvals"
          // L'outil en infobulle : le nom de l'agent dit QUI demande, l'outil
          // dit QUOI, et la ligne n'a la place que du premier.
          title={a.toolName}
          depth="thread"
          testId="sidebar-row-approvals"
        >
          {/* ROUGE, toujours : une demande en attente appelle la personne par
              définition, c'est le sens même de cette section. */}
          <ThreadDot thread={{ waiting: true, running: false, unread: false }} />
          <span className="flex-1 truncate leading-5">{a.agentName ?? a.toolName}</span>
        </SidebarRow>
      ))}
    </div>
  );
}
