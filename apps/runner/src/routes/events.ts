// routes/events.ts — GET /api/events — le flux poussé des événements de job (#944).
//
// Un client écoute UN espace, éventuellement restreint à UNE conversation, et
// reçoit ce qui s'y passe au moment où la base le dit : un job fini (avec sa
// réponse), un job en échec, une question posée, une approbation demandée,
// une demande tranchée. Le bus, ce qu'il garde et pourquoi : `events/job-events.ts`.
//
// UNE route pour tous les clients (règle de #948) : le tableau de bord la lit
// par son proxy (`apps/web/src/app/api/events/route.ts`), un module externe la
// lit directement, avec le même protocole et la même garde. Rien ici ne sait
// qui écoute.
//
// Requête :
//   GET /api/events?entityId=<uuid>[&conversationId=<uuid>]
//   Last-Event-ID: <id>     (ou `?lastEventId=<id>` pour un client qui ne pose
//                            pas d'en-tête à sa première connexion)
//
// Réponses :
//   400  requête illisible            403  l'espace n'est pas celui de l'appelant
//   404  conversation hors de l'espace
//   200  text/event-stream, chaque événement avec son `id:` :
//        event: ready     data: {}                       en direct (après ce qui a été rejoué)
//        event: resync    data: { "reason": "<code>" }   relire la base : ce qui a été
//                                                        manqué n'est plus en mémoire
//        event: job.finished | job.failed | question.asked | approval.requested |
//               approval.resolved                        data: voir `JobEventPayload`
//        event: reply.audio   data: { jobId, conversationId, audioId }   juste après
//                             le `job.finished` d'un job lancé par la voix : son
//                             annonce est dite, sur `GET /api/voice/replies/:audioId`
//                             (#967, le protocole est dans routes/voice-reply.ts)
//   Un commentaire `: ping` toutes les 25 s tient la connexion ouverte à
//   travers les proxys.
//
// Ce qu'un client qui revient reçoit (invariant #4) : ce qu'il a manqué, dans
// l'ordre, ou un `resync`. Jamais rien en silence. `ready` et `resync` portent
// un `id:` : le client a un point de reprise avant même le premier événement.
//
// La garde : `requireRunnerAuth` (server.ts), comme `/api/chat*`. Un appelant
// de confiance (local-trust, WORKER_SECRET) a résolu l'espace lui-même ; un
// porteur de session ne lit que le SIEN.
//
// Le flux d'un APPAREIL (#945, `GET /api/devices/:deviceId/events`,
// routes/devices.ts) est ce même flux, ouvert par `streamJobEvents` : même
// bus, mêmes identifiants de reprise, même battement. Seuls changent qui est
// inscrit (l'appareil) et la forme des événements (les gestes du protocole).

import type { Context } from 'hono';
import { z } from 'zod';
import { and, eq, conversations } from '@nodal-agents/db';
import type { RunnerDeps } from '../deps.ts';
import { jobEvents, type JobEventBus, type StoredJobEvent } from '../events/job-events.ts';
import { sseEvent, SSE_HEADERS, subscriptionStream } from './sse.ts';

const EventsQuerySchema = z.object({
  entityId: z.string().guid(),
  conversationId: z.string().guid().optional(),
  lastEventId: z.string().min(1).max(200).optional(),
});

/** Le battement qui tient la connexion ouverte à travers les proxys. */
export const EVENTS_PING_MS = 25_000;

/** Un événement SSE avec son identifiant de reprise. */
function sseWithId(id: string, event: string, data: unknown): string {
  return `id: ${id}\n${sseEvent(event, data)}`;
}

