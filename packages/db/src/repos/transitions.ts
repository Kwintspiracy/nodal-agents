// repos/transitions.ts — les deux transitions qu'un client doit apprendre, et
// la seule façon de les annoncer (#944, revue Reviewer A de #956, passe 1).
//
// Deux transitions comptent pour qui écoute un espace (le flux poussé du
// runner, `GET /api/events`) :
//   (a) un job atteint un statut terminal (completed, failed, cancelled) ;
//   (b) une demande (approbation, question, question d'un serveur MCP) quitte
//       `pending` : tranchée, ou expirée.
//
// Chaque écriture qui en pose une est une PORTE : elle écrit sous sa garde
// (« pas déjà terminal », « encore pending »), et annonce ce qui a ATTERRI par
// `announceTransitions`. Les portes vivent ici (`cancelJobs`,
// `expirePendingRequests`, `decidePendingRequest`) et dans le runner
// (`completeJob`, `failJob`, `cancelRootJob`, job/state.ts) ; le test
// d'architecture du runner refuse une telle écriture ailleurs.
//
// ─── Après le COMMIT, jamais avant ──────────────────────────────────────────
//
// Une annonce dit un fait de la base. Faite dans une transaction, elle attend
// son COMMIT, et disparaît avec un ROLLBACK : une transaction qui peut porter
// une porte s'ouvre par `inTransaction`, qui garde les annonces et les remet à
// l'écouteur une fois la transaction commise. Faite hors de toute
// transaction, l'écriture est déjà commise : l'annonce part tout de suite.
//
// Une annonce faite dans une transaction que `inTransaction` n'a PAS ouverte
// ne peut pas savoir quand elle sera commise. Elle ne part donc pas : elle est
// dite au journal, et l'écouteur reçoit `lost`, qui dit à chaque client de
// relire la base (invariant #4 : ni un fait que le ROLLBACK démentirait, ni un
// silence).
//
// ─── L'écouteur, un par processus ────────────────────────────────────────────
//
// Le runner, qui tient le flux, branche le sien au démarrage
// (`listenToTransitions`). Un processus qui n'en branche aucun (le web, qui
// annule encore un job par son action `cancelJobAction` — c'est #955 qui la
// fait passer par le runner) le dit une fois au journal, et ses annonces ne
// vont nulle part : aucun client ne lit ce processus.

import { and, eq, inArray } from 'drizzle-orm';
import type { SQL } from 'drizzle-orm';
import { PgTransaction } from 'drizzle-orm/pg-core';
import { LIVE_JOB_STATUSES } from '@nodal-agents/shared';
import type { AnyDrizzleDb } from '../client.ts';
import { agentJobs } from '../schema/jobs.ts';
import { approvalRequests } from '../schema/approvals.ts';

/** Ce qu'une porte a fait atterrir. */
export interface Transitions {
  /** Les jobs qui viennent d'atteindre un statut terminal. */
  endedJobIds: readonly string[];
  /** Les demandes qui viennent de quitter `pending`. */
  settledRequestIds: readonly string[];
}

export interface TransitionListener {
  /** Les transitions COMMISES. `db` est la base, hors de toute transaction. */
  committed(db: AnyDrizzleDb, t: Transitions): Promise<void>;
  /** Des transitions dont le COMMIT ne peut pas être suivi : relire la base. */
  lost(reason: string): void;
}

let listener: TransitionListener | null = null;
let saidNoListener = false;

/** Branche l'écouteur de ce processus ; rend de quoi le débrancher. */
export function listenToTransitions(l: TransitionListener): () => void {
  listener = l;
  return () => {
    if (listener === l) listener = null;
  };
}

/** Les annonces d'une transaction ouverte par `inTransaction`, en attente de son COMMIT. */
interface Pending {
  endedJobIds: string[];
  settledRequestIds: string[];
}

const pendingOf = new WeakMap<object, Pending>();

/** Une base simulée par un test peut ne pas être un objet : elle n'a alors rien en attente. */
function keyable(db: unknown): db is object {
  return (typeof db === 'object' && db !== null) || typeof db === 'function';
}

function isEmpty(t: Transitions): boolean {
  return t.endedJobIds.length === 0 && t.settledRequestIds.length === 0;
}

async function deliver(db: AnyDrizzleDb, t: Transitions): Promise<void> {
  if (isEmpty(t)) return;
  if (!listener) {
    if (!saidNoListener) {
      saidNoListener = true;
      console.warn(
        `[transitions] no listener in this process (pid ${process.pid}): the job ends and request ` +
          'settlements written here are pushed to no client',
      );
    }
    return;
  }
  await listener.committed(db, t);
}

/**
 * Une transaction qui peut porter une porte : ce qu'elle annonce n'est remis à
 * l'écouteur qu'après son COMMIT, et jamais sur un ROLLBACK.
 *
 * Ouverte DANS une transaction déjà ouverte par `inTransaction`, elle devient
 * un point de sauvegarde, et ses annonces rejoignent celles de la transaction
 * d'en dessous — qui seule décide du COMMIT. Ouverte dans une transaction que
 * personne n'a ouverte ainsi, elle ne peut pas suivre le COMMIT : ses annonces
 * sont dites perdues (voir l'en-tête).
 */
export async function inTransaction<T>(
  db: AnyDrizzleDb,
  work: (tx: AnyDrizzleDb) => Promise<T>,
): Promise<T> {
  const outer = keyable(db) ? pendingOf.get(db) : undefined;
  const mine: Pending = { endedJobIds: [], settledRequestIds: [] };
  const result = await db.transaction(async (tx) => {
    const handle: unknown = tx;
    if (keyable(handle)) pendingOf.set(handle, mine);
    try {
      return await work(tx as unknown as AnyDrizzleDb);
    } finally {
      if (keyable(handle)) pendingOf.delete(handle);
    }
  });
  if (outer) {
    // Un point de sauvegarde relâché : rien n'est encore commis.
    outer.endedJobIds.push(...mine.endedJobIds);
    outer.settledRequestIds.push(...mine.settledRequestIds);
    return result;
  }
  if (db instanceof PgTransaction) {
    unfollowable(mine);
    return result;
  }
  await deliver(db, mine);
  return result;
}

