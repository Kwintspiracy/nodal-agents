'use client';

// RecentApprovals — la section RECENTS du panneau Approvals (#258).
//
// Ce qui a REÇU une réponse : approuvé, refusé, ou expiré. La planche dessine
// quatre lignes au nom de l'agent qui demandait, chacune avec un point GRIS —
// gris parce que plus rien n'attend là, par opposition au rouge de la section
// au-dessus.
//
// Toutes mènent à la page des approbations : une demande rendue n'a pas de
// page à elle, et c'est là qu'on relit ce qu'on a décidé.

import { listSidebarRecentApprovalsAction } from '@/lib/sidebar-actions.ts';
import SidebarDynamicList from './SidebarDynamicList';

export default function RecentApprovals() {
  return (
    <SidebarDynamicList
      testId="recents"
      read={listSidebarRecentApprovalsAction}
      hrefOf={() => '/approvals'}
      dot
      empty="No Recent Decision"
    />
  );
}
