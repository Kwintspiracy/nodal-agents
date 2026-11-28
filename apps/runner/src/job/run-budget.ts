// job/run-budget.ts — le budget de run de l'espace, pour les DEUX chemins d'un job.
//
// Un job tourne soit dans la boucle de Nodal (job/execute.ts), soit dans une
// CLI de code (cli-runtime/run-job.ts). Le budget de run de l'espace
// (`entities.max_run_cost_usd`, #442) borne le RUN, c'est-à-dire tout l'arbre
// de délégation (revue de #836, P1) : les deux chemins le lisent ici, et
// aucun ne démarre un appel ou un tour sur un run qui a déjà dépensé son
// plafond.

import { eq, entities, readRunCost, runSpentUsd } from '@nodal-agents/db';
import type { AnyDrizzleDb } from '@nodal-agents/db';
import { DEFAULT_LIMITS } from '@nodal-agents/orchestration';
import { CLI_SESSION_HOURS_WITHOUT_TIME_LIMIT } from '@nodal-agents/shared';

/**
 * Le plafond de coût d'un run, depuis le réglage de l'espace (#442).
 * `0` = aucun plafond ; une ligne d'espace absente garde le défaut de la
 * plateforme, qui est aussi le défaut de la colonne.
 */
export function runCostCeilingUsd(
  settingUsd: number | null | undefined,
  defaultUsd: number,
): number {
  if (settingUsd === null || settingUsd === undefined) return defaultUsd;
  return settingUsd > 0 ? settingUsd : Infinity;
}

/** Le plafond de coût d'un run de cet espace. */
export async function readRunCostCeilingUsd(
  db: AnyDrizzleDb,
  entityId: string | null,
): Promise<number> {
  // Un job sans espace (un appelant interne de /api/agent) n'a pas de ligne de
  // réglages : le défaut de la plateforme, comme pour une ligne absente.
  if (!entityId) return runCostCeilingUsd(undefined, DEFAULT_LIMITS.maxCostPerJobUsd);
  const [row] = await db
    .select({ maxRunCostUsd: entities.maxRunCostUsd })
    .from(entities)
    .where(eq(entities.id, entityId))
    .limit(1);
  return runCostCeilingUsd(row?.maxRunCostUsd, DEFAULT_LIMITS.maxCostPerJobUsd);
}

/**
 * Ce que le run de `jobId` a dépensé : les autres jobs de son arbre, tels
 * qu'ils l'ont écrit, plus `ownUsd`, la dépense en mémoire de ce job.
 */
export async function readRunSpentUsd(
  db: AnyDrizzleDb,
  jobId: string,
  ownUsd: number,
): Promise<number> {
  return runSpentUsd(await readRunCost(db, jobId), jobId, ownUsd);
}

/**
 * Ce qu'un budget arrêté rapporte : quoi, combien, contre quel plafond, où.
 * `cost`, `time`, `tokens` : le budget du RUN (#442). `agent_day`,
 * `agent_month` : le budget de l'AGENT, tous fournisseurs (#447). `turns` : le
 * plafond de tours de l'invariant 8, qui livre lui aussi ce qui a été écrit
 * (#504) au lieu de le jeter. `tool_calls` : le plafond d'appels d'UNE réponse
 * du modèle (invariant 8), quand une session de CLI le dépasse et est tuée (le
 * loop de Nodal, lui, refuse la réponse entière avant d'en exécuter un appel).
 */
export interface BudgetStopFacts {
  kind: 'cost' | 'time' | 'tokens' | 'turns' | 'tool_calls' | 'agent_day' | 'agent_month';
  spent: number;
  limit: number;
  turn: number;
}

/** Le code d'erreur d'un run arrêté par son budget. Les deux premiers existaient déjà. */
export function budgetErrorCode(kind: BudgetStopFacts['kind']): string {
  if (kind === 'agent_day' || kind === 'agent_month') return 'agent_budget_exceeded';
  if (kind === 'turns') return 'turn_limit_exceeded';
  if (kind === 'tool_calls') return 'tool_call_limit_exceeded';
  return kind === 'cost'
    ? 'cost_budget_exceeded'
    : kind === 'tokens'
      ? 'token_budget_exceeded'
      : 'run_time_exceeded';
}

/**
 * La ligne que l'utilisateur lit quand un run s'arrête sur son budget (#442).
 *
 * Même famille que `timeoutStopLine` : une ligne de PLATEFORME, entre
 * crochets, faite de champs typés (ce qui a été dépensé, le plafond, le tour).
 * Avant #442 ces arrêts écrivaient « ⚠️ The task could not be completed
 * (cost_budget_exceeded) and no explanation was provided » et jetaient ce que
 * le run avait déjà écrit.
 */
