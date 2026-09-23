// POST /api/chat/live — se rebrancher sur la réponse qui s'écrit (#457).
//
// Une page de conversation ouverte PENDANT qu'un tour s'écrit (la personne est
// partie ailleurs et revient) lit ici ce qui a déjà été écrit, puis la suite.
// Mêmes vérifications que `/api/chat/stop` — session, conversation DE
// L'ENTITÉ, secret interne — et le texte est MASQUÉ au passage comme dans
// `/api/chat/stream` (SECRET-001) : la page rouverte ne voit pas plus que celle
// qui a envoyé le message.
//
// Réponses : 204 quand aucun tour ne tourne ; sinon un flux
//   event: start  data: { "startedAt": ms }  le tour tourne depuis
//   event: delta  data: { "text": "…" }     ce qui avait été écrit, puis la suite
//   event: end    data: {}                  le tour est fini : relire le fil

import { and, eq } from '@nodal-agents/db';
import { conversations } from '@nodal-agents/db';
import { z } from 'zod';
import { getDb, requireUserWithEntity } from '@/lib/server.ts';
import { env } from '@/lib/env.ts';
import { createStreamRedactor } from '@/lib/redact-stream.ts';
import { readSseMessages, sseEvent } from '@/lib/sse.ts';

export const dynamic = 'force-dynamic';

const BodySchema = z.object({ conversationId: z.string().guid() });

const SSE_HEADERS: Readonly<Record<string, string>> = {
  'Content-Type': 'text/event-stream; charset=utf-8',
  'Cache-Control': 'no-cache, no-transform',
  Connection: 'keep-alive',
  'X-Accel-Buffering': 'no',
};

function reply(body: unknown, status: number): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'Content-Type': 'application/json' },
  });
}

export async function POST(req: Request): Promise<Response> {
  let session: { userId: string; entityId: string };
  try {
    session = await requireUserWithEntity(req);
  } catch {
    return reply({ error: 'unauthorized' }, 401);
  }

  const parsed = BodySchema.safeParse(await req.json().catch(() => null));
  if (!parsed.success) return reply({ error: 'validation_failed' }, 400);

  const [conv] = await getDb()
    .select({ id: conversations.id })
    .from(conversations)
    .where(
      and(
        eq(conversations.id, parsed.data.conversationId),
        eq(conversations.entityId, session.entityId),
      ),
    )
    .limit(1);
  if (!conv) return reply({ error: 'conversation_not_found' }, 404);

  if (!env.WORKER_SECRET) {
    console.error('[chat/live] WORKER_SECRET missing — cannot reach runner');
    return reply({ error: 'runner_unreachable' }, 503);
  }

  // La page qui s'en va débranche la lecture jusqu'au runner.
  const upstreamAbort = new AbortController();
  let upstream: Response;
  try {
    upstream = await fetch(`${env.RUNNER_URL}/api/chat/live`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${env.WORKER_SECRET}`,
      },
      body: JSON.stringify({
        entityId: session.entityId,
        conversationId: parsed.data.conversationId,
      }),
      signal: upstreamAbort.signal,
    });
  } catch (err) {
    console.error('[chat/live] runner unreachable:', err);
    return reply({ error: 'runner_unreachable' }, 502);
  }
  if (upstream.status === 204) return new Response(null, { status: 204 });
  const body = upstream.body;
  if (!upstream.ok || !body) return reply({ error: 'live_unavailable' }, upstream.status || 502);

  const encoder = new TextEncoder();
  const relayed = new ReadableStream<Uint8Array>({
    async start(controller) {
      const redactor = createStreamRedactor();
      const write = (event: string, data: unknown): void => {
        controller.enqueue(encoder.encode(sseEvent(event, data)));
      };
      const say = (text: string): void => {
        const safe = redactor.push(text);
        if (safe !== '') write('delta', { text: safe });
      };
      try {
        for await (const msg of readSseMessages(body)) {
          const data = JSON.parse(msg.data) as { text?: unknown; startedAt?: unknown };
          if (msg.event === 'start') {
            write('start', {
              startedAt: typeof data.startedAt === 'number' ? data.startedAt : null,
            });
            // Ce qui avait déjà été écrit passe par le MÊME masqueur que la suite.
            if (typeof data.text === 'string' && data.text !== '') say(data.text);
            continue;
          }
          if (msg.event === 'delta') {
            if (typeof data.text === 'string') say(data.text);
            continue;
          }
          if (msg.event === 'end') {
            const tail = redactor.flush();
            if (tail !== '') write('delta', { text: tail });
            write('end', {});
          }
        }
      } catch (err) {
        console.error('[chat/live] relay failed:', err);
      } finally {
        try {
          controller.close();
        } catch {
          // Déjà fermé.
        }
      }
    },
    cancel() {
      upstreamAbort.abort();
    },
  });

  return new Response(relayed, { headers: { ...SSE_HEADERS } });
}
