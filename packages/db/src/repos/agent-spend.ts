// agent-spend.ts — ce qu'un agent a dépensé aujourd'hui et ce mois-ci, et ce
// que son budget en dit (issue #447).
//
// UN compteur, lu par les trois endroits qui l'opposent ou le montrent : la
// boucle du runner entre deux tours, la garde avant un run de CLI de code
// (outil `code_task` et runtimes CLI), et l'onglet Settings de l'agent. Trois
// sommes recopiées finiraient par dire trois choses différentes.
//
// Ce qui compte : les appels d'API de TOUS les fournisseurs (`llm_calls`,
// chat et jobs, délégations comprises puisque chaque appel porte l'agent qui
// l'a fait) et les runs de CLI de code (`cli_runs`, coût notionnel pour le CLI
// Claude ; Codex n'en rapporte aucun). Un appel dont le prix est inconnu vaut
// 0 : il n'est pas deviné.
//
// Les fenêtres suivent le FUSEAU DE L'ESPACE : « aujourd'hui » commence à
// minuit là où vit l'espace, pas là où tourne le serveur.

import { eq, sql } from 'drizzle-orm';
import type { AnyDrizzleDb } from '../client.ts';
import { agents } from '../schema/agents.ts';
import { entities } from '../schema/entities.ts';

export interface AgentSpend {
  todayUsd: number;
  monthUsd: number;
}

export interface AgentBudgetState extends AgentSpend {
  dailyUsd: number;
  monthlyUsd: number;
  alertPct: number;
  timezone: string;
  /** La fenêtre dont le plafond est atteint, ou `null`. Le jour passe avant le mois. */
  reached: 'day' | 'month' | null;
}

/**
 * Ce que l'agent a dépensé depuis minuit et depuis le 1er du mois, dans
 * `timezone`. `now` est injectable pour que les fenêtres se prouvent à date
 * fixe ; en production, c'est l'instant de l'appel.
 */
export async function readAgentSpend(
  db: AnyDrizzleDb,
  agentId: string,
  timezone: string,
  now: Date = new Date(),
): Promise<AgentSpend> {
  const at = sql`${now.toISOString()}::timestamptz`;
  const day = sql`(date_trunc('day', ${at} AT TIME ZONE ${timezone}) AT TIME ZONE ${timezone})`;
  const month = sql`(date_trunc('month', ${at} AT TIME ZONE ${timezone}) AT TIME ZONE ${timezone})`;
  // Une requête, sur la ligne de l'agent, par le constructeur de Drizzle : même
  // forme de résultat sous postgres-js et sous PGlite (un `db.execute` brut rend
  // un tableau chez l'un, `{ rows }` chez l'autre).
  const sum = (table: 'llm_calls' | 'cli_runs', from: typeof day) =>
    sql`coalesce((SELECT sum(cost_usd) FROM ${sql.raw(table)} WHERE agent_id = ${agents.id} AND created_at >= ${from}), 0)`;
  const rows = await db
    .select({
      today: sql<number | string>`${sum('llm_calls', day)} + ${sum('cli_runs', day)}`,
      month: sql<number | string>`${sum('llm_calls', month)} + ${sum('cli_runs', month)}`,
    })
    .from(agents)
    .where(eq(agents.id, agentId))
    .limit(1);
  return { todayUsd: Number(rows[0]?.today ?? 0), monthUsd: Number(rows[0]?.month ?? 0) };
}

/**
 * L'état du budget d'un agent : ses plafonds, ce qu'il a dépensé, et la
 * fenêtre atteinte s'il y en a une. `null` si l'agent n'existe pas.
 *
 * `fallbackTimezone` : le fuseau du serveur, quand l'espace n'en a pas
 * enregistré (même règle que `resolveTimezone` de @nodal-agents/shared, que ce
 * paquet n'importe pas).
 */
export async function readAgentBudgetState(
  db: AnyDrizzleDb,
  agentId: string,
  fallbackTimezone: string,
): Promise<AgentBudgetState | null> {
  const [row] = await db
    .select({
      dailyUsd: agents.budgetDailyUsd,
      monthlyUsd: agents.budgetMonthlyUsd,
      alertPct: agents.budgetAlertPct,
      timezone: entities.timezone,
    })
    .from(agents)
    .leftJoin(entities, eq(entities.id, agents.entityId))
    .where(eq(agents.id, agentId))
    .limit(1);
  if (!row) return null;
  const timezone = row.timezone ?? fallbackTimezone;
  const spend = await readAgentSpend(db, agentId, timezone);
  return { ...row, timezone, ...spend, reached: budgetReached(row, spend) };
}

/** La fenêtre dont le plafond est atteint (0 = aucun plafond). Pure. */
export function budgetReached(
  ceilings: { dailyUsd: number; monthlyUsd: number },
  spend: AgentSpend,
): 'day' | 'month' | null {
  if (ceilings.dailyUsd > 0 && spend.todayUsd >= ceilings.dailyUsd) return 'day';
  if (ceilings.monthlyUsd > 0 && spend.monthUsd >= ceilings.monthlyUsd) return 'month';
  return null;
}
