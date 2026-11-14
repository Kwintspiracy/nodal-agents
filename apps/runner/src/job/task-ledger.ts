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
// This is the delegation-boundary extension of the runner's record of an
// exchange (exchange-record.ts, #1075): that record covers a job's OWN tools;
// this one covers the tools of jobs it DELEGATED to via create_task,
// keyed by `agent_tasks.root_job_id` — the exact link create_task stamps
// (task-tools.ts: `rootJobId: ctx.jobId`) and execute-ready.ts resolves to a
// child `agent_jobs` row (`agent_tasks.job_id`).
//
// Scope: only TERMINAL tasks (done/blocked) — a still-running task hasn't
// finished acting yet, so surfacing it as a ledger fact would be premature.
// `cancelled` tasks are also excluded: nothing happened to report.

import { eq, ne, and, inArray, desc } from '@nodal-agents/db';
import { agentTasks, agentJobs, agents } from '@nodal-agents/db';
import type { RunnerDeps } from '../deps.ts';
import { jobActs, recordField, toolNames, NAME_MAX_CHARS, type JobActs } from './tool-acts.ts';

/** Max ledger entries surfaced per root job — keeps a busy fan-out bounded. */
export const MAX_TASKS_PER_EXCHANGE = 3;

/** Task result/error text is truncated to this many chars in the ledger line. */
const RESULT_TRUNCATE_CHARS = 200;

/** A task's title in the ledger line, at most (#1075: every stored text has its bound). */
const TITLE_MAX_CHARS = 120;

/** A child job's status in the ledger line, at most. */
const STATUS_MAX_CHARS = 32;

const TERMINAL_TASK_STATUSES = ['done', 'blocked'] as const;

/** Statuts d'un job enfant qui a fini d'agir — même intention que ci-dessus. */
const TERMINAL_JOB_STATUSES = ['completed', 'failed'] as const;

/** Le canal des jobs que pose `create_task` (execute-ready.ts). */
const TASK_BOARD_CHANNEL = 'task-board';

/** A delegated task, and what its OWN child job did with its tools (#1075). */
export interface TaskLedgerEntry extends JobActs {
  /** The child job that ran the task: the declarations of its calls are read on it. */
  jobId: string | null;
  title: string;
  status: 'done' | 'blocked';
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
      childJobId: agentJobs.id,
      toolsUsed: agentJobs.toolsUsed,
      childTask: agentJobs.task,
      childMessages: agentJobs.messages,
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
      jobId: row.childJobId,
      title: row.title,
      status: row.status as 'done' | 'blocked',
      ...jobActs({ task: row.childTask, messages: row.childMessages, toolsUsed: row.toolsUsed }),
      result: row.result,
    });
    ledger.set(row.rootJobId, list);
  }

  for (const [key, list] of ledger) {
    ledger.set(key, list.reverse()); // newest-first -> chronological within the kept window
  }

  return ledger;
}

function truncateResult(s: string | null): string {
  const text = recordField(s ?? '', RESULT_TRUNCATE_CHARS);
  return text === '' ? '(no result)' : text;
}

/**
 * Render one ledger entry as the structural `[Task "…" …]` line injected into
 * conversational history — the real tool calls a delegated task made, pulled
 * from its OWN child job's `tools_used`, never from the creating job's prose.
 */
export function formatTaskLedgerEntry(entry: TaskLedgerEntry): string {
  const toolsStr = toolNames(entry);
  const actionsPart = toolsStr ? `actions — ${toolsStr}; ` : '';
  const title = recordField(entry.title, TITLE_MAX_CHARS);
  return entry.status === 'blocked'
    ? `[Task "${title}" failed: ${actionsPart}error: ${truncateResult(entry.result)}]`
    : `[Task "${title}" completed: ${actionsPart}result: ${truncateResult(entry.result)}]`;
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
//   * celui de `thread-history` ne se déclenchait alors que sur une liste de
//     21 noms (STATE_CHANGING_TOOLS, retirée par #1075), où les outils de
//     délégation ne pouvaient pas figurer — ils s'appellent `assign_<slug>`,
//     et écrire un slug d'agent dans le runtime est exactement ce que
//     l'invariant #1 interdit ;
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
// aux actions, elle tient en ~75. Depuis #1075, les appels de l'enfant qui
// AGISSENT sont cités sous la ligne, comme ceux du job de tête et sous la même
// borne (exchange-record.ts) : le début de ce que l'outil a rendu, pas le
// compte rendu entier.

/** Une délégation en ligne, telle que la base l'a enregistrée. */
export interface InlineDelegationEntry extends JobActs {
  /** The child job: the declarations of its calls are read on it. */
  jobId: string | null;
  agentName: string;
  status: string;
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
 *
 * Le canal `task-board` est exclu, lui, pour une autre raison : `create_task`
 * pose SON enfant avec le même `parent_job_id` (execute-ready.ts:207,
 * `parentJobId: task.rootJobId`). Sans ce filtre, un enfant du tableau de
 * tâches serait rendu deux fois — une par `loadTaskLedger`, une ici — et
 * mangerait deux fois le budget d'historique pour la même action.
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
      jobId: agentJobs.id,
      agentName: agents.name,
      status: agentJobs.status,
      toolsUsed: agentJobs.toolsUsed,
      task: agentJobs.task,
      messages: agentJobs.messages,
    })
    .from(agentJobs)
    .leftJoin(agents, eq(agents.id, agentJobs.agentId))
    .where(
      and(
        inArray(agentJobs.parentJobId, ids),
        inArray(agentJobs.status, TERMINAL_JOB_STATUSES as unknown as string[]),
        ne(agentJobs.channel, TASK_BOARD_CHANNEL),
      ),
    )
    .orderBy(desc(agentJobs.createdAt));

  for (const row of rows) {
    if (!row.parentJobId) continue;
    const list = ledger.get(row.parentJobId) ?? [];
    if (list.length >= MAX_TASKS_PER_EXCHANGE) continue; // newest-first — borné ici
    list.push({
      jobId: row.jobId,
      agentName: row.agentName ?? 'an agent',
      // `status` est nullable en base ; un statut absent n'est pas « terminé ».
      // Le dire plutôt que de laisser croire à une réussite (invariant #4).
      status: row.status ?? 'unknown',
      ...jobActs(row),
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
  const tools = toolNames(entry);
  const agent = recordField(entry.agentName, NAME_MAX_CHARS);
  const status = recordField(entry.status, STATUS_MAX_CHARS);
  return `[Delegated to ${agent} (${status}) — actions: ${tools || 'no tool used'}]`;
}
