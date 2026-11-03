// routes/chat.ts — POST /api/chat — generate one in-app chat reply.
//
// Conversation-first: this NEVER creates an agent_jobs row (pure conversation).
// The web calls it (WORKER_SECRET bearer) with the resolved entity + agent.
//
// POST /api/chat { entityId, agentId, message, threadId? } → { reply }

import type { Context } from 'hono';
import { z } from 'zod';
import type { RunnerDeps } from '../deps.ts';
import type { RunnerEnv } from '../env.ts';
import { playChatTurn } from '../chat/play-turn.ts';

const ChatRequestSchema = z.object({
  entityId: z.string().guid(),
  agentId: z.string().guid(),
  conversationId: z.string().guid(),
  // Generous cap (matches the web SendChatMessageSchema): large pasted skills/personalities.
  message: z.string().min(1).max(200_000),
});

export async function chatRoute(
  c: Context,
  deps: RunnerDeps,
  runnerEnv: RunnerEnv,
): Promise<Response> {
  const body = await c.req.json().catch(() => null);
  const parsed = ChatRequestSchema.safeParse(body);
  if (!parsed.success) {
    return c.json({ error: 'invalid_request', issues: parsed.error.issues }, 400);
  }
  const { entityId, agentId, conversationId, message } = parsed.data;

  // Authorization (finding #4/#5): a trusted caller (web via WORKER_SECRET,
  // local-trust) has already scoped entityId from the user's session — trust
  // the body. An untrusted session bearer-token caller may only run a turn
  // for its OWN entity; anything else is a cross-tenant attempt.
  if (!c.get('callerTrusted') && entityId !== c.get('callerEntityId')) {
    return c.json({ error: 'forbidden' }, 403);
  }

  // Un tour à la fois par conversation : le dashboard envoie plusieurs messages
  // à la suite sans attendre la réponse, et chacun doit voir la réponse au
  // précédent dans son historique (Quentin, 18/09).
  // Le chemin de secours du chat (le flux indisponible) : Stop l'atteint
  // aussi (#456, revue Codex de #459, passe 2) — même registre, même tour.
  // Le tour est lisible d'une autre page pendant qu'il tourne (#457) : ce
  // chemin ne diffuse aucun texte, mais une page rouverte sait qu'il répond.
  // Si le tour escalade, son job part en fond (`playChatTurn`) : le chat rend
  // l'accusé de l'agent tout de suite, l'écran suit le job.
  const result = await playChatTurn(
    deps,
    runnerEnv,
    { entityId, agentId, conversationId, message },
    'chatRoute',
  );
  if (!result.ok) {
    const notFound =
      result.error === 'agent_not_found' || result.error === 'conversation_not_found';
    return c.json(
      { error: result.error, ...(result.cutReason ? { cutReason: result.cutReason } : {}) },
      notFound ? 404 : 400,
    );
  }

  return c.json({ reply: result.reply });
}
