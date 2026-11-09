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
// Ce bus vit dans le processus du runner, et il voit ce que ce processus
// écrit : les fins de job et les demandes tranchées passent par des PORTES qui
// les annoncent (packages/db/src/repos/transitions.ts), et le test
// d'architecture du runner refuse une telle écriture hors d'une porte. Ce
// qu'un AUTRE processus écrit en base ne passe pas par ici : ces écrivains-là
// sont nommés, un par un, dans `OUT_OF_PROCESS_WRITERS` du même test (le
// bouton Stop du tableau de bord, que #955 fait passer par le runner ; le banc
// d'essai).
//
// ─── Les appareils (#945) ────────────────────────────────────────────────────
//
// Un appareil écoute le MÊME bus, sur son propre flux
// (`GET /api/devices/:deviceId/events`). Chaque événement porte, en plus de
// sa conversation, l'APPAREIL d'où vient la demande de son job
// (`StoredJobEvent.deviceId` : le chat du job, quand il a été résolu sur le
// canal `device`). Un auditeur d'appareil n'entend que ce qui vient de SES
// demandes, plus ce qui lui est adressé (`device.event`, posé par l'adaptateur
// `device` : une carte, une bulle, une carte fermée) ; un tel événement adressé
// n'atteint jamais un autre auditeur. L'isolement des espaces ne change pas :
// l'appareil est inscrit dans l'espace de sa ligne, et un événement n'est rangé
// que dans l'espace de son job.

import { randomBytes } from 'node:crypto';
import type { DeviceEvent } from '@nodal-agents/shared';

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
      /**
       * Un job lancé par la voix a fini : son ANNONCE est dite (#967). Publié
       * juste après son `job.finished`, et seulement quand quelqu'un écoute.
       * Un pointeur, pas l'audio : la voix se lit sur
       * `GET /api/voice/replies/:audioId` (routes/voice-reply.ts). Un onglet
       * qui ne la joue pas ne reçoit pas un octet de voix.
       */
      type: 'reply.audio';
      jobId: string;
      conversationId: string | null;
      audioId: string;
    }
  | {
      /**
       * Un geste ADRESSÉ à un appareil (#945) par l'adaptateur `device` : une
       * carte, une bulle, une carte fermée, déjà dans la forme du protocole.
       * N'atteint que l'auditeur de cet appareil (`reaches`).
       */
      type: 'device.event';
      event: DeviceEvent;
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
  /**
   * L'appareil d'où vient la demande du job de cet événement, ou à qui il est
   * adressé (#945) ; null : ni l'un ni l'autre.
   */
  deviceId: string | null;
  payload: JobEventPayload;
}

/** Comment s'ouvre un abonnement : ce qu'il faut envoyer avant le direct. */
export type JobEventOpening =
  | { kind: 'fresh'; headId: string }
  | { kind: 'replay'; headId: string; events: StoredJobEvent[] }
  | { kind: 'resync'; headId: string; reason: ResyncReason };

interface Subscriber {
  conversationId: string | null;
  /** L'appareil qui écoute (#945), ou null pour un client de l'espace. */
  deviceId: string | null;
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
    deviceId: string | null = null,
  ): StoredJobEvent {
    const ws = this.workspace(entityId);
    ws.seq += 1;
    const event: StoredJobEvent = {
      id: this.idOf(ws.seq),
      seq: ws.seq,
      conversationId,
      deviceId,
      payload,
    };
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
    deviceId: string | null = null,
  ): { opening: JobEventOpening; close: () => void } {
    const ws = this.workspace(entityId);
    const opening = this.openingFor(ws, { conversationId, deviceId }, lastEventId);
    const sub: Subscriber = { conversationId, deviceId, send };
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
    sub: Pick<Subscriber, 'conversationId' | 'deviceId'>,
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

  /**
   * Combien d'auditeurs un événement de job de cette conversation (et de cet
   * appareil d'origine) atteindrait à cet instant — la règle de la
   * publication (`reaches`), appliquée à un tel événement.
   */
  listenersOf(
    entityId: string,
    conversationId: string | null,
    deviceId: string | null = null,
  ): number {
    const probe: Pick<StoredJobEvent, 'conversationId' | 'deviceId' | 'payload'> = {
      conversationId,
      deviceId,
      payload: { type: 'reply.audio', jobId: '', conversationId, audioId: '' },
    };
    let n = 0;
    for (const sub of this.workspaces.get(entityId)?.subscribers ?? []) {
      if (reaches(sub, probe)) n++;
    }
    return n;
  }
}

/**
 * Qui entend quoi. Un `resync` va à tous. Un auditeur d'APPAREIL n'entend que
 * ce qui vient de ses demandes et ce qui lui est adressé ; un geste adressé à
 * un appareil n'atteint que lui. Un auditeur d'une conversation ne reçoit que
 * la sienne ; un auditeur de tout l'espace, tout le reste.
 */
function reaches(
  sub: Pick<Subscriber, 'conversationId' | 'deviceId'>,
  event: Pick<StoredJobEvent, 'conversationId' | 'deviceId' | 'payload'>,
): boolean {
  if (event.payload.type === 'resync') return true;
  if (sub.deviceId !== null) return event.deviceId === sub.deviceId;
  if (event.payload.type === 'device.event') return false;
  if (sub.conversationId === null) return true;
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
