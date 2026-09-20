'use client';

// CronList — la section CRON du panneau Run (#258).
//
// Les automatisations à l'horloge, par leur nom, chacune ouvrant sa page.
// La planche les dessine SANS point : une tâche planifiée n'attend rien de
// personne, elle se déclenche toute seule.
//
// Un schedule et un webhook partagent la MÊME page (`/automations/[id]`) :
// « une automatisation » est ce qu'on regarde, et le chargeur tranche en base.

import { listSidebarCronAction } from '@/lib/sidebar-actions.ts';
import SidebarDynamicList from './SidebarDynamicList';
import RowActions from './RowActions';

export default function CronList() {
  return (
    <SidebarDynamicList
      testId="cron"
      read={listSidebarCronAction}
      hrefOf={(r) => `/automations/${r.id}`}
      empty="No Existing Automation"
      seeAll="/automations"
      menu={(r, relire) => (
        <RowActions
          kind="cron"
          id={r.id}
          name={r.name}
          href={`/automations/${r.id}`}
          onDone={relire}
        />
      )}
    />
  );
}
