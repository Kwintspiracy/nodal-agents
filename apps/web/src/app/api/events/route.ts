// GET /api/events — la porte du navigateur vers le flux poussé du runner (#944).
//
// Le navigateur écoute ici ce que le runner pousse pour SON espace (un job
// fini, une question, une approbation, une demande tranchée), éventuellement
// pour une seule conversation. La route ne fait que deux choses : poser
// l'espace de la session (jamais celui que la page affirmerait), et relayer le
// flux tel quel. Le protocole, la reprise (`Last-Event-ID`), le masquage des
// secrets et le refus d'une conversation hors de l'espace sont ceux du runner
// (`apps/runner/src/routes/events.ts`) : un module externe lit la MÊME route,
// et ce que la page reçoit ne dépend pas de qui l'a relayé (règle de #948).
//
// Réponses : 401 sans session, 400 requête illisible, 502/503 runner
// injoignable ; sinon le statut et le flux du runner.

import { z } from 'zod';
import { requireUserWithEntity } from '@/lib/server.ts';
import { env } from '@/lib/env.ts';

// Un flux ne se met jamais en cache.
export const dynamic = 'force-dynamic';

const QuerySchema = z.object({
  conversationId: z.string().guid().optional(),
  lastEventId: z.string().min(1).max(200).optional(),
});

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

export async function GET(req: Request): Promise<Response> {
  let session: { userId: string; entityId: string };
  try {
    session = await requireUserWithEntity(req);
  } catch {
    return reply({ error: 'unauthorized' }, 401);
  }

  const url = new URL(req.url);
  const parsed = QuerySchema.safeParse({
    conversationId: url.searchParams.get('conversationId') ?? undefined,
    lastEventId: url.searchParams.get('lastEventId') ?? undefined,
  });
  if (!parsed.success) return reply({ error: 'validation_failed' }, 400);

  if (!env.WORKER_SECRET) {
    console.error('[events] WORKER_SECRET missing — cannot reach runner');
    return reply({ error: 'runner_unreachable' }, 503);
  }

  const query = new URLSearchParams({ entityId: session.entityId });
  if (parsed.data.conversationId) query.set('conversationId', parsed.data.conversationId);
  if (parsed.data.lastEventId) query.set('lastEventId', parsed.data.lastEventId);
  // Le navigateur qui se reconnecte renvoie le dernier identifiant vu : le
  // runner en tire ce qui a été manqué, ou un `resync`.
  const lastEventId = req.headers.get('last-event-id');

  let upstream: Response;
  try {
    upstream = await fetch(`${env.RUNNER_URL}/api/events?${query.toString()}`, {
      headers: {
        Authorization: `Bearer ${env.WORKER_SECRET}`,
        ...(lastEventId ? { 'Last-Event-ID': lastEventId } : {}),
      },
      // La page qui s'en va débranche la lecture jusqu'au runner.
      signal: req.signal,
    });
  } catch (err) {
    console.error('[events] runner unreachable:', err);
    return reply({ error: 'runner_unreachable' }, 502);
  }
  if (!upstream.ok || !upstream.body) {
    // Le refus du runner (403, 404…) passe tel quel, avec son code.
    const body: unknown = await upstream.json().catch(() => ({ error: 'events_unavailable' }));
    return reply(body, upstream.status === 200 ? 502 : upstream.status);
  }
  return new Response(upstream.body, { headers: { ...SSE_HEADERS } });
}
