// POST /api/chat/stream — la porte du navigateur vers le tour en flux (#152).
//
// Une ROUTE, pas une action serveur : une action serveur rend une valeur, elle
// ne peut pas relayer un flux. C'est la seule raison d'être de ce fichier.
//
// Elle fait exactement ce que `sendChatMessageAction` fait avant d'appeler le
// runner — session, conversation de l'entité, agent DE LA CONVERSATION (jamais
// le ROOT courant), agent actif, secret interne — puis elle relaie les
// événements du runner au navigateur en MASQUANT les secrets au passage, comme
// le fil le fait pour tout ce qu'il affiche (SECRET-001).
//
// Ce qu'elle ne fait pas : décider. Le tour, sa file par conversation et sa
// ligne en base appartiennent au runner et n'ont pas bougé.

import { and, eq } from '@nodal-agents/db';
import { agents, conversations } from '@nodal-agents/db';
import { redactSecretsInText } from '@nodal-agents/shared';
import { z } from 'zod';
import { getDb, requireUserWithEntity } from '@/lib/server.ts';
import { env } from '@/lib/env.ts';
import { createStreamRedactor } from '@/lib/redact-stream.ts';
import { readSseMessages, sseEvent } from '@/lib/sse.ts';

// Un flux ne se met jamais en cache.
export const dynamic = 'force-dynamic';

const BodySchema = z.object({
  conversationId: z.string().guid(),
  // Même plafond que l'action serveur : on colle de gros textes dans un chat.
  message: z.string().min(1).max(200_000),
});

const SSE_HEADERS: Readonly<Record<string, string>> = {
  'Content-Type': 'text/event-stream; charset=utf-8',
  'Cache-Control': 'no-cache, no-transform',
  Connection: 'keep-alive',
  'X-Accel-Buffering': 'no',
};

/**
 * Un échec AVANT l'ouverture du flux se dit en JSON, avec son code HTTP : c'est
 * ce qui autorise l'appelant à repasser par le chemin d'avant sans risquer de
 * rejouer un tour déjà lancé. Une fois le flux ouvert, plus aucun code HTTP
 * n'est disponible, et l'échec se dit par un événement `error`.
 */
function refuse(error: string, status: number): Response {
  return new Response(JSON.stringify({ error }), {
    status,
    headers: { 'Content-Type': 'application/json' },
  });
}

export async function POST(req: Request): Promise<Response> {
  let session: { userId: string; entityId: string };
  try {
    session = await requireUserWithEntity(req);
  } catch {
    return refuse('unauthorized', 401);
  }

  const raw: unknown = await req.json().catch(() => null);
  const parsed = BodySchema.safeParse(raw);
  if (!parsed.success) return refuse('validation_failed', 400);

  const db = getDb();
  // L'agent DE LA CONVERSATION, jamais le ROOT courant : une conversation
  // appartient à l'agent avec qui elle a été menée (revue Codex, passe 29).
  const [conv] = await db
    .select({ agentId: conversations.agentId, agentActive: agents.active })
    .from(conversations)
    .leftJoin(agents, eq(agents.id, conversations.agentId))
    .where(
      and(
        eq(conversations.id, parsed.data.conversationId),
        eq(conversations.entityId, session.entityId),
      ),
    )
    .limit(1);
  if (!conv) return refuse('conversation_not_found', 404);
  if (conv.agentActive === false) return refuse('agent_inactive', 400);

  if (!env.WORKER_SECRET) {
    console.error('[chat/stream] WORKER_SECRET missing — cannot reach runner');
    return refuse('runner_unreachable', 503);
  }

  let upstream: Response;
  try {
    upstream = await fetch(`${env.RUNNER_URL}/api/chat/stream`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${env.WORKER_SECRET}`,
      },
      body: JSON.stringify({
        entityId: session.entityId,
        agentId: conv.agentId,
        conversationId: parsed.data.conversationId,
        message: parsed.data.message,
      }),
    });
  } catch (err) {
    console.error('[chat/stream] runner unreachable:', err);
    return refuse('runner_unreachable', 502);
  }

  const body = upstream.body;
  if (!upstream.ok || !body) {
    // Le runner n'a pas ouvert de flux : il n'a donc pas lancé de tour, et
    // l'appelant peut reprendre le chemin d'avant. On lui rend le statut tel
    // quel plutôt qu'un flux vide qui ressemblerait à une réponse vide.
    return refuse('stream_unavailable', upstream.status === 200 ? 502 : upstream.status);
  }

  const encoder = new TextEncoder();
  const relayed = new ReadableStream<Uint8Array>({
    async start(controller) {
      const redactor = createStreamRedactor();
      const write = (event: string, data: unknown): void => {
        controller.enqueue(encoder.encode(sseEvent(event, data)));
      };
      try {
        for await (const msg of readSseMessages(body)) {
          if (msg.event === 'delta') {
            const text = (JSON.parse(msg.data) as { text?: unknown }).text;
            if (typeof text !== 'string') continue;
            // Ce qui sort est déjà masqué ; ce qui pourrait encore devenir un
            // secret attend le fragment suivant (`createStreamRedactor`).
            const safe = redactor.push(text);
            if (safe !== '') write('delta', { text: safe });
            continue;
          }
          if (msg.event === 'done') {
            const payload = JSON.parse(msg.data) as {
              reply?: unknown;
              spawnedJobId?: unknown;
              streamed?: unknown;
              stopped?: unknown;
            };
            // La réserve du masqueur n'a plus de suite à attendre : elle sort
            // ici, avant la réponse entière qui la remplace de toute façon.
            const tail = redactor.flush();
            if (tail !== '') write('delta', { text: tail });
            const reply = typeof payload.reply === 'string' ? payload.reply : '';
            write('done', {
              // La réponse ENTIÈRE, masquée d'un bloc — exactement ce que le
              // fil rendra au rechargement. C'est elle qui fait foi.
              reply: redactSecretsInText(reply),
              spawnedJobId: typeof payload.spawnedJobId === 'string' ? payload.spawnedJobId : null,
              // Relayé tel quel : le runner sait si les fragments étaient bien
              // cette réponse, la porte web n'a rien à en juger.
              streamed: payload.streamed === true,
              // La personne a arrêté ce tour (#456) : relayé tel quel.
              stopped: payload.stopped === true,
            });
            continue;
          }
          if (msg.event === 'error') {
            const error = (JSON.parse(msg.data) as { error?: unknown }).error;
            write('error', { error: typeof error === 'string' ? error : 'chat_failed' });
          }
        }
      } catch (err) {
        console.error('[chat/stream] relay failed:', err);
        try {
          write('error', { error: 'stream_interrupted' });
        } catch {
          // Le navigateur est déjà parti.
        }
      } finally {
        try {
          controller.close();
        } catch {
          // Déjà fermé.
        }
      }
    },
  });

  return new Response(relayed, { headers: { ...SSE_HEADERS } });
}