function unfollowable(t: Transitions): void {
  if (isEmpty(t)) return;
  const what =
    `${t.endedJobIds.length} job end(s) [${t.endedJobIds.join(', ')}] and ` +
    `${t.settledRequestIds.length} request settlement(s) [${t.settledRequestIds.join(', ')}]`;
  console.error(
    `[transitions] ${what} were written inside a transaction not opened by inTransaction: ` +
      'their COMMIT cannot be followed, every client is told to re-read',
  );
  listener?.lost('transaction_not_followed');
}

/**
 * Ce qu'une porte vient de faire atterrir. Appelée par la porte, avec la `db`
 * sur laquelle elle a écrit, et seulement pour les lignes que SA garde a
 * laissées passer.
 */
export async function announceTransitions(
  db: AnyDrizzleDb,
  t: Partial<Transitions>,
): Promise<void> {
  const ended = [...(t.endedJobIds ?? [])];
  const settled = [...(t.settledRequestIds ?? [])];
  if (ended.length === 0 && settled.length === 0) return;
  const pending = keyable(db) ? pendingOf.get(db) : undefined;
  if (pending) {
    pending.endedJobIds.push(...ended);
    pending.settledRequestIds.push(...settled);
    return;
  }
  if (db instanceof PgTransaction) {
    unfollowable({ endedJobIds: ended, settledRequestIds: settled });
    return;
  }
  await deliver(db, { endedJobIds: ended, settledRequestIds: settled });
}

// ─── Les portes de ce paquet ─────────────────────────────────────────────────

/**
 * PORTE (a) — annuler des jobs encore vivants : l'arrêt d'un arbre
 * (`cancelJobTree`), la cascade d'un enfant annulé vers le parent qui
 * l'attendait, l'enfant d'une délégation qui n'a plus de parent, le job né
 * pendant un Stop. `onlyFrom` resserre la garde (par défaut : les statuts
 * vivants) ; seules les lignes qu'elle laisse passer changent, et elles seules
 * sont annoncées. Rend leurs identifiants.
 */
export async function cancelJobs(
  db: AnyDrizzleDb,
  input: {
    ids: readonly string[];
    /** Borne chaque écriture à cet espace, quand l'appelant le connaît. */
    entityId?: string;
    onlyFrom?: readonly string[];
    now?: Date;
  },
): Promise<string[]> {
  if (input.ids.length === 0) return [];
  const rows = await db
    .update(agentJobs)
    .set({ status: 'cancelled', updatedAt: input.now ?? new Date() })
    .where(
      and(
        inArray(agentJobs.id, [...input.ids]),
        ...(input.entityId !== undefined ? [eq(agentJobs.entityId, input.entityId)] : []),
        inArray(agentJobs.status, [...(input.onlyFrom ?? LIVE_JOB_STATUSES)]),
      ),
    )
    .returning({ id: agentJobs.id });
  const ids = rows.map((r) => r.id);
  await announceTransitions(db, { endedJobIds: ids });
  return ids;
}

/**
 * PORTE (b) — expirer des demandes encore `pending` : l'arrêt d'un arbre,
 * l'échéance, la question d'un serveur MCP restée sans réponse ou dont le job
 * n'a plus de runner. `where` dit lesquelles ; la garde `pending` est posée
 * ici, toujours. Rend les lignes qui ont changé.
 */
export async function expirePendingRequests(
  db: AnyDrizzleDb,
  input: { where: SQL | undefined; resolvedBy: string; now?: Date },
): Promise<Array<{ id: string; jobId: string; kind: string }>> {
  const rows = await db
    .update(approvalRequests)
    .set({ status: 'expired', resolvedAt: input.now ?? new Date(), resolvedBy: input.resolvedBy })
    .where(and(eq(approvalRequests.status, 'pending'), input.where))
    .returning({
      id: approvalRequests.id,
      jobId: approvalRequests.jobId,
      kind: approvalRequests.kind,
    });
  await announceTransitions(db, { settledRequestIds: rows.map((r) => r.id) });
  return rows;
}

/**
 * PORTE (b) — trancher UNE demande encore `pending` : approuvée ou refusée,
 * avec ce que la personne a écrit. `extraWhere` ajoute les gardes de
 * l'appelant (le brouillon attendu d'une élicitation). Rend vrai si CETTE
 * écriture a tranché — un concurrent arrivé avant gagne, et rien n'est annoncé.
 */
export async function decidePendingRequest(
  db: AnyDrizzleDb,
  input: {
    id: string;
    status: 'approved' | 'rejected';
    resolvedBy: string;
    notes: string | null;
    answer: string | null;
    response: Record<string, unknown> | null;
    extraWhere?: readonly SQL[];
  },
): Promise<boolean> {
  const rows = await db
    .update(approvalRequests)
    .set({
      status: input.status,
      resolvedAt: new Date(),
      resolvedBy: input.resolvedBy,
      notes: input.notes,
      answer: input.answer,
      response: input.response,
    })
    .where(
      and(
        eq(approvalRequests.id, input.id),
        eq(approvalRequests.status, 'pending'),
        ...(input.extraWhere ?? []),
      ),
    )
    .returning({ id: approvalRequests.id });
  await announceTransitions(db, { settledRequestIds: rows.map((r) => r.id) });
  return rows.length > 0;
}
