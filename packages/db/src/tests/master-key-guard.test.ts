// master-key-guard.test.ts
// Unit tests for packages/db/src/queries/master-key-guard.ts (I-6)
// Uses pglite (spinUpTestDb) so no external DB is needed.

import { describe, it, expect, beforeAll, afterAll, afterEach } from 'vitest';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { eq } from 'drizzle-orm';
import {
  encrypt,
  _setMasterKeyForTests,
  _resetMasterKeyCacheForTests,
} from '@nodal-agents/secrets';
import { spinUpTestDb, seedMinimal } from './helpers.ts';
import type { TestDb } from './helpers.ts';
import { credentials, entityLlmKeys } from '../schema/index.ts';
import { assertMasterKeyRestorable } from '../queries/master-key-guard.ts';

let db: TestDb;
let userId: string;
let entityId: string;

beforeAll(async () => {
  _setMasterKeyForTests(Buffer.alloc(32, 0x11));
  const result = await spinUpTestDb();
  db = result.db;
  const seed = await seedMinimal(db);
  userId = seed.userId;
  entityId = seed.entityId;
});

afterAll(() => {
  _resetMasterKeyCacheForTests();
});

// ── tmp key-path helpers ──────────────────────────────────────────────────────

let tmpDir: string;

afterEach(() => {
  if (tmpDir) rmSync(tmpDir, { recursive: true, force: true });
});

function missingKeyPath(): string {
  tmpDir = mkdtempSync(join(tmpdir(), 'nodalai-masterkey-test-'));
  return join(tmpDir, 'secrets.key'); // never written — simulates "missing"
}

function presentKeyPath(): string {
  tmpDir = mkdtempSync(join(tmpdir(), 'nodalai-masterkey-test-'));
  const path = join(tmpDir, 'secrets.key');
  writeFileSync(path, Buffer.alloc(32, 0x22).toString('base64'), 'utf-8');
  return path;
}

describe('assertMasterKeyRestorable', () => {
  it('is a no-op when the key file is present, regardless of DB content', async () => {
    await expect(
      assertMasterKeyRestorable(db, { keyPath: presentKeyPath() }),
    ).resolves.toBeUndefined();
  });

  it('is a no-op when the key is missing but the DB has nothing encrypted (fresh install)', async () => {
    // seedMinimal's entity_llm_keys row has apiKey: '' — not encrypted, no
    // credentials rows exist yet.
    await expect(
      assertMasterKeyRestorable(db, { keyPath: missingKeyPath() }),
    ).resolves.toBeUndefined();
  });

  it('throws when the key is missing and a credential row exists', async () => {
    await db.insert(credentials).values({
      ownerUserId: userId,
      name: 'test-cred',
      type: 'google-oauth',
      payload: encrypt(JSON.stringify({ accessToken: 'x' })),
    });

    await expect(assertMasterKeyRestorable(db, { keyPath: missingKeyPath() })).rejects.toThrow(
      /OAuth credential/,
    );

    // cleanup so later tests in this file aren't affected
    await db.delete(credentials).where(eq(credentials.ownerUserId, userId));
  });

  it('throws when the key is missing and an encrypted LLM key exists', async () => {
    await db
      .update(entityLlmKeys)
      .set({ apiKey: encrypt('sk-test-secret') })
      .where(eq(entityLlmKeys.entityId, entityId));

    await expect(assertMasterKeyRestorable(db, { keyPath: missingKeyPath() })).rejects.toThrow(
      /LLM API key/,
    );

    // restore to empty so it doesn't leak into other tests
    await db.update(entityLlmKeys).set({ apiKey: '' }).where(eq(entityLlmKeys.entityId, entityId));
  });

  it('does not flag a plaintext (pre-Brique-26) LLM key as encrypted', async () => {
    await db
      .update(entityLlmKeys)
      .set({ apiKey: 'sk-plaintext-legacy' })
      .where(eq(entityLlmKeys.entityId, entityId));

    await expect(
      assertMasterKeyRestorable(db, { keyPath: missingKeyPath() }),
    ).resolves.toBeUndefined();

    await db.update(entityLlmKeys).set({ apiKey: '' }).where(eq(entityLlmKeys.entityId, entityId));
  });
});
