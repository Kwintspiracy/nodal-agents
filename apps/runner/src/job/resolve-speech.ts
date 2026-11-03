// resolve-speech.ts — the speech a job's tools get (#487, #940), and the
// transcription the voice turn listens with (#941).
//
// `generate_speech` turns text into audio through OpenRouter. The key lives
// encrypted in `entity_llm_keys`; packages/tools never decrypts, and
// packages/speech never reads a secret either, so the runner binds the
// OpenRouter SpeechAdapter to the key here and injects the result as
// `ToolContext.speech`, the way `searchBackend` is injected for web_search.
// The call rides packages/llm's provider transport (`providerFetch`, #608),
// like every other model call of the process.
//
// The workspace's most recently added ACTIVE OpenRouter key is used. None ⇒
// undefined, and the tool tells the agent there is no key. A key that cannot be
// decrypted is not "no key": the speech then fails with that reason, loud
// (invariant #4), instead of the tool claiming nothing is configured.

import { and, desc, eq, entityLlmKeys, type AnyDrizzleDb } from '@nodal-agents/db';
import { providerFetch } from '@nodal-agents/llm';
import { decrypt } from '@nodal-agents/secrets';
import {
  bindSpeech,
  bindTranscription,
  getSpeechAdapter,
  getTranscriptionAdapter,
  type BoundSpeech,
  type BoundTranscription,
  type SpeechConnection,
} from '@nodal-agents/speech';

/**
 * The workspace's OpenRouter connection, read ONCE for both directions: the
 * voice that speaks (`resolveSpeech`) and the ear that listens
 * (`resolveTranscription`, the voice turn of #941) ride the same key, so a
 * second lookup could only ever disagree with the first.
 *
 * `undefined`: no active key. `{ undecryptable }`: a key exists and cannot be
 * read, which each caller reports as such, never as "no key".
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
    console.warn(`[resolveSpeech] openrouter key undecryptable: ${detail}`);
    return { undecryptable: detail };
  }
}

function undecryptableCall(detail: string): () => Promise<never> {
  return async () => {
    throw new Error(
      `the workspace OpenRouter key could not be decrypted (${detail.slice(0, 120)})`,
    );
  };
}

export async function resolveSpeech(
  db: AnyDrizzleDb,
  entityId: string | null,
): Promise<BoundSpeech | undefined> {
  const resolved = await workspaceOpenRouter(db, entityId);
  if (!resolved) return undefined;
  const adapter = getSpeechAdapter('openrouter');
  if ('undecryptable' in resolved) {
    const undecryptable = undecryptableCall(resolved.undecryptable);
    return {
      provider: adapter.provider,
      capabilities: adapter.capabilities,
      listVoices: undecryptable,
      synthesize: undecryptable,
    };
  }
  return bindSpeech(adapter, resolved.connection);
}

/**
 * The transcription the voice turn listens with (#941): the OpenRouter
 * TranscriptionAdapter of packages/speech, bound to the same workspace key and
 * transport as `resolveSpeech`. `undefined`: the workspace has no active
 * OpenRouter key, which the voice turn states before anyone speaks.
 */
export async function resolveTranscription(
  db: AnyDrizzleDb,
  entityId: string | null,
): Promise<BoundTranscription | undefined> {
  const resolved = await workspaceOpenRouter(db, entityId);
  if (!resolved) return undefined;
  const adapter = getTranscriptionAdapter('openrouter');
  if ('undecryptable' in resolved) {
    return {
      provider: adapter.provider,
      capabilities: adapter.capabilities,
      transcribe: undecryptableCall(resolved.undecryptable),
    };
  }
  return bindTranscription(adapter, resolved.connection);
}
