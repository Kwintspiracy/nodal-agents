// migrate-llm-keys.test.ts — Brique 26 idempotent encryption migration
//
// Verifies that on runner boot, plaintext entity_llm_keys.api_key rows are
// encrypted in place and apiKeyLast4 is populated. Already-encrypted rows
// are left alone (re-running is a no-op).

import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { randomBytes } from 'node:crypto';
import { spinUpTestDb } from '@nodal-agents/db/test-utils';
import type { TestDb } from '@nodal-agents/db/test-utils';
import { eq } from '@nodal-agents/db';
import { entityLlmKeys, entities, users } from '@nodal-agents/db';
import {
  _setMasterKeyForTests,
  _resetMasterKeyCacheForTests,
  decrypt,
  isEncrypted,
} from '@nodal-agents/secrets';
import { migrateLlmKeysToEncrypted } from '../../bootstrap/migrate-llm-keys.ts';

beforeAll(() => {
  _setMasterKeyForTests(randomBytes(32));
});
afterAll(() => {
  _resetMasterKeyCacheForTests();
});

async function makeEntity(db: TestDb): Promise<string> {
  const [user] = await db
    .insert(users)
    .values({ email: `mig-${Date.now()}-${Math.random()}@example.com` })
    .returning();
  if (!user) throw new Error('seed user');
  const [entity] = await db
    .insert(entities)
    .values({ userId: user.id, name: 'E', slug: `e-${Date.now()}-${Math.random()}` })
    .returning();
  if (!entity) throw new Error('seed entity');
  return entity.id;
}

