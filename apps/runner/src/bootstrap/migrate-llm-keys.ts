// bootstrap/migrate-llm-keys.ts — Brique 26
//
// One-shot, idempotent migration that converts plaintext entity_llm_keys.api_key
// rows to the encrypted-at-rest format (enc:v1:...) and populates apiKeyLast4
// for display.
//
// Runs on every runner boot — already-encrypted rows are skipped, so re-running
// is a no-op. The first run after deploying Brique 26 picks up legacy rows.

import { eq, entityLlmKeys } from '@nodalai/db';
import type { AnyDrizzleDb } from '@nodalai/db';
import { encrypt, isEncrypted, last4, loadOrCreateMasterKey } from '@nodalai/secrets';

export async function migrateLlmKeysToEncrypted(db: AnyDrizzleDb): Promise<void> {
  // Eagerly load (or create) the master key so any failure surfaces here,
  // before we touch the DB.
  loadOrCreateMasterKey();

  const rows = await db
    .select({
      id: entityLlmKeys.id,
      apiKey: entityLlmKeys.apiKey,
      apiKeyLast4: entityLlmKeys.apiKeyLast4,
    })
    .from(entityLlmKeys);

  let migrated = 0;
  for (const row of rows) {
    const isEmpty = row.apiKey === '';
    const alreadyEncrypted = !isEmpty && isEncrypted(row.apiKey);
    const needsEncrypt = !isEmpty && !alreadyEncrypted;
    const needsLast4 = !isEmpty && !alreadyEncrypted && row.apiKeyLast4 === '';
    if (!needsEncrypt && !needsLast4) continue;

    const plaintext = row.apiKey;
    const patch: Record<string, unknown> = { updatedAt: new Date() };
    if (needsEncrypt) patch['apiKey'] = encrypt(plaintext);
    if (needsLast4) patch['apiKeyLast4'] = last4(plaintext);

    await db.update(entityLlmKeys).set(patch).where(eq(entityLlmKeys.id, row.id));
    migrated++;
  }

  if (migrated > 0) {
    console.warn(`[secrets] migrated ${migrated} llm key(s) to encrypted-at-rest format`);
  }
}