export function budgetStopLine(f: BudgetStopFacts): string {
  if (f.kind === 'cost') {
    return `[stopped: run budget — $${f.spent.toFixed(2)} spent, ceiling $${f.limit.toFixed(2)}, turn ${f.turn}]`;
  }
  if (f.kind === 'turns') {
    return `[stopped: turn limit — ${f.spent} turns, ceiling ${f.limit}]`;
  }
  if (f.kind === 'tool_calls') {
    return `[stopped: tool call limit — ${f.spent} tool calls in one model response, ceiling ${f.limit}, turn ${f.turn}]`;
  }
  if (f.kind === 'agent_day' || f.kind === 'agent_month') {
    const when = f.kind === 'agent_day' ? 'today' : 'this month';
    return `[stopped: agent budget — $${f.spent.toFixed(2)} spent ${when}, ceiling $${f.limit.toFixed(2)}, turn ${f.turn}]`;
  }
  if (f.kind === 'time') {
    // À la minute, et le temps passé ARRONDI AU-DESSUS : coupé à 2 h 00 min
    // 01 s sous un plafond de 2 h, la ligne disait « 2.0 h of work, ceiling
    // 2.0 h », un dépassement illisible (revue de la PR #495).
    const hm = (minutes: number) =>
      `${Math.floor(minutes / 60)} h ${String(minutes % 60).padStart(2, '0')} min`;
    return `[stopped: run budget — ${hm(Math.ceil(f.spent / 60_000))} of work, ceiling ${hm(Math.floor(f.limit / 60_000))}, turn ${f.turn}]`;
  }
  const n = (x: number) => Math.round(x).toLocaleString('en-US');
  return `[stopped: token budget — ${n(f.spent)} tokens, ceiling ${n(f.limit)}, turn ${f.turn}]`;
}

/**
 * Ce qu'un run arrêté par son budget livre : son DERNIER texte des tours
 * précédents (relu dans la transcription enregistrée, donc aussi d'avant une
 * suspension), puis celui du tour en cours s'il en a un, et la ligne qui dit
 * pourquoi il s'arrête. Un texte identique n'est pas répété.
 *
 * Le dernier texte, pas tous : c'est l'état le plus récent de ce que l'agent
 * rendait, la même lecture que le livrable d'un run qui finit normalement
 * (`lastAssistantTextSeen`). Empiler chaque texte intermédiaire livrerait des
 * brouillons que l'agent a lui-même dépassés (revue de la PR #495).
 */
export function budgetDeliverable(prior: string, current: string, line: string): string {
  const parts = [prior.trim()];
  if (current.trim() !== '' && current.trim() !== prior.trim()) parts.push(current.trim());
  parts.push(line);
  return parts.filter((t) => t !== '').join('\n\n');
}

/** La durée maximale d'un run en ms, depuis `entities.max_run_hours` (`0` = aucune). */
export function runTimeCeilingMs(settingHours: number | null | undefined): number {
  return settingHours !== null && settingHours !== undefined && settingHours > 0
    ? settingHours * 3_600_000
    : Infinity;
}

/** Le plafond de temps travaillé d'un run de cet espace, en ms (`Infinity` = aucun). */
export async function readRunTimeCeilingMs(
  db: AnyDrizzleDb,
  entityId: string | null,
): Promise<number> {
  // Même lecture que la boucle de Nodal (execute.ts, 8b) : sans espace, ou sans
  // ligne, aucune limite de temps.
  if (!entityId) return runTimeCeilingMs(undefined);
  const [row] = await db
    .select({ maxRunHours: entities.maxRunHours })
    .from(entities)
    .where(eq(entities.id, entityId))
    .limit(1);
  return runTimeCeilingMs(row?.maxRunHours);
}

/**
 * Le temps qu'une session de CLI de code (Claude Code, Codex) peut travailler :
 * le plafond de temps du run, celui que l'espace règle (« Working time of one
 * run »), le même que la boucle de Nodal applique.
 *
 * Quand l'espace ne pose AUCUNE limite de temps, la boucle de Nodal reste bornée
 * par ce qu'elle compte à chaque tour : ses tours, ses jetons, le coût de
 * l'arbre. Une session de CLI garde sa boucle pour elle : Nodal n'en voit ni les
 * tours ni les jetons avant la fin, et Codex ne rapporte aucun coût. Sans borne
 * de temps, rien ne l'arrêterait que la personne. Elle reçoit donc
 * `CLI_SESSION_HOURS_WITHOUT_TIME_LIMIT`, dit sous le réglage même
 * (RunBudgetSection), jamais une constante cachée dans l'adaptateur.
 */
export function cliSessionTimeLimitMs(runCeilingMs: number): number {
  return Number.isFinite(runCeilingMs)
    ? runCeilingMs
    : CLI_SESSION_HOURS_WITHOUT_TIME_LIMIT * 3_600_000;
}
