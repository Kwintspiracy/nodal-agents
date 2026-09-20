'use client';

// RecentApprovals — la section RECENTS du panneau Approvals (#258).
//
// Ce qui a REÇU une réponse : approuvé, refusé, ou expiré. Chaque ligne avec
// un point GRIS — gris parce que plus rien n'attend là, par opposition au
// rouge de la section au-dessus.
//
// ⚠️ LA LIGNE DIT CE QUE LA DEMANDE VOULAIT FAIRE, pas qui la posait (Quentin,
// 20/09 : quatre lignes « Researcher » ne disent rien). C'est la phrase que la
// page des approbations écrit en titre de sa carte ; l'agent et l'outil sont
// en infobulle.
//
// ⚠️ ET ELLE MÈNE AU FIL où la demande a été posée. Toutes menaient à la page
// des approbations : sur cette page, elles s'allumaient donc toutes comme « la
// ligne où l'on est » et ne menaient nulle part. Une demande rendue se relit
// là où elle a eu lieu ; sans fil (un run sans conversation), la page des
// approbations reste le repli.

import { useCallback } from 'react';
import { listSidebarRecentApprovalsAction } from '@/lib/sidebar-actions.ts';
import SidebarDynamicList from './SidebarDynamicList';

export default function RecentApprovals() {
  const lire = useCallback(async (limit: number) => {
    const r = await listSidebarRecentApprovalsAction(limit);
    if (!r.ok) return r;
    return {
      ok: true as const,
      data: r.data.map((a) => ({
        id: a.id,
        name: a.what,
        title: `${a.name} · ${a.toolName}`,
        href: a.conversationId === null ? '/approvals' : `/chat/${a.conversationId}`,
      })),
    };
  }, []);

  return (
    <SidebarDynamicList
      testId="recents"
      read={lire}
      hrefOf={(r) => r.href ?? '/approvals'}
      dot
      empty="No Recent Decision"
    />
  );
}
