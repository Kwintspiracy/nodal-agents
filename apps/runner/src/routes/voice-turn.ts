// routes/voice-turn.ts — le geste `say` : un tour dit, reçu par morceaux (#941).
//
//   POST   /api/voice/turns                       { entityId, conversationId, format, sampleRate? }
//                                                 → 201 { turnId }
//   POST   /api/voice/turns/:turnId/chunks/:seq   corps = octets audio bruts → 200 { received }
//   POST   /api/voice/turns/:turnId/end           → 200 le résultat du tour (`VoiceTurnResult`)
//   DELETE /api/voice/turns/:turnId               → 200 { cancelled }   (le geste `cancel`)
//
// Pourquoi trois requêtes et pas un corps en flux : voir chat/voice-utterances.ts.
// Un client de vingt lignes :
//
//   const { turnId } = await post('/api/voice/turns', { entityId, conversationId,
//                                  format: 'audio/pcm', sampleRate: 16000 });
//   let seq = 0;
//   for await (const pcm of microphone()) await postBytes(`/api/voice/turns/${turnId}/chunks/${seq++}`, pcm);
//   const turn = await post(`/api/voice/turns/${turnId}/end`);
//   if (turn.outcome === 'replied') play(turn.audio);
//
// L'ORIGINE EST UNE DONNÉE (règle du #948) : le tour appartient à la
// conversation qu'il nomme, et l'agent est celui de cette conversation. Aucune
// branche « est-ce le tableau de bord » ; le tableau de bord passera par son
// proxy (#942) comme n'importe quel client.
//
// AUTORISATION : la garde du runner, la même que `/api/chat*` (server.ts). La
// route ne lit que ce que la garde pose sur le contexte (`callerTrusted`,
// `callerEntityId`) : quand #946 ajoutera le jeton d'un module, il posera les
// mêmes faits, et cette route n'aura pas à changer. Rien ici ne demande une
// session du tableau de bord.

import type { Context } from 'hono';
import { z } from 'zod';
import { and, conversations, eq } from '@nodal-agents/db';
import type { RunnerDeps } from '../deps.ts';
import type { RunnerEnv } from '../env.ts';
import { resolveTranscription } from '../job/resolve-speech.ts';
import { readBoundedBody } from '../lib/read-bounded-body.ts';
import { runVoiceTurn } from '../chat/run-voice-turn.ts';
import {
  VOICE_FORMATS,
  VOICE_LIMITS,
  appendChunk,
  cancelUtterance,
  openUtterance,
  peekUtterance,
  takeUtterance,
  type VoiceUtterance,
} from '../chat/voice-utterances.ts';

const StartSchema = z
  .object({
    entityId: z.string().guid(),
    conversationId: z.string().guid(),
    format: z.enum(VOICE_FORMATS),
    // Le PCM brut ne dit pas sa fréquence : elle est annoncée. Un WAV la porte
    // dans son en-tête : l'annoncer aussi donnerait deux sources qui peuvent
    // se contredire, et l'une des deux serait crue en silence.
    sampleRate: z.number().int().min(8_000).max(192_000).optional(),
  })
  .refine((b) => (b.format === 'audio/pcm') === (b.sampleRate !== undefined), {
    message: 'sampleRate is required for audio/pcm and refused for audio/wav',
    path: ['sampleRate'],
  });

/**
 * Le tour `turnId` s'il appartient à l'appelant. Un appelant de confiance (le
 * web avec WORKER_SECRET, local-trust) a déjà résolu son entité ; un porteur
 * de session n'atteint que les tours de SON entité. Un tour d'une autre
 * entité répond comme un tour inexistant : son existence ne se devine pas.
 */
function ownTurn(c: Context, turnId: string): VoiceUtterance | undefined {
  const u = peekUtterance(turnId);
  if (!u) return undefined;
  if (!c.get('callerTrusted') && u.entityId !== c.get('callerEntityId')) return undefined;
  return u;
}

