'use client';

// RecentApprovals — la section RECENTS du panneau Approvals (#258).
//
// Ce qui a REÇU une réponse : approuvé, refusé, ou expiré. Chaque ligne avec
// un point GRIS — gris parce que plus rien n'attend là, par opposition au
// rouge de la section au-dessus.
//
// La ligne dit CE QUE la demande voulait faire — la phrase que la page des
// approbations écrit en titre de sa carte — et pas le nom de l'agent, qui ne
// disait rien à quatre exemplaires (Quentin, 20/09).
//
// ⚠️ ELLE OUVRE LA CARTE DE LA DEMANDE DANS LA VUE PRINCIPALE
// (`/approvals?show=<id>`, Quentin 20/09) : la carte entière, celle des
// demandes en attente — la raison, l'effet, les arguments, l'entrée de
// l'outil — avec ce qui a été décidé. Pas un résumé dans la barre, et pas le
// fil de la conversation. Seule la ligne dont la carte est ouverte s'allume.

import { useCallback } from 'react';
import { usePathname, useSearchParams } from 'next/navigation';
import { listSidebarRecentApprovalsAction } from '@/lib/sidebar-actions.ts';
import SidebarDynamicList from './SidebarDynamicList';

export default function RecentApprovals() {
  const pathname = usePathname();
  const show = useSearchParams().get('show');

  const lire = useCallback(async (limit: number) => {
    const r = await listSidebarRecentApprovalsAction(limit);
    if (!r.ok) return r;
    return {
      ok: true as const,
      data: r.data.map((a) => ({
        id: a.id,
        name: a.what,
        title: `${a.name} · ${a.toolName}`,
      })),
    };
  }, []);

  return (
    <SidebarDynamicList
      testId="recents"
      read={lire}
      hrefOf={(r) => `/approvals?show=${encodeURIComponent(r.id)}`}
      isActive={(r) => pathname === '/approvals' && show === r.id}
      dot
      empty="No Recent Decision"
    />
  );
}
