'use client';

// WebhooksList — la section WEBHOOKS du panneau Run (#258).
//
// Les déclencheurs HTTP, par leur nom. Sans point, pour la même raison que les
// tâches planifiées : ce qui les déclenche vient de dehors, pas de la personne.
//
// ⚠️ « No Existing Webhook » EST LA PHRASE DE LA PLANCHE, au singulier et
// capitalisée ainsi. Elle est recopiée telle quelle plutôt que corrigée : le
// propriétaire écrit la copie de son produit, et une section vide est
// exactement l'endroit où il l'a écrite.

import { listSidebarWebhooksAction } from '@/lib/sidebar-actions.ts';
import SidebarDynamicList from './SidebarDynamicList';

export default function WebhooksList() {
  return (
    <SidebarDynamicList
      testId="webhooks"
      read={listSidebarWebhooksAction}
      hrefOf={(r) => `/automations/${r.id}`}
      empty="No Existing Webhook"
      seeAll="/automations"
    />
  );
}
