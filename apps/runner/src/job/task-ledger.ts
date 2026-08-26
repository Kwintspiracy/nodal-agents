// job/task-ledger.ts — delegated-task action ledger for conversational history.
//
// Incident (2026-07-12): a dashboard chat turn ("research Law & Order and send
// the result to Mathilde") escalated into a ROOT job that delegated via
// `create_task` (packages/orchestration/src/planner/task-tools.ts). The task
// ran in its OWN child `agent_jobs` row (channel='task-board') and really did
// call `telegram_send_message` — but the root job's compiled result
// (deliverCompletedRoots' `compileTaskResults`) is just the child agent's own
// PROSE, not a structural record of its tool calls. When the user asked "did
// you send it?", neither history-loading path (loadThreadHistory for
// telegram/slack/discord threads, runChatTurn's own history for dashboard
// conversations) had any way to see the delegated job's real actions — only
// the ROOT job's status/result was replayed, and a prose summary that doesn't
// happen to mention "sent via Telegram" reads as silence. The agent denied
// sending it — sincerely, because nothing in its context said otherwise.
//
// This is the delegation-boundary extension of thread-history.ts's Layer 1
// (STATE_CHANGING_TOOLS ledger): that ledger covers a job's OWN tools_used;
// this one covers the tools_used of jobs it DELEGATED to via create_task,
// keyed by `agent_tasks.root_job_id` — the exact link create_task stamps
// (task-tools.ts: `rootJobId: ctx.jobId`) and execute-ready.ts resolves to a
// child `agent_jobs` row (`agent_tasks.job_id`).
//
// Scope: only TERMINAL tasks (done/blocked) — a still-running task hasn't
// finished acting yet, so surfacing it as a ledger fact would be premature.
// `cancelled` tasks are also excluded: nothing happened to report.

import { eq, and, inArray, desc } from '@nodal-agents/db';
import { agentTasks, agentJobs, agents } from '@nodal-agents/db';
import type { RunnerDeps } from '../deps.ts';

/** Max ledger entries surfaced per root job — keeps a busy fan-out bounded. */
export const MAX_TASKS_PER_EXCHANGE = 3;

/** Task result/error text is truncated to this many chars in the ledger line. */
const RESULT_TRUNCATE_CHARS = 200;

const TERMINAL_TASK_STATUSES = ['done', 'blocked'] as const;

/** Statuts d'un job enfant qui a fini d'agir — même intention que ci-dessus. */
const TERMINAL_JOB_STATUSES = ['completed', 'failed'] as const;

export interface TaskLedgerEntry {
  title: string;
  status: 'done' | 'blocked';
  toolsUsed: string[];
  result: string | null;
}

/**
 * Load the delegated-task ledger for a set of root jobs (jobs that may have
 * called `create_task`). Returns a `Map<rootJobId, entries>` — entries are
 * the up-to-`MAX_TASKS_PER_EXCHANGE` most recently finished terminal tasks,
 * in chronological order (oldest of that kept window first, matching
 * thread-history.ts's "read the thread the way the user lived it" convention).
 *
 * A rootJobId with no delegated tasks (or none yet terminal) is simply absent
 * from the map — callers should treat `.get(id) ?? []` as "nothing to add".
 */
export async function loadTaskLedger(
  db: RunnerDeps['db'],
  rootJobIds: readonly (string | null)[],
): Promise<Map<string, TaskLedgerEntry[]>> {
  const ledger = new Map<string, TaskLedgerEntry[]>();
  const ids = [...new Set(rootJobIds.filter((id): id is string => !!id))];
  if (ids.length === 0) return ledger;

  const rows = await db
    .select({
      rootJobId: agentTasks.rootJobId,
      title: agentTasks.title,
      status: agentTasks.status,
      result: agentTasks.result,
      toolsUsed: agentJobs.toolsUsed,
    })
    .from(agentTasks)
    .leftJoin(agentJobs, eq(agentJobs.id, agentTasks.jobId))
    .where(
      and(
        inArray(agentTasks.rootJobId, ids),
        inArray(agentTasks.status, TERMINAL_TASK_STATUSES as unknown as string[]),
      ),
    )
    .orderBy(desc(agentTasks.updatedAt));

  for (const row of rows) {
    if (!row.rootJobId) continue;
    const list = ledger.get(row.rootJobId) ?? [];
    if (list.length >= MAX_TASKS_PER_EXCHANGE) continue; // newest-first from ORDER BY — bounded here
    list.push({
      title: row.title,
      status: row.status as 'done' | 'blocked',
      toolsUsed: Array.isArray(row.toolsUsed) ? (row.toolsUsed as string[]) : [],
      result: row.result,
    });
    ledger.set(row.rootJobId, list);
  }

  for (const [key, list] of ledger) {
    ledger.set(key, list.reverse()); // newest-first -> chronological within the kept window
  }

  return ledger;
}

/** Collapse repeated tool names to `name ×N` — "web_search, telegram_send_message ×2". */
function formatTools(tools: readonly string[]): string {
  const counts = new Map<string, number>();
  for (const t of tools) counts.set(t, (counts.get(t) ?? 0) + 1);
  return [...counts.entries()].map(([name, n]) => (n > 1 ? `${name} ×${n}` : name)).join(', ');
}

function truncateResult(s: string | null): string {
  const text = (s ?? '').trim();
  if (!text) return '(no result)';
  return text.length > RESULT_TRUNCATE_CHARS ? `${text.slice(0, RESULT_TRUNCATE_CHARS)}…` : text;
}

/**
 * Render one ledger entry as the structural `[Task "…" …]` line injected into
 * conversational history — the real tool calls a delegated task made, pulled
 * from its OWN child job's `tools_used`, never from the creating job's prose.
 */