describe('migrateLlmKeysToEncrypted (Brique 26)', () => {
  it('encrypts plaintext rows in place and populates apiKeyLast4', async () => {
    const { db } = await spinUpTestDb();
    const entityId = await makeEntity(db);

    // Insert a row in legacy plaintext format (the state before Brique 26 ships).
    const [row] = await db
      .insert(entityLlmKeys)
      .values({
        entityId,
        provider: 'anthropic',
        apiKey: 'sk-ant-secret-99887766',
        apiKeyLast4: '',
        nickname: 'Legacy',
        defaultModel: 'claude-haiku-4-5',
        isActive: true,
      })
      .returning();
    if (!row) throw new Error('seed row');

    await migrateLlmKeysToEncrypted(db as TestDb);

    const [after] = await (db as TestDb)
      .select({ apiKey: entityLlmKeys.apiKey, apiKeyLast4: entityLlmKeys.apiKeyLast4 })
      .from(entityLlmKeys)
      .where(eq(entityLlmKeys.id, row.id));
    expect(after).toBeDefined();
    expect(isEncrypted(after!.apiKey)).toBe(true);
    expect(decrypt(after!.apiKey)).toBe('sk-ant-secret-99887766');
    expect(after!.apiKeyLast4).toBe('7766');
  });

  it('is idempotent: re-running leaves already-encrypted rows untouched', async () => {
    const { db } = await spinUpTestDb();
    const entityId = await makeEntity(db);

    const [row] = await db
      .insert(entityLlmKeys)
      .values({
        entityId,
        provider: 'anthropic',
        apiKey: 'sk-ant-secret-99887766',
        apiKeyLast4: '',
        nickname: 'Legacy',
        defaultModel: 'claude-haiku-4-5',
        isActive: true,
      })
      .returning();
    if (!row) throw new Error('seed row');

    await migrateLlmKeysToEncrypted(db as TestDb);
    const [afterFirst] = await (db as TestDb)
      .select({ apiKey: entityLlmKeys.apiKey, apiKeyLast4: entityLlmKeys.apiKeyLast4 })
      .from(entityLlmKeys)
      .where(eq(entityLlmKeys.id, row.id));

    await migrateLlmKeysToEncrypted(db as TestDb);
    const [afterSecond] = await (db as TestDb)
      .select({ apiKey: entityLlmKeys.apiKey, apiKeyLast4: entityLlmKeys.apiKeyLast4 })
      .from(entityLlmKeys)
      .where(eq(entityLlmKeys.id, row.id));

    // Same ciphertext (no re-encryption with a fresh IV) and same last4.
    expect(afterSecond!.apiKey).toBe(afterFirst!.apiKey);
    expect(afterSecond!.apiKeyLast4).toBe(afterFirst!.apiKeyLast4);
  });

  it('leaves empty rows alone (no encryption applied to "")', async () => {
    const { db } = await spinUpTestDb();
    const entityId = await makeEntity(db);

    const [row] = await db
      .insert(entityLlmKeys)
      .values({
        entityId,
        provider: 'ollama',
        apiKey: '',
        apiKeyLast4: '',
        nickname: 'No-key Ollama',
        defaultModel: 'llama3.3:70b',
        isActive: true,
      })
      .returning();
    if (!row) throw new Error('seed row');

    await migrateLlmKeysToEncrypted(db as TestDb);

    const [after] = await (db as TestDb)
      .select({ apiKey: entityLlmKeys.apiKey, apiKeyLast4: entityLlmKeys.apiKeyLast4 })
      .from(entityLlmKeys)
      .where(eq(entityLlmKeys.id, row.id));
    expect(after!.apiKey).toBe('');
    expect(after!.apiKeyLast4).toBe('');
  });

  it('handles a mix of legacy plaintext, already-encrypted, and empty rows in one pass', async () => {
    const { db } = await spinUpTestDb();
    const entityId = await makeEntity(db);

    const { encrypt } = await import('@nodal-agents/secrets');

    const [legacy] = await db
      .insert(entityLlmKeys)
      .values({
        entityId,
        provider: 'anthropic',
        apiKey: 'sk-legacy-1234',
        apiKeyLast4: '',
        nickname: 'Legacy',
        defaultModel: 'm',
        isActive: true,
      })
      .returning();
    const [alreadyEnc] = await db
      .insert(entityLlmKeys)
      .values({
        entityId,
        provider: 'openai',
        apiKey: encrypt('sk-already-9999'),
        apiKeyLast4: '9999',
        nickname: 'Pre-encrypted',
        defaultModel: 'm',
        isActive: true,
      })
      .returning();
    const [empty] = await db
      .insert(entityLlmKeys)
      .values({
        entityId,
        provider: 'ollama',
        apiKey: '',
        apiKeyLast4: '',
        nickname: 'Empty',
        defaultModel: 'm',
        isActive: true,
      })
      .returning();

    if (!legacy || !alreadyEnc || !empty) throw new Error('seed rows');

    await migrateLlmKeysToEncrypted(db as TestDb);

    const [legacyAfter] = await (db as TestDb)
      .select({ apiKey: entityLlmKeys.apiKey, apiKeyLast4: entityLlmKeys.apiKeyLast4 })
      .from(entityLlmKeys)
      .where(eq(entityLlmKeys.id, legacy.id));
    expect(isEncrypted(legacyAfter!.apiKey)).toBe(true);
    expect(decrypt(legacyAfter!.apiKey)).toBe('sk-legacy-1234');
    expect(legacyAfter!.apiKeyLast4).toBe('1234');

    const [alreadyAfter] = await (db as TestDb)
      .select({ apiKey: entityLlmKeys.apiKey, apiKeyLast4: entityLlmKeys.apiKeyLast4 })
      .from(entityLlmKeys)
      .where(eq(entityLlmKeys.id, alreadyEnc.id));
    expect(decrypt(alreadyAfter!.apiKey)).toBe('sk-already-9999');
    expect(alreadyAfter!.apiKeyLast4).toBe('9999');

    const [emptyAfter] = await (db as TestDb)
      .select({ apiKey: entityLlmKeys.apiKey, apiKeyLast4: entityLlmKeys.apiKeyLast4 })
      .from(entityLlmKeys)
      .where(eq(entityLlmKeys.id, empty.id));
    expect(emptyAfter!.apiKey).toBe('');
    expect(emptyAfter!.apiKeyLast4).toBe('');
  });
});
