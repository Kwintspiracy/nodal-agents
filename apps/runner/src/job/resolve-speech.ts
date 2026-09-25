// resolve-speech.ts — the speech generator a job's tools get (#487).
//
// `generate_speech` turns text into audio through OpenRouter. The key lives
// encrypted in `entity_llm_keys`; packages/tools never decrypts, so the runner
// builds the generator here and injects it as `ToolContext.speechGenerator`,
// the way `searchBackend` is injected for web_search.
//
// The workspace's most recently added ACTIVE OpenRouter key is used. None ⇒
// undefined, and the tool tells the agent there is no key. A key that cannot be
// decrypted is not "no key": the generator then fails with that reason, loud
// (invariant #4), instead of the tool claiming nothing is configured.

import { and, desc, eq, entityLlmKeys, type AnyDrizzleDb } from '@nodal-agents/db';
import { createOpenRouterSpeech, type SpeechGenerator } from '@nodal-agents/llm';
import { decrypt } from '@nodal-agents/secrets';

export async function resolveSpeechGenerator(
  db: AnyDrizzleDb,
  entityId: string | null,
): Promise<SpeechGenerator | undefined> {
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

  let apiKey: string;
  try {
    apiKey = decrypt(row.apiKey);
  } catch (err) {
    const detail = err instanceof Error ? err.message : String(err);
    console.warn(`[resolveSpeechGenerator] openrouter key undecryptable: ${detail}`);
    return async () => {
      throw new Error(
        `the workspace OpenRouter key could not be decrypted (${detail.slice(0, 120)})`,
      );
    };
  }
  return createOpenRouterSpeech(apiKey, row.baseUrl ? { baseURL: row.baseUrl } : {});
}
