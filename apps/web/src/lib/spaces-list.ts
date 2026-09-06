// spaces-list.ts — la liste des espaces, en deux sections (retour de Quentin,
// 06/09 : « la liste est noyée par les cron, il faut les grouper à part »).
//
// Pur, pas de DB : des lignes → { conversations, scheduled }. Les tâches
// venues d'une automatisation se regroupent par automatisation (une ligne par
// automatisation, ses runs dessous, repliés) ; tout le reste — dashboard,
// Telegram, chat, API, webhook — est une conversation, telle quelle.

import type { SpaceListRow } from './actions.ts';

export type ScheduleGroup = {
  /** L'id de l'automatisation, ou son nom, ou la tâche — le premier connu. */
  key: string;
  name: string;
  agentName: string;
  agentSlug: string | null;
  agentAvatarUrl: string | null;
  runs: SpaceListRow[];
  lastRun: SpaceListRow;
  /** Runs terminés en échec ou annulés, sur ceux listés. */
  failed: number;
  totalCostUsd: number;
};

export type SpacesList = {
  conversations: SpaceListRow[];
  scheduled: ScheduleGroup[];
};

export function groupSpaces(rows: readonly SpaceListRow[]): SpacesList {
  const conversations: SpaceListRow[] = [];
  const groups = new Map<string, ScheduleGroup>();
  for (const r of rows) {
    if (r.channel !== 'cron') {
      conversations.push(r);
      continue;
    }
    const key = r.scheduleId ?? r.scheduleName ?? r.task;
    const g = groups.get(key);
    if (g) {
      g.runs.push(r);
      if (r.status === 'failed' || r.status === 'cancelled') g.failed += 1;
      g.totalCostUsd += r.costUsd;
      continue;
    }
    groups.set(key, {
      key,
      name: r.scheduleName ?? firstLine(r.task),
      agentName: r.agentName,
      agentSlug: r.agentSlug,
      agentAvatarUrl: r.agentAvatarUrl,
      runs: [r],
      lastRun: r, // les lignes arrivent les plus récentes d'abord
      failed: r.status === 'failed' || r.status === 'cancelled' ? 1 : 0,
      totalCostUsd: r.costUsd,
    });
  }
  return { conversations, scheduled: [...groups.values()] };
}

export function firstLine(text: string): string {
  return text.split('\n')[0] ?? text;
}
