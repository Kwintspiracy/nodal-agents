// resolve-speech.ts — the speech a job's tools get (#487, #940).
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
import { bindSpeech, getSpeechAdapter, type BoundSpeech } from '@nodal-agents/speech';

export async function resolveSpeech(
  db: AnyDrizzleDb,
  entityId: string | null,
): Promise<BoundSpeech | undefined> {
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

  const adapter = getSpeechAdapter('openrouter');
  let apiKey: string;
  try {
    apiKey = decrypt(row.apiKey);
  } catch (err) {
    const detail = err instanceof Error ? err.message : String(err);
    console.warn(`[resolveSpeech] openrouter key undecryptable: ${detail}`);
    const undecryptable = async (): Promise<never> => {
      throw new Error(
        `the workspace OpenRouter key could not be decrypted (${detail.slice(0, 120)})`,
      );
    };
    return {
      provider: adapter.provider,
      capabilities: adapter.capabilities,
      listVoices: undecryptable,
      synthesize: undecryptable,
    };
  }
  return bindSpeech(adapter, {
    apiKey,
    fetch: providerFetch,
    ...(row.baseUrl ? { baseURL: row.baseUrl } : {}),
  });
}
