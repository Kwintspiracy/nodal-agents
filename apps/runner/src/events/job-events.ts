// events/job-events.ts — le flux POUSSÉ des événements de job (#944).
//
// Le runner ne poussait rien : un job qui finit, une question posée, une
// approbation demandée, rien ne sortait. Le tableau de bord relisait la base
// toutes les quelques secondes, et un client externe (une voix, un compagnon de
// bureau, un petit appareil) n'avait que ce moyen-là pour apprendre que « la
// tâche est finie » ou qu'« une question attend ».
//
// Ce module est le BUS : les portes où l'état change vraiment (`publish.ts`) y
// déposent un événement, et la route `GET /api/events` le pousse à qui écoute.
//
// ─── Pourquoi un bus en mémoire, et pas une relecture de la base ─────────────
//
// La base reste la vérité, et ce bus n'en est pas une seconde : il dit QUAND
// relire, et porte de quoi agir sans relire (la réponse d'un job, le texte
// d'une question). Ce qu'il promet à un client qui revient, c'est l'un des
// deux, jamais rien :
//   - le dernier identifiant vu est encore dans la mémoire de CE runner :
//     le client reçoit ce qu'il a manqué, dans l'ordre ;
//   - sinon (runner redémarré, mémoire dépassée, identifiant illisible) : un
//     événement `resync` lui dit de relire la base (invariant #4).
// Un identifiant `<boot>:<n>` dit les deux choses à la fois : de quel runner il
// vient, et où il en était. Une relecture dérivée des lignes (`completed_at`,
// `resolved_at`) aurait eu besoin d'un ordre total que les horloges ne donnent
// pas : deux écritures dans la même milliseconde, ou un événement publié après
// un autre plus récent, et un client manquait un événement EN SILENCE. Le
// `resync` est honnête là où cette relecture aurait deviné.
//
// ─── L'isolement des espaces ─────────────────────────────────────────────────
//
// Chaque espace (entité) a SON compteur, SA mémoire et SES auditeurs. Un
// événement n'est jamais rangé ailleurs que dans l'espace de son job, et un
// auditeur n'est jamais inscrit ailleurs que dans le sien : il n'existe aucun
// chemin par lequel un client de l'espace A lirait un événement de B, ni même
// le nombre d'événements de B (un compteur commun l'aurait laissé deviner).
//
// Ce bus vit dans le processus du runner : il voit ce que CE runner écrit. Les
// jobs d'une installation tournent dans son runner (`/api/worker` est appelé
// sur lui-même) ; ce qu'un AUTRE processus écrit en base (l'annulation par
// l'action du tableau de bord) ne passe pas par ici — c'est la suite de #944,
// qui fait passer ces gestes par une route du runner.

import { randomBytes } from 'node:crypto';

/** Ce que demande une ligne `approval_requests` (colonne `kind`). */
export type ApprovalRequestKind = 'approval' | 'question' | 'elicitation';

/**
 * Les événements, chacun avec les identifiants et le minimum pour AGIR sans
 * relire. Le texte d'un agent ou d'un serveur est CITÉ tel qu'il est en base
 * (masqué de ses secrets), jamais composé ici (invariant #2).
 */
