// approvals/elicitation.ts — un serveur MCP pose une QUESTION à une personne
// PENDANT un de ses appels (`elicitation/create`, mode formulaire), et le run
// attend la réponse sans se suspendre.
//
// Ce module est la capacité `ToolContext.requestUserInput` que le runner donne
// à chaque appel d'outil : l'adaptateur MCP l'appelle depuis le gestionnaire
// qu'il enregistre sur sa connexion (packages/adapters/mcp).
//
// La question vit dans `approval_requests`, `kind = 'elicitation'` (0145) :
// même cloche, même page, mêmes cartes, même balayage que les approbations et
// les questions d'`ask_user`, et la livraison passe par le MÊME notifieur
// (`notifyApprovalCreated`), sans second chemin. Ce qui la distingue :
//
//   - Le job ne se suspend PAS. Le serveur garde son `tools/call` ouvert ;
//     suspendre fermerait la connexion et perdrait l'appel. Le run sonde la
//     ligne, comme la fenêtre de grâce des approbations, et relit son droit
//     d'agir à chaque passage (#566). Le heartbeat du job (#565) le garde
//     vivant pendant ce temps.
//   - La ligne naît avec `executed_at` posé : l'appel auquel elle appartient
//     est EN COURS. Aucun lecteur qui rejoue des appels approuvés ne peut donc
//     la prendre pour un appel à exécuter (ils filtrent en plus sur `kind`,
//     `gatesACall`) : une élicitation acceptée relue comme une approbation
//     ferait réexécuter l'outil MCP — une impression en double.
//   - Correspondance des statuts : `accept` ← approved, `decline` ← rejected,
//     `cancel` ← expired (délai, job arrêté ou perdu, question retirée par le
//     serveur). « Annuler » n'est jamais un clic.

import {
  and,
  eq,
  inArray,
  approvalRequests,
  approvalRequestAttachments,
  type AnyDrizzleDb,
} from '@nodal-agents/db';
import {
  parseElicitationSchema,
  validateElicitationContent,
  describeElicitationErrors,
  type ElicitationToolInput,
} from '@nodal-agents/shared';
import type { UserInputRequest, UserInputResponse } from '@nodal-agents/tools';
import type { RunnerDeps } from '../deps.ts';
import { notifyApprovalCreated } from './notify.ts';
import { settleApprovalCards } from './card-settlement.ts';

/** Délai par défaut d'une question : 10 minutes, ce que la spec du serveur suggère. */
export const DEFAULT_ELICITATION_TIMEOUT_MS = 10 * 60_000;

/** Le délai réglé (`NODALAI_ELICITATION_TIMEOUT_MS`), ou le défaut. */
export function elicitationTimeoutMs(raw: unknown): number {
  const n = Number(raw);
  return Number.isFinite(n) && n > 0 ? n : DEFAULT_ELICITATION_TIMEOUT_MS;
}

/** Pourquoi une question s'est fermée sans réponse — `approval_requests.resolved_by`. */
export const ELICITATION_CLOSED_BY = {
  timeout: 'system:timeout',
  jobLost: 'system:job_cancelled',
  serverWithdrew: 'system:server_cancelled',
  runnerRestarted: 'system:runner_restarted',
} as const;

export interface ElicitationScope {
  jobId: string;
  agentId: string;
  entityId: string;
}

export interface ElicitationWait {
  /** Le run a-t-il perdu le droit d'agir (job annulé, repris ailleurs) ? Relu à chaque passage. */
  isLost: () => Promise<boolean>;
  timeoutMs: number;
  /** Intervalle de sondage ; par défaut, au plus 1 s. */
  pollMs?: number;
}

/**
 * La capacité `requestUserInput` d'un run : poser la question, l'envoyer là où
 * la demande est née, attendre la réponse, la rendre aux mots du protocole.
 */
export function createRequestUserInput(
  deps: RunnerDeps,
  scope: ElicitationScope,
  wait: ElicitationWait,
): (req: UserInputRequest) => Promise<UserInputResponse> {
  return (req) => askDuringCall(deps, scope, wait, req);
}

