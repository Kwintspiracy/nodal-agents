// routes/chat-live.ts — POST /api/chat/live — se rebrancher sur un tour en cours (#457).
//
// Une page de conversation ouverte PENDANT qu'un tour s'écrit (la personne est
// partie ailleurs et revient) lit ici ce qui a déjà été écrit, puis la suite au
// fil de l'eau. Ce n'est pas un second tour : c'est le même, lu par une autre
// page (`live-turn.ts`).
//
// Réponses :
//   204                     aucun tour ne tourne pour cette conversation
//   200 text/event-stream   event: start  data: { "text": "…", "startedAt": ms }
//                           event: delta  data: { "text": "…" }
//                           event: end    data: {}   le tour est fini, sa ligne écrite
//
// `end` ne porte pas la réponse : elle est en base, et c'est la ligne relue qui
// fait foi (comme pour `/api/chat/stream`, invariant #4).

import type { Context } from 'hono';
import { z } from 'zod';
import { and, eq, conversations } from '@nodal-agents/db';
import type { RunnerDeps } from '../deps.ts';
import { attachLiveTurn, type LiveTurnEvent } from '../chat/live-turn.ts';
import { sseEvent, SSE_HEADERS } from './sse.ts';

const ChatLiveRequestSchema = z.object({
  entityId: z.string().guid(),
  conversationId: z.string().guid(),
});

export async function chatLiveRoute(c: Context, deps: RunnerDeps): Promise<Response> {
  const body = await c.req.json().catch(() => null);
  const parsed = ChatLiveRequestSchema.safeParse(body);
  if (!parsed.success) {
    return c.json({ error: 'invalid_request', issues: parsed.error.issues }, 400);
  }
  const { entityId, conversationId } = parsed.data;

  // Même autorisation que /api/chat/stop : le web a résolu l'entité depuis la
  // session ; un porteur de jeton ne lit que SON entité.
  if (!c.get('callerTrusted') && entityId !== c.get('callerEntityId')) {
    return c.json({ error: 'forbidden' }, 403);
  }
  const [conv] = await deps.db
    .select({ id: conversations.id })
    .from(conversations)
    .where(and(eq(conversations.id, conversationId), eq(conversations.entityId, entityId)))
    .limit(1);
  if (!conv) return c.json({ error: 'conversation_not_found' }, 404);

  const encoder = new TextEncoder();
  let detach: () => void = () => {};
  let closed = false;
  // Le branchement se fait AVANT d'ouvrir le flux : un tour qui n'existe pas se
  // dit par un 204, pas par un flux vide qui ressemblerait à une réponse vide.
  const pending: LiveTurnEvent[] = [];
  let push: (evt: LiveTurnEvent) => void = (evt) => {
    pending.push(evt);
  };
  const attached = attachLiveTurn(entityId, conversationId, (evt) => push(evt));
  if (!attached) return c.body(null, 204);
  detach = attached.detach;

  const stream = new ReadableStream<Uint8Array>({
    start(controller) {
      const close = (): void => {
        if (closed) return;
        closed = true;
        detach();
        try {
          controller.close();
        } catch {
          // Déjà fermé par le lecteur.
        }
      };
      const write = (evt: LiveTurnEvent): void => {
        if (closed) return;
        try {
          if (evt.kind === 'delta') {
            controller.enqueue(encoder.encode(sseEvent('delta', { text: evt.text })));
          } else {
            controller.enqueue(encoder.encode(sseEvent('end', {})));
            close();
          }
        } catch {
          // Le lecteur est parti : on se débranche, le tour continue sans lui.
          close();
        }
      };
      controller.enqueue(
        encoder.encode(sseEvent('start', { text: attached.text, startedAt: attached.startedAt })),
      );
      // Ce qui est arrivé entre le branchement et l'ouverture, dans l'ordre.
      for (const evt of pending.splice(0)) write(evt);
      push = write;
    },
    cancel() {
      closed = true;
      detach();
    },
  });

  return new Response(stream, { headers: { ...SSE_HEADERS } });
}
