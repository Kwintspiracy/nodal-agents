// resolve-speech.ts — the transcription the voice turn listens with (#941).
//
// THE VOICE that speaks is no longer resolved here (#969): it is the
// workspace's voice setting, read by `resolveVoice` (resolve-voice.ts) for
// every door that speaks — the voice turn, the sample of the Settings screen
// and `generate_speech`. Until #969 this file bound the OpenRouter adapter for
// speaking too, and the voice was the first model and voice written in the
// code.
//
// The ear stays on the workspace's OpenRouter key: transcription is
// OpenRouter's (see providers/openrouter.ts for why). The key lives encrypted
// in `entity_llm_keys`; packages/speech never reads a secret, so the runner
// binds the TranscriptionAdapter to the key here. The call rides
// packages/llm's provider transport (`providerFetch`, #608), like every other
// model call of the process.
//
// The workspace's most recently added ACTIVE OpenRouter key is used. None ⇒
// undefined, which the voice turn states before anyone speaks. A key that
// cannot be decrypted is not "no key": the transcription then fails with that
// reason, loud (invariant #4).

import { and, desc, eq, entityLlmKeys, type AnyDrizzleDb } from '@nodal-agents/db';
import { providerFetch } from '@nodal-agents/llm';
import { decrypt } from '@nodal-agents/secrets';
import {
  bindTranscription,
  getTranscriptionAdapter,
  type BoundTranscription,
  type SpeechConnection,
} from '@nodal-agents/speech';

/**
 * The workspace's OpenRouter connection. `undefined`: no active key.
 * `{ undecryptable }`: a key exists and cannot be read, which the caller
 * reports as such, never as "no key".
 */
async function workspaceOpenRouter(
  db: AnyDrizzleDb,
  entityId: string | null,
): Promise<{ connection: SpeechConnection } | { undecryptable: string } | undefined> {
  if (entityId === null) return undefined;
  const [row] = await db
    .select({ apiKey: entityLlmKeys.apiKey, baseUrl: entityLlmKeys.baseUrl })
    .from(entityLlmKeys)
    .where(
      and(
        eq(entityLlmKeys.entityId, entityId),
        eq(entityLlmKeys.provider, 'openrouter'),
        eq(entityLlmKeys.isActive, true),
      ),
    )
    .orderBy(desc(entityLlmKeys.createdAt))
    .limit(1);
  if (!row?.apiKey) return undefined;
  try {
    return {
      connection: {
        apiKey: decrypt(row.apiKey),
        fetch: providerFetch,
        ...(row.baseUrl ? { baseURL: row.baseUrl } : {}),
      },
    };
  } catch (err) {
    const detail = err instanceof Error ? err.message : String(err);
    console.warn(`[resolveTranscription] openrouter key undecryptable: ${detail}`);
    return { undecryptable: detail };
  }
}

/**
 * The transcription the voice turn listens with (#941): the OpenRouter
 * TranscriptionAdapter of packages/speech, bound to the workspace key.
 * `undefined`: the workspace has no active OpenRouter key, which the voice
 * turn states before anyone speaks.
 */
export async function resolveTranscription(
  db: AnyDrizzleDb,
  entityId: string | null,
): Promise<BoundTranscription | undefined> {
  const resolved = await workspaceOpenRouter(db, entityId);
  if (!resolved) return undefined;
  const adapter = getTranscriptionAdapter('openrouter');
  if ('undecryptable' in resolved) {
    const detail = resolved.undecryptable;
    return {
      provider: adapter.provider,
      capabilities: adapter.capabilities,
      transcribe: async () => {
        throw new Error(
          `the workspace OpenRouter key could not be decrypted (${detail.slice(0, 120)})`,
        );
      },
    };
  }
  return bindTranscription(adapter, resolved.connection);
}