export async function voiceTurnStartRoute(c: Context, deps: RunnerDeps): Promise<Response> {
  const parsed = StartSchema.safeParse(await c.req.json().catch(() => null));
  if (!parsed.success) {
    return c.json({ error: 'invalid_request', issues: parsed.error.issues }, 400);
  }
  const { entityId, conversationId, format, sampleRate } = parsed.data;
  if (!c.get('callerTrusted') && entityId !== c.get('callerEntityId')) {
    return c.json({ error: 'forbidden' }, 403);
  }

  const [conv] = await deps.db
    .select({ agentId: conversations.agentId })
    .from(conversations)
    .where(and(eq(conversations.id, conversationId), eq(conversations.entityId, entityId)))
    .limit(1);
  if (!conv?.agentId) return c.json({ error: 'conversation_not_found' }, 404);

  // Dit AVANT que la personne parle : sans clé, rien de ce qu'elle dirait ne
  // serait entendu.
  if (!(await resolveTranscription(deps.db, entityId))) {
    return c.json({ error: 'speech_not_configured' }, 409);
  }

  const opened = openUtterance({
    entityId,
    conversationId,
    agentId: conv.agentId,
    format:
      format === 'audio/pcm' && sampleRate !== undefined
        ? { kind: 'audio/pcm', sampleRate }
        : { kind: 'audio/wav' },
  });
  if (!opened.ok) return c.json({ error: opened.error }, 429);
  return c.json({ turnId: opened.id }, 201);
}

export async function voiceTurnChunkRoute(c: Context): Promise<Response> {
  const turnId = c.req.param('turnId') ?? '';
  const seq = Number(c.req.param('seq'));
  if (!Number.isInteger(seq) || seq < 0) return c.json({ error: 'invalid_request' }, 400);
  const u = ownTurn(c, turnId);
  if (!u) return c.json({ error: 'turn_not_found' }, 404);

  // La LECTURE elle-même est bornée à ce que le tour peut encore recevoir
  // (revue de #958, passe 1) : un corps en `Transfer-Encoding: chunked` n'a
  // pas de Content-Length, et `arrayBuffer()` l'aurait alloué en entier avant
  // tout refus. Le tour entier part, comme dans `appendChunk`.
  const read = await readBoundedBody(c.req.raw, VOICE_LIMITS.maxBytes - u.bytes);
  if (!read.ok) {
    cancelUtterance(turnId);
    return c.json({ error: 'audio_too_long' }, 413);
  }
  const appended = appendChunk(turnId, seq, read.bytes);
  if (!appended.ok) {
    const status =
      appended.error === 'turn_not_found' ? 404 : appended.error === 'audio_too_long' ? 413 : 409;
    return c.json(
      { error: appended.error, ...(status === 409 ? { expected: u.nextSeq } : {}) },
      status,
    );
  }
  return c.json({ received: appended.received });
}

export async function voiceTurnEndRoute(
  c: Context,
  deps: RunnerDeps,
  runnerEnv: RunnerEnv,
): Promise<Response> {
  const turnId = c.req.param('turnId') ?? '';
  if (!ownTurn(c, turnId)) return c.json({ error: 'turn_not_found' }, 404);
  const u = takeUtterance(turnId);
  if (!u) return c.json({ error: 'turn_not_found' }, 404);

  const result = await runVoiceTurn(deps, runnerEnv, u);
  if (result.outcome === 'failed') {
    return c.json(
      { error: result.error, ...(result.detail ? { detail: result.detail } : {}) },
      result.status,
    );
  }
  return c.json(result);
}

export function voiceTurnCancelRoute(c: Context): Response {
  const turnId = c.req.param('turnId') ?? '';
  if (!ownTurn(c, turnId)) return c.json({ error: 'turn_not_found' }, 404);
  return c.json({ cancelled: cancelUtterance(turnId) });
}
