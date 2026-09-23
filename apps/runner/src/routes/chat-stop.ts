// routes/chat-stop.ts — POST /api/chat/stop — arrêter le tour de chat en cours (#456).
//
// Le bouton Stop du chat. Il ne décide rien : il déclenche le contrôleur que
// le tour en cours de CETTE conversation a déposé (`turn-stop.ts`). Le tour se
// termine lui-même — il garde ce qu'il avait écrit, pose la ligne de
// plateforme, et le flux de `/api/chat/stream` rend son `done` comme toujours.
//
// Réponse : `{ stopped: true }` si un tour tournait, `{ stopped: false }`
// sinon. Un Stop qui arrive après la fin n'est pas une erreur : la réponse
// était déjà là, et c'est ce que la personne voit.

import type { Context } from 'hono';
import { z } from 'zod';
import { and, eq, conversations } from '@nodal-agents/db';
import type { RunnerDeps } from '../deps.ts';
import { stopChatTurn } from '../chat/turn-stop.ts';

const ChatStopRequestSchema = z.object({
  entityId: z.string().guid(),
  conversationId: z.string().guid(),
});

export async function chatStopRoute(c: Context, deps: RunnerDeps): Promise<Response> {
  const body = await c.req.json().catch(() => null);
  const parsed = ChatStopRequestSchema.safeParse(body);
  if (!parsed.success) {
    return c.json({ error: 'invalid_request', issues: parsed.error.issues }, 400);
  }
  const { entityId, conversationId } = parsed.data;

  // Même autorisation que /api/chat/stream : l'appelant de confiance (le web)
  // a résolu l'entité depuis la session ; un porteur de jeton n'agit que pour
  // SON entité.
  if (!c.get('callerTrusted') && entityId !== c.get('callerEntityId')) {
    return c.json({ error: 'forbidden' }, 403);
  }
  // Et la conversation doit être de cette entité : on n'arrête jamais le tour
  // d'une autre, même avec son identifiant.
  const [conv] = await deps.db
    .select({ id: conversations.id })
    .from(conversations)
    .where(and(eq(conversations.id, conversationId), eq(conversations.entityId, entityId)))
    .limit(1);
  if (!conv) return c.json({ error: 'conversation_not_found' }, 404);

  return c.json({ stopped: stopChatTurn(conversationId) });
}