async function askDuringCall(
  deps: RunnerDeps,
  scope: ElicitationScope,
  wait: ElicitationWait,
  req: UserInputRequest,
): Promise<UserInputResponse> {
  const db = deps.db as AnyDrizzleDb;
  // Un formulaire hors du sous-ensemble du protocole ne se dessine pas à
  // moitié : le serveur reçoit une ERREUR qui dit pourquoi (invariant #4), et
  // aucune ligne n'attend une réponse que personne ne pourrait donner.
  const form = parseElicitationSchema(req.requestedSchema);
  if (!form.ok) {
    console.warn(
      `[elicitation] ${req.serverSlug} asked during ${req.toolName} (job ${scope.jobId}) ` +
        `with a form that cannot be shown: ${form.reason}`,
    );
    throw new Error(`The form cannot be shown to the person: ${form.reason}`);
  }

  const toolInput: ElicitationToolInput = {
    server: req.serverSlug,
    message: req.message,
    requestedSchema: req.requestedSchema,
    // Les libellés des boutons, gardés avec la question : chaque surface
    // (web, canaux) les relit de la ligne.
    actions: req.actions,
  };
  const now = new Date();
  const expiresAt = new Date(now.getTime() + wait.timeoutMs);
  const id = await db.transaction(async (tx) => {
    const [row] = await tx
      .insert(approvalRequests)
      .values({
        entityId: scope.entityId,
        jobId: scope.jobId,
        agentId: scope.agentId,
        toolName: req.toolName,
        toolInput: toolInput as unknown as Record<string, unknown>,
        toolCallId: req.toolCallId,
        kind: 'elicitation',
        status: 'pending',
        expiresAt,
        // L'appel auquel elle appartient est en cours : jamais un appel à rejouer.
        executedAt: now,
      })
      .returning({ id: approvalRequests.id });
    if (!row) throw new Error('elicitation_insert_failed');
    if (req.attachments.length > 0) {
      await tx.insert(approvalRequestAttachments).values(
        req.attachments.map((a, position) => ({
          approvalRequestId: row.id,
          position,
          mimeType: a.mimeType,
          data: a.data,
          byteSize: a.byteSize,
          caption: a.caption,
        })),
      );
    }
    return row.id;
  });
  console.warn(
    `[elicitation] ${req.serverSlug} asks during ${req.toolName} (job ${scope.jobId}): ` +
      `request ${id}, ${req.attachments.length} image(s), expires ${expiresAt.toISOString()}`,
  );

  await notifyApprovalCreated(deps, {
    approvalRequestId: id,
    toolName: req.toolName,
    toolInput,
    jobId: scope.jobId,
    agentId: scope.agentId,
    entityId: scope.entityId,
    kind: 'elicitation',
  });

  return waitForAnswer(db, id, toolInput, expiresAt, wait, req.signal);
}

async function waitForAnswer(
  db: AnyDrizzleDb,
  id: string,
  toolInput: ElicitationToolInput,
  expiresAt: Date,
  wait: ElicitationWait,
  signal: AbortSignal,
): Promise<UserInputResponse> {
  const pollMs = wait.pollMs ?? Math.max(1, Math.min(1000, Math.floor(wait.timeoutMs / 4)));
  for (;;) {
    const [row] = await db
      .select({ status: approvalRequests.status, response: approvalRequests.response })
      .from(approvalRequests)
      .where(eq(approvalRequests.id, id))
      .limit(1);
    // La ligne a disparu avec son job (suppression en cascade) : personne ne
    // répondra plus.
    if (!row) return { action: 'cancel' };
    if (row.status === 'approved') {
      // Validée à l'écriture (approvals/resolve.ts) ; relue ici parce que c'est
      // ce que le SERVEUR va recevoir, et qu'une ligne ne se croit pas sur parole.
      const checked = validateElicitationContent(toolInput.requestedSchema, row.response);
      if (!checked.ok) {
        throw new Error(
          `elicitation ${id} was answered with content that does not fit its form: ` +
            describeElicitationErrors(checked.errors),
        );
      }
      return { action: 'accept', content: checked.content };
    }
    if (row.status === 'rejected') return { action: 'decline' };
    if (row.status !== 'pending') return { action: 'cancel' };

    // Toujours en attente : chaque raison de fermer est ÉCRITE sur la ligne
    // (la carte dit laquelle), puis relue — une réponse arrivée entre-temps
    // gagne, la fermeture conditionnelle ne l'écrase jamais.
    if (signal.aborted) {
      await closeUnanswered(db, id, ELICITATION_CLOSED_BY.serverWithdrew);
      continue;
    }
    if (await wait.isLost()) {
      await closeUnanswered(db, id, ELICITATION_CLOSED_BY.jobLost);
      continue;
    }
    if (Date.now() >= expiresAt.getTime()) {
      await closeUnanswered(db, id, ELICITATION_CLOSED_BY.timeout);
      continue;
    }
    await sleep(pollMs, signal);
  }
}

