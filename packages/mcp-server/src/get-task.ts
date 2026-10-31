// get-task.ts — relire un job que `run_task` a créé, et attendre sa fin (#887).
//
// Un client MCP qui appelait `run_task` repartait avec un id de job dont il ne
// pouvait rien faire : la réponse, un verdict, une question posée en cours de
// route n'étaient lisibles que sur le tableau de bord, ou en base. Ce module
// rend ce que l'appelant attendait, sous la MÊME règle d'autorité que
// `run_task` (server.ts) : l'espace est celui de l'agent du serveur, lu en
// base, jamais fourni par l'appelant, et seuls les jobs du canal `mcp` se
// lisent. Il n'écrit rien et ne compte pas dans le plafond de jobs en cours
// (#498) : relire ne lance rien.
//
// L'attente est bornée (GET_TASK_MAX_WAIT_SECONDS), comme `events_wait` chez
// Hermes (mcp_serve.py:584) : elle relit l'état à intervalle fixe, sans
// transaction ni verrou tenus entre deux lectures — la connexion retourne au
// pool à chaque fois — et s'arrête dès que le client annule.

import { agentJobs, and, eq, readRunState } from '@nodal-agents/db';
import type { AnyDrizzleDb, RunState } from '@nodal-agents/db';

/** L'intervalle entre deux lectures d'une attente. */
export const GET_TASK_POLL_MS = 1_000;

/**
 * Le refus d'un id qui n'est pas lisible ici. UN SEUL message, que l'id
 * n'existe pas, soit d'un autre espace, ou d'un autre canal : un message qui
 * les distinguerait servirait à sonder les ids des autres espaces.
 */
export function jobNotFound(jobId: string): Error {
  return new Error(
    `mcp_job_not_found: no job with id ${jobId} was created by this MCP server's workspace.`,
  );
}

/**
 * L'état du run, ou null quand le job n'est pas un job `mcp` de cet espace.
 * Le filtre est posé sur la TÊTE, avant toute lecture de l'arbre.
 */
export async function readMcpRun(
  db: AnyDrizzleDb,
  entityId: string,
  jobId: string,
): Promise<RunState | null> {
  const [own] = await db
    .select({ id: agentJobs.id })
    .from(agentJobs)
    .where(
      and(eq(agentJobs.id, jobId), eq(agentJobs.entityId, entityId), eq(agentJobs.channel, 'mcp')),
    )
    .limit(1);
  if (!own) return null;
  return readRunState(db, entityId, jobId);
}

/** Un run qui n'attend plus que lui-même : fini, ou arrêté sur une personne. */
export function isSettled(state: RunState): boolean {
  return state.status !== 'running';
}

/** Une pause qui finit tôt quand le signal est levé. */
function pause(ms: number, signal: AbortSignal | undefined): Promise<void> {
  return new Promise((resolve) => {
    if (signal?.aborted) return resolve();
    const done = () => {
      clearTimeout(timer);
      signal?.removeEventListener('abort', done);
      resolve();
    };
    const timer = setTimeout(done, ms);
    signal?.addEventListener('abort', done, { once: true });
  });
}

/**
 * Lit `read()` jusqu'à ce que le run soit réglé, que `waitMs` soit écoulé, ou
 * que `signal` soit levé, et rend la DERNIÈRE lecture. `waitMs = 0` : une
 * seule lecture. Une lecture qui échoue fait échouer l'attente (invariant #4).
 */
export async function waitForRun<T>(
  read: () => Promise<T>,
  settled: (state: T) => boolean,
  opts: { waitMs: number; pollMs: number; signal?: AbortSignal; now?: () => number },
): Promise<T> {
  const now = opts.now ?? Date.now;
  const deadline = now() + opts.waitMs;
  for (;;) {
    const state = await read();
    const left = deadline - now();
    if (settled(state) || opts.signal?.aborted || left <= 0) return state;
    await pause(Math.min(opts.pollMs, left), opts.signal);
  }
}

/**
 * Ce que le client reçoit : des données, jamais une phrase du runner
 * (invariant #2). `result` et `error` sont ceux de la ligne de tête, tels
 * qu'écrits par l'agent ; `waitingForPerson` cite la demande telle que l'outil
 * ou le serveur MCP l'a posée.
 */
export function getTaskReply(jobId: string, state: RunState) {
  return {
    jobId,
    status: state.status,
    jobStatus: state.headStatus,
    result: state.result,
    error: state.error,
    liveJobs: state.liveJobIds.length,
    deliverables: state.deliverables,
    waitingForPerson: state.pendingRequests.map((r) => ({
      requestId: r.requestId,
      jobId: r.jobId,
      kind: r.kind,
      toolName: r.toolName,
      about: r.toolInput,
      requestedAt: r.requestedAt,
      answerOn: 'dashboard' as const,
    })),
  };
}