export function formatTaskLedgerEntry(entry: TaskLedgerEntry): string {
  const toolsStr = formatTools(entry.toolsUsed);
  const actionsPart = toolsStr ? `actions — ${toolsStr}; ` : '';
  return entry.status === 'blocked'
    ? `[Task "${entry.title}" failed: ${actionsPart}error: ${truncateResult(entry.result)}]`
    : `[Task "${entry.title}" completed: ${actionsPart}result: ${truncateResult(entry.result)}]`;
}

/** Format every entry for one root job into ready-to-append ledger lines. */
export function formatTaskLedgerLines(entries: readonly TaskLedgerEntry[]): string[] {
  return entries.map(formatTaskLedgerEntry);
}

// ─── Délégation EN LIGNE (`assign_*`) ────────────────────────────────────────
//
// Incident du 26/08. Un orchestrateur a annoncé sur Telegram, quatre fois dans
// la journée : « app livrée et validée par Reviewer C (2 passes) », avec le nom
// du relecteur et le nombre de passes. Aucune délégation, aucune écriture,
// aucun fichier. Il ne mentait pas : il complétait un motif.
//
// POURQUOI les deux registres existants l'ont laissé passer :
//
//   * celui de `thread-history` ne se déclenche que sur STATE_CHANGING_TOOLS,
//     où les outils de délégation ne peuvent pas figurer — ils s'appellent
//     `assign_<slug>`, et écrire un slug d'agent dans le runtime est
//     exactement ce que l'invariant #1 interdit ;
//   * celui du dessus ne lit que `agent_tasks`, la table du tableau de tâches
//     que pose `create_task`. La délégation EN LIGNE crée un `agent_jobs`
//     enfant via `parent_job_id` et ne touche jamais `agent_tasks`.
//
// Résultat : dans l'historique, un vrai compte rendu et un compte rendu inventé
// arrivaient nus tous les deux. Rien ne les distinguait, et chaque fabrication
// rejoignait le fil pour renforcer le motif au tour suivant.
//
// Ce qu'on rend ici : les ACTIONS, pas le résultat. Le résultat du travail est
// déjà dans la prose du parent — le redire coûterait cher pour rien. Mesuré sur
// une install réelle : la ligne complète pesait 531 caractères par tour
// concerné, soit 27 % du budget de `thread-history` sur huit tours ; réduite
// aux actions, elle tient en ~75.

/** Une délégation en ligne, telle que la base l'a enregistrée. */
export interface InlineDelegationEntry {
  agentName: string;
  status: string;
  toolsUsed: string[];
}

/**
 * Le registre des délégations EN LIGNE d'une série de tours.
 *
 * Clé : le job PARENT. Source : les `agent_jobs` enfants (`parent_job_id`) et
 * leur propre `tools_used` — jamais la prose du parent.
 *
 * Les enfants encore en cours sont exclus : ils n'ont pas fini d'agir, et les
 * annoncer comme un fait serait prématuré. Même règle que le registre des
 * tâches au-dessus.
 */
export async function loadInlineDelegationLedger(
  db: RunnerDeps['db'],
  parentJobIds: readonly (string | null)[],
): Promise<Map<string, InlineDelegationEntry[]>> {
  const ledger = new Map<string, InlineDelegationEntry[]>();
  const ids = [...new Set(parentJobIds.filter((id): id is string => !!id))];
  if (ids.length === 0) return ledger;

  const rows = await db
    .select({
      parentJobId: agentJobs.parentJobId,
      agentName: agents.name,
      status: agentJobs.status,
      toolsUsed: agentJobs.toolsUsed,
    })
    .from(agentJobs)
    .leftJoin(agents, eq(agents.id, agentJobs.agentId))
    .where(
      and(
        inArray(agentJobs.parentJobId, ids),
        inArray(agentJobs.status, TERMINAL_JOB_STATUSES as unknown as string[]),
      ),
    )
    .orderBy(desc(agentJobs.createdAt));

  for (const row of rows) {
    if (!row.parentJobId) continue;
    const list = ledger.get(row.parentJobId) ?? [];
    if (list.length >= MAX_TASKS_PER_EXCHANGE) continue; // newest-first — borné ici
    list.push({
      agentName: row.agentName ?? 'an agent',
      // `status` est nullable en base ; un statut absent n'est pas « terminé ».
      // Le dire plutôt que de laisser croire à une réussite (invariant #4).
      status: row.status ?? 'unknown',
      toolsUsed: Array.isArray(row.toolsUsed) ? (row.toolsUsed as string[]) : [],
    });
    ledger.set(row.parentJobId, list);
  }

  for (const [key, list] of ledger) ledger.set(key, list.reverse()); // chronologique
  return ledger;
}

/**
 * `[Delegated to X (completed) — actions: file_write ×2, review_verdict]`
 *
 * `no tool used` quand l'enfant n'a rien appelé : c'est le cas le plus utile de
 * tous. Il dit noir sur blanc qu'une délégation a eu lieu et n'a rien produit,
 * là où la prose du parent peut affirmer le contraire.
 */
export function formatInlineDelegationEntry(entry: InlineDelegationEntry): string {
  const tools = formatTools(entry.toolsUsed);
  return `[Delegated to ${entry.agentName} (${entry.status}) — actions: ${tools || 'no tool used'}]`;
}

/** Format every in-line delegation of one parent job into ledger lines. */
export function formatInlineDelegationLines(entries: readonly InlineDelegationEntry[]): string[] {
  return entries.map(formatInlineDelegationEntry);
}