export type JobEventPayload =
  | {
      type: 'job.finished';
      jobId: string;
      conversationId: string | null;
      /** null : un job de tête, celui dont la réponse est la réponse à la demande. */
      parentJobId: string | null;
      status: 'completed' | 'cancelled';
      /** `agent_jobs.result` : la réponse finale, de quoi la dire sans seconde lecture. */
      reply: string;
    }
  | {
      type: 'job.failed';
      jobId: string;
      conversationId: string | null;
      parentJobId: string | null;
      /** `agent_jobs.error` : le code. */
      error: string;
      /** La première ligne de `agent_jobs.result`, l'explication que la porte d'échec garantit. */
      reason: string;
    }
  | {
      type: 'approval.requested';
      approvalId: string;
      jobId: string;
      conversationId: string | null;
      kind: 'approval';
      toolName: string;
      /** La raison que l'agent a écrite (`purpose`). */
      text: string;
    }
  | {
      type: 'question.asked';
      approvalId: string;
      jobId: string;
      conversationId: string | null;
      /** `question` : l'agent (`ask_user`) ; `elicitation` : un serveur MCP. */
      kind: 'question' | 'elicitation';
      /** La question, telle que l'agent ou le serveur l'a écrite. */
      text: string;
      /** Les options d'une question d'agent ; vide pour un serveur MCP (son formulaire est sur la ligne). */
      options: string[];
    }
  | {
      type: 'approval.resolved';
      approvalId: string;
      jobId: string;
      conversationId: string | null;
      kind: ApprovalRequestKind;
      /** `approved` | `rejected` | `expired`, tel que la ligne le porte. */
      status: string;
    }
  | {
      type: 'resync';
      /** Un code : pourquoi le client doit relire la base. */
      reason: ResyncReason;
    };

export type ResyncReason =
  /** L'identifiant ne se lit pas, ou désigne un événement qui n'a pas existé. */
  | 'unknown_cursor'
  /** L'identifiant vient d'un runner qui n'est plus celui-ci : sa mémoire est partie avec lui. */
  | 'runner_restarted'
  /** Ce que le client a manqué est sorti de la mémoire de ce runner. */
  | 'cursor_too_old'
  /** Un événement n'a pas pu être construit (lecture en échec) : son espace est inconnu. */
  | 'event_lost';

export interface StoredJobEvent {
  /** `<boot>:<n>` — ce que le client renvoie en `Last-Event-ID`. */
  id: string;
  seq: number;
  conversationId: string | null;
  payload: JobEventPayload;
}

/** Comment s'ouvre un abonnement : ce qu'il faut envoyer avant le direct. */
export type JobEventOpening =
  | { kind: 'fresh'; headId: string }
  | { kind: 'replay'; headId: string; events: StoredJobEvent[] }
  | { kind: 'resync'; headId: string; reason: ResyncReason };

interface Subscriber {
  conversationId: string | null;
  send: (event: StoredJobEvent) => void;
}

interface Workspace {
  seq: number;
  /** Les derniers événements, du plus ancien au plus récent ; au plus `capacity`. */
  buffer: StoredJobEvent[];
  subscribers: Set<Subscriber>;
}

/** Ce qu'un espace garde en mémoire pour qui revient. */
export const JOB_EVENT_BUFFER_PER_WORKSPACE = 500;

export class JobEventBus {
  readonly bootId: string;
  private readonly capacity: number;
  private readonly workspaces = new Map<string, Workspace>();

  constructor(opts: { capacity?: number; bootId?: string } = {}) {
    this.capacity = opts.capacity ?? JOB_EVENT_BUFFER_PER_WORKSPACE;
    this.bootId = opts.bootId ?? randomBytes(6).toString('hex');
  }

  private workspace(entityId: string): Workspace {
    let ws = this.workspaces.get(entityId);
    if (!ws) {
      ws = { seq: 0, buffer: [], subscribers: new Set() };
      this.workspaces.set(entityId, ws);
    }
    return ws;
  }

  private idOf(seq: number): string {
    return `${this.bootId}:${seq}`;
  }

  /** L'identifiant du dernier événement de cet espace (`<boot>:0` s'il n'y en a aucun). */
  headId(entityId: string): string {
    return this.idOf(this.workspaces.get(entityId)?.seq ?? 0);
  }

  /**
   * Range un événement dans l'espace de son job et le pousse à ses auditeurs.
   * Un auditeur qui lève (lecteur parti) ne casse ni la publication ni les autres.
   */
  publish(
    entityId: string,
    conversationId: string | null,
    payload: JobEventPayload,
  ): StoredJobEvent {
    const ws = this.workspace(entityId);
    ws.seq += 1;
    const event: StoredJobEvent = { id: this.idOf(ws.seq), seq: ws.seq, conversationId, payload };
    ws.buffer.push(event);
    if (ws.buffer.length > this.capacity) ws.buffer.splice(0, ws.buffer.length - this.capacity);
    for (const sub of ws.subscribers) {
      if (!reaches(sub, event)) continue;
      try {
        sub.send(event);
      } catch {
        // Le lecteur est parti ; la route le désinscrit elle-même.
      }
    }
    return event;
  }

