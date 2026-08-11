import 'server-only';
import { z } from 'zod';
import { eq, and, agents, entityLlmKeys } from '@nodal-agents/db';
import { getDb } from '@/lib/server.ts';
import { decrypt } from '@nodal-agents/secrets';
import { SpeechError, getSpeechAdapter, type SpeechProvider } from '@nodal-agents/speech';
import { guardVoiceRequest, isGuardFailure } from '../_guard.ts';

/**
 * POST /api/voice/speak — text in, audio out.
 *
 * The VOICE is not a parameter. The caller names an agent; the voice comes from
 * that agent's row. Accepting a voiceId from the client would mean the same
 * agent sounds like whoever asked, and would put the choice in the page rather
 * than in the agent — the whole point of storing it on the agent (migration
 * 0073) is that an agent has one voice everywhere it speaks: dashboard today,
 * messaging and telephony later.
 */

/** Long enough for any reply a chat turn produces, short enough that nobody
 *  turns this into a paid audiobook renderer. */
const MAX_CHARS = 5_000;

const Body = z.object({
  agentId: z.string().uuid(),
  text: z.string().min(1).max(MAX_CHARS),
  language: z.string().max(35).optional(),
});

export async function POST(req: Request): Promise<Response> {
  const guard = await guardVoiceRequest(req);
  if (isGuardFailure(guard)) return guard.response;

  const parsed = Body.safeParse(await req.json().catch(() => null));
  if (!parsed.success) {
    return Response.json(
      { error: 'bad_request', issues: parsed.error.issues.map((i) => i.path.join('.')) },
      { status: 400 },
    );
  }

  const db = getDb();
  // Scoped by entity, not just by id — otherwise the agent id in the body is an
  // IDOR: any authenticated user could make another workspace's agent speak,
  // billed to that workspace's key.
  const [agent] = await db
    .select({
      voiceProvider: agents.voiceProvider,
      voiceId: agents.voiceId,
    })
    .from(agents)
    .where(and(eq(agents.id, parsed.data.agentId), eq(agents.entityId, guard.entityId)))
    .limit(1);

  if (!agent) {
    return Response.json({ error: 'agent_not_found' }, { status: 404 });
  }
  // NULL voice means mute, and mute is the default (see migration 0073).
  // Answering with a house voice here would make every agent that never chose
  // one start talking, and bill it.
  if (!agent.voiceProvider || !agent.voiceId) {
    return Response.json({ error: 'agent_has_no_voice' }, { status: 409 });
  }

  const provider = agent.voiceProvider as SpeechProvider;
  let adapter;
  try {
    adapter = getSpeechAdapter(provider);
  } catch {
    // The column is free text (the catalogue moves at the vendors' pace, not
    // the migrations'), so a row can name a provider this build does not carry.
    return Response.json({ error: 'unknown_voice_provider', provider }, { status: 409 });
  }

  const [key] = await db
    .select({ apiKey: entityLlmKeys.apiKey })
    .from(entityLlmKeys)
    .where(
      and(
        eq(entityLlmKeys.entityId, guard.entityId),
        eq(entityLlmKeys.provider, provider),
        eq(entityLlmKeys.isActive, true),
      ),
    )
    .limit(1);

  if (!key?.apiKey) {
    return Response.json({ error: 'no_key_for_provider', provider }, { status: 409 });
  }

  try {
    const result = await adapter.synthesize(
      {
        text: parsed.data.text,
        voiceId: agent.voiceId,
        ...(parsed.data.language ? { language: parsed.data.language } : {}),
      },
      decrypt(key.apiKey),
    );
    return new Response(result.audio as unknown as BodyInit, {
      headers: {
        'content-type': result.mimeType,
        'content-length': String(result.audio.length),
        // Read by the client to show what the voice actually costs in waiting.
        // Measured 3.5–4.4 s on Gemini for one short sentence; a number the user
        // can see is a number they can judge.
        'x-nodal-latency-ms': String(result.latencyMs),
        // Audio of a private conversation. Never in a shared cache, and not
        // worth a private one either — the same text is rarely spoken twice.
        'cache-control': 'no-store',
      },
    });
  } catch (err) {
    if (err instanceof SpeechError) {
      const status = err.code === 'speech_bad_request' ? 400 : 502;
      return Response.json({ error: err.code, message: err.message }, { status });
    }
    console.error('[voice/speak]', err);
    return Response.json({ error: 'synthesis_failed' }, { status: 500 });
  }
}
