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
import {
  credentials,
  entityLlmKeys,
  connectors,
  mcpServers,
  channelBindings,
  agents,
  webhookTriggers,
} from '../schema/index.ts';
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

  // SEC-4: the guard must also cover connectors + mcp servers, or an install
  // whose ONLY secret is one of those would still get a silent re-mint.
  it('throws when the key is missing and an encrypted connector exists', async () => {
    await db.insert(connectors).values({
      entityId,
      name: 'test-conn',
      slug: 'test-conn',
      apiKey: encrypt('sk-connector-secret'),
    });

    await expect(assertMasterKeyRestorable(db, { keyPath: missingKeyPath() })).rejects.toThrow(
      /connector API key/,
    );

    await db.delete(connectors).where(eq(connectors.entityId, entityId));
  });

  it('throws when the key is missing and an MCP server has an encrypted env value', async () => {
    await db.insert(mcpServers).values({
      entityId,
      name: 'test-mcp',
      slug: 'test-mcp',
      transport: 'stdio',
      command: 'npx',
      envVars: { TOKEN: encrypt('ghp_secret') },
    });

    await expect(assertMasterKeyRestorable(db, { keyPath: missingKeyPath() })).rejects.toThrow(
      /MCP server secret/,
    );

    await db.delete(mcpServers).where(eq(mcpServers.entityId, entityId));
  });
  // ── Channel + webhook secrets (encrypted at rest 2026-08-28) ──────────────
  //
  // Same SEC-4 reasoning as the connector/MCP cases above: an install whose
  // ONLY secrets are a Discord bot token, a Telegram token or a webhook secret
  // would otherwise get a SILENT key re-mint on boot, leaving every bot and
  // webhook permanently undecryptable with no warning. Found by codex review
  // on PR #40 — the columns were encrypted without being added to this guard.

  it('throws when the key is missing and an encrypted channel binding exists', async () => {
    const seed = await seedMinimal(db);
    await db.insert(channelBindings).values({
      entityId,
      agentId: seed.agentId,
      channel: 'discord',
      credentials: encrypt(JSON.stringify({ botToken: 'discord-secret' })),
    });

    await expect(assertMasterKeyRestorable(db, { keyPath: missingKeyPath() })).rejects.toThrow(
      /channel credential/,
    );

    await db.delete(channelBindings).where(eq(channelBindings.agentId, seed.agentId));
  });

  it('does not flag a legacy PLAINTEXT channel binding as encrypted', async () => {
    // A pre-migration row does not depend on the key at all, so it must not
    // block a boot that would otherwise legitimately mint a fresh one.
    const seed = await seedMinimal(db);
    await db.insert(channelBindings).values({
      entityId,
      agentId: seed.agentId,
      channel: 'discord',
      credentials: JSON.stringify({ botToken: 'plaintext-legacy' }),
    });

    await expect(
      assertMasterKeyRestorable(db, { keyPath: missingKeyPath() }),
    ).resolves.toBeUndefined();

    await db.delete(channelBindings).where(eq(channelBindings.agentId, seed.agentId));
  });

  it('throws when the key is missing and an encrypted telegram bot token exists', async () => {
    const seed = await seedMinimal(db);
    await db
      .update(agents)
      .set({ telegramBotToken: encrypt('123456:TELEGRAM') })
      .where(eq(agents.id, seed.agentId));

    await expect(assertMasterKeyRestorable(db, { keyPath: missingKeyPath() })).rejects.toThrow(
      /channel credential/,
    );

    await db.update(agents).set({ telegramBotToken: null }).where(eq(agents.id, seed.agentId));
  });

  it('throws when the key is missing and an encrypted webhook secret exists', async () => {
    const seed = await seedMinimal(db);
    await db.insert(webhookTriggers).values({
      entityId,
      agentId: seed.agentId,
      name: 'guard-hook',
      slug: `guard-hook-${Date.now()}`,
      taskTemplate: 'x',
      secret: encrypt('a'.repeat(32)),
    });

    await expect(assertMasterKeyRestorable(db, { keyPath: missingKeyPath() })).rejects.toThrow(
      /webhook secret/,
    );

    await db.delete(webhookTriggers).where(eq(webhookTriggers.agentId, seed.agentId));
  });
});