  /**
   * Un événement qu'on n'a pas pu construire, et dont on ne sait donc pas
   * l'espace : CHAQUE espace connu reçoit un `resync`. Un client qui le
   * reçoit relit la base ; un client qui revient après reçoit le même
   * `resync` en relisant la mémoire. Jamais rien (invariant #4).
   */
  resyncEverywhere(reason: ResyncReason): void {
    for (const entityId of this.workspaces.keys()) {
      this.publish(entityId, null, { type: 'resync', reason });
    }
  }

  /**
   * Ouvre un abonnement, ATOMIQUEMENT : la reprise est calculée et l'auditeur
   * inscrit dans le même tour de boucle, si bien qu'aucun événement ne peut
   * tomber entre les deux.
   *
   * `lastEventId` absent : un abonnement neuf, rien à rejouer ; `headId` donne
   * au client un point de reprise dès la première seconde.
   */
  open(
    entityId: string,
    conversationId: string | null,
    lastEventId: string | null,
    send: (event: StoredJobEvent) => void,
  ): { opening: JobEventOpening; close: () => void } {
    const ws = this.workspace(entityId);
    const opening = this.openingFor(ws, conversationId, lastEventId);
    const sub: Subscriber = { conversationId, send };
    ws.subscribers.add(sub);
    return {
      opening,
      close: () => {
        ws.subscribers.delete(sub);
      },
    };
  }

  private openingFor(
    ws: Workspace,
    conversationId: string | null,
    lastEventId: string | null,
  ): JobEventOpening {
    const headId = this.idOf(ws.seq);
    if (lastEventId === null) return { kind: 'fresh', headId };
    const cursor = parseCursor(lastEventId);
    if (!cursor) return { kind: 'resync', headId, reason: 'unknown_cursor' };
    if (cursor.bootId !== this.bootId)
      return { kind: 'resync', headId, reason: 'runner_restarted' };
    if (cursor.seq > ws.seq) return { kind: 'resync', headId, reason: 'unknown_cursor' };
    // Le plus ancien événement encore en mémoire ; tout ce qui suit le curseur
    // doit y être, sinon une partie de ce qu'il a manqué est perdue.
    const oldest = ws.buffer[0]?.seq ?? ws.seq + 1;
    if (cursor.seq < oldest - 1) return { kind: 'resync', headId, reason: 'cursor_too_old' };
    const sub = { conversationId };
    const missed = ws.buffer.filter((e) => e.seq > cursor.seq && reaches(sub, e));
    // Un `resync` manqué reste un `resync` : relire la base, pas rejouer autour.
    const lost = missed.find((e) => e.payload.type === 'resync');
    if (lost && lost.payload.type === 'resync') {
      return { kind: 'resync', headId, reason: lost.payload.reason };
    }
    return { kind: 'replay', headId, events: missed };
  }

  /** Le nombre d'auditeurs de cet espace (pour les tests et le diagnostic). */
  subscriberCount(entityId: string): number {
    return this.workspaces.get(entityId)?.subscribers.size ?? 0;
  }
}

/** Un auditeur d'une conversation ne reçoit que la sienne ; un `resync` va à tous. */
function reaches(sub: Pick<Subscriber, 'conversationId'>, event: StoredJobEvent): boolean {
  if (sub.conversationId === null) return true;
  if (event.payload.type === 'resync') return true;
  return event.conversationId === sub.conversationId;
}

function parseCursor(raw: string): { bootId: string; seq: number } | null {
  const cut = raw.lastIndexOf(':');
  if (cut <= 0) return null;
  const seqText = raw.slice(cut + 1);
  if (!/^\d+$/.test(seqText)) return null;
  return { bootId: raw.slice(0, cut), seq: Number(seqText) };
}

/** LE bus de ce runner. */
export const jobEvents = new JobEventBus();