/**
 * Ferme une question restée sans réponse : `expired`, avec sa raison, puis les
 * cartes livrées sont réglées (#637). Conditionnelle sur `pending` : une
 * réponse écrite juste avant gagne.
 */
async function closeUnanswered(db: AnyDrizzleDb, id: string, resolvedBy: string): Promise<void> {
  const closed = await db
    .update(approvalRequests)
    .set({ status: 'expired', resolvedAt: new Date(), resolvedBy })
    .where(and(eq(approvalRequests.id, id), eq(approvalRequests.status, 'pending')))
    .returning({ id: approvalRequests.id });
  if (closed.length === 0) return;
  console.warn(`[elicitation] request ${id} closed without an answer (${resolvedBy})`);
  try {
    await settleApprovalCards(db, { approvalRequestIds: [id] });
  } catch (err) {
    console.error(
      `[elicitation] could not update the cards of ${id}; the next cron tick retries: ` +
        (err instanceof Error ? err.message : String(err)),
    );
  }
}

/** Attendre `ms`, ou moins si `signal` s'interrompt. */
function sleep(ms: number, signal: AbortSignal): Promise<void> {
  return new Promise((resolve) => {
    if (signal.aborted) return resolve();
    const done = () => {
      clearTimeout(timer);
      signal.removeEventListener('abort', done);
      resolve();
    };
    const timer = setTimeout(done, ms);
    signal.addEventListener('abort', done, { once: true });
  });
}

/**
 * Les questions des jobs que plus aucun runner ne tient. Une question vit tant
 * que l'appel qui l'a posée vit, et cet appel vit tant qu'un runner tient son
 * job : la connexion au serveur est morte avec le runner, personne n'attend
 * plus la réponse. Fermées avec leur raison, au lieu d'attendre leur délai
 * sous un bouton qui n'enverrait rien à personne.
 *
 * Appelée par ceux qui PROUVENT qu'un job n'a plus de runner, pour les seuls
 * jobs qu'ils reprennent : `reclaimJobsOfDeadRunners` (plus de battement,
 * #186 — au démarrage et à chaque tour de cron) et `resetOrphanedJobs`.
 * Jamais sur toutes les questions ouvertes : un autre runner vivant sur la même
 * base attend peut-être la sienne (revue Codex passe 1 de #660).
 */
export async function closeElicitationsOfLostJobs(
  db: AnyDrizzleDb,
  jobIds: readonly string[],
): Promise<number> {
  if (jobIds.length === 0) return 0;
  const closed = await db
    .update(approvalRequests)
    .set({
      status: 'expired',
      resolvedAt: new Date(),
      resolvedBy: ELICITATION_CLOSED_BY.runnerRestarted,
    })
    .where(
      and(
        eq(approvalRequests.kind, 'elicitation'),
        eq(approvalRequests.status, 'pending'),
        inArray(approvalRequests.jobId, [...jobIds]),
      ),
    )
    .returning({ id: approvalRequests.id });
  if (closed.length > 0) {
    await settleApprovalCards(db, { approvalRequestIds: closed.map((r) => r.id) });
  }
  return closed.length;
}
