// POST /api/chat/stop — le bouton Stop du chat (#456).
//
// Une ROUTE, comme `/api/chat/stream`, pas une action serveur : une action
// serveur est une transition React, et React lie les transitions en cours. Le
// Stop part PENDANT que le fil attend sa réponse ; en transition, il aurait pu
// retenir l'affichage de cette réponse jusqu'à sa propre fin.
//
// Elle fait les mêmes vérifications que la porte du flux — session,
// conversation DE L'ENTITÉ, secret interne — puis demande au runner d'arrêter
// le tour en cours de cette conversation. Elle ne décide rien : le tour se
// termine lui-même, et le flux ouvert rend son `done` comme d'habitude.

import { and, eq } from '@nodal-agents/db';
import { conversations } from '@nodal-agents/db';
import { z } from 'zod';
import { getDb, requireUserWithEntity } from '@/lib/server.ts';
import { env } from '@/lib/env.ts';

export const dynamic = 'force-dynamic';

const BodySchema = z.object({ conversationId: z.string().guid() });

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
    console.error('[chat/stop] WORKER_SECRET missing — cannot reach runner');
    return reply({ error: 'runner_unreachable' }, 503);
  }

  try {
    const upstream = await fetch(`${env.RUNNER_URL}/api/chat/stop`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${env.WORKER_SECRET}`,
      },
      body: JSON.stringify({
        entityId: session.entityId,
        conversationId: parsed.data.conversationId,
      }),
    });
    const data = (await upstream.json().catch(() => null)) as { stopped?: unknown } | null;
    if (!upstream.ok) return reply({ error: 'stop_failed' }, upstream.status);
    return reply({ stopped: data?.stopped === true }, 200);
  } catch (err) {
    console.error('[chat/stop] runner unreachable:', err);
    return reply({ error: 'runner_unreachable' }, 502);
  }
}