export async function eventsRoute(
  c: Context,
  deps: RunnerDeps,
  bus: JobEventBus = jobEvents,
): Promise<Response> {
  const parsed = EventsQuerySchema.safeParse(c.req.query());
  if (!parsed.success) {
    return c.json({ error: 'invalid_request', issues: parsed.error.issues }, 400);
  }
  const { entityId } = parsed.data;
  const conversationId = parsed.data.conversationId ?? null;
  const lastEventId = c.req.header('last-event-id') ?? parsed.data.lastEventId ?? null;

  // L'espace de l'appelant, et lui seul.
  if (!c.get('callerTrusted') && entityId !== c.get('callerEntityId')) {
    return c.json({ error: 'forbidden' }, 403);
  }
  if (conversationId !== null) {
    const [conv] = await deps.db
      .select({ id: conversations.id })
      .from(conversations)
      .where(and(eq(conversations.id, conversationId), eq(conversations.entityId, entityId)))
      .limit(1);
    if (!conv) return c.json({ error: 'conversation_not_found' }, 404);
  }

  return streamJobEvents(c, bus, { entityId, conversationId, deviceId: null }, lastEventId, (e) => [
    { event: e.payload.type, data: e.payload },
  ]);
}

/** Ce qu'un auditeur écoute : un espace, une conversation, ou un appareil (#945). */
export interface JobEventScope {
  entityId: string;
  conversationId: string | null;
  deviceId: string | null;
}

/** Un événement du bus tel qu'un client le lit : zéro, un ou plusieurs événements SSE. */
export type RenderJobEvent = (e: StoredJobEvent) => Array<{ event: string; data: unknown }>;

/**
 * LE flux poussé : rejoue ce que le client a manqué puis passe en direct, ou
 * lui dit de relire la base (`resync`), avec un battement. Partagé par le flux
 * d'un espace (ci-dessus) et celui d'un appareil (routes/devices.ts) : un
 * seul transport. Chaque événement SSE porte l'identifiant de l'événement du
 * bus dont il vient — c'est le point de reprise du client.
 */
export function streamJobEvents(
  c: Context,
  bus: JobEventBus,
  scope: JobEventScope,
  lastEventId: string | null,
  render: RenderJobEvent,
): Response {
  const { entityId, conversationId, deviceId } = scope;
  // La fin du flux, quoi qui la cause (requête abandonnée, même avant cet
  // instant ; corps annulé ; lecteur parti), passe par `subscriptionStream` :
  // l'abonné quitte le bus et le corps se ferme, une fois (#1033).
  const stream = subscriptionStream(c.req.raw, ({ write }) => {
    // Un événement du bus peut en donner plusieurs : seul le DERNIER porte
    // l'identifiant, pour qu'un client coupé entre deux reprenne avant
    // l'événement du bus, jamais après une partie de lui.
    const send = (e: StoredJobEvent): void => {
      const outs = render(e);
      outs.forEach((out, i) =>
        write(
          i === outs.length - 1
            ? sseWithId(e.id, out.event, out.data)
            : sseEvent(out.event, out.data),
        ),
      );
    };

    // L'ouverture et l'inscription sont atomiques (`bus.open`) : rien ne
    // tombe entre ce qui est rejoué et le direct.
    const sub = bus.open(entityId, conversationId, lastEventId, send, deviceId);
    const ping = setInterval(() => write(': ping\n\n'), EVENTS_PING_MS);
    // Un battement ne garde pas le processus en vie à lui seul.
    ping.unref?.();

    // Ce qui a été manqué d'abord, puis `ready` : le client est en direct, et
    // son point de reprise est le dernier événement de l'espace. Ou bien un
    // `resync` à la place des deux.
    const { opening } = sub;
    if (opening.kind === 'resync') {
      write(sseWithId(opening.headId, 'resync', { type: 'resync', reason: opening.reason }));
    } else {
      if (opening.kind === 'replay') for (const e of opening.events) send(e);
      write(sseWithId(opening.headId, 'ready', {}));
    }
    return () => {
      sub.close();
      clearInterval(ping);
    };
  });

  return new Response(stream, { headers: { ...SSE_HEADERS } });
}
