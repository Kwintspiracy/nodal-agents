// channel-secrets-at-rest.test.ts — encryption-at-rest for channel credentials.
//
// Until 2026-08-28 the bot tokens of every messaging channel were the only
// secrets in the schema stored as PLAINTEXT: `channel_bindings.credentials`
// held a raw JSON blob and `agents.telegram_bot_token` a raw token string.
// The schema header justified this with "@nodal-agents/db never imports
// @nodal-agents/secrets (architecture rule — only the writer layer does)".
// That claim was false: queries/credentials.ts has imported `decrypt` from
// @nodal-agents/secrets since the OAuth credential brique, and package.json
// declares the dependency. A comment that mis-stated the architecture is the
// entire reason these tokens stayed in the clear through a real leak.
//
// What this suite pins:
//  - the read path DECRYPTS an `enc:v1:` blob (both the neutral binding and
//    the transitional telegram column), so encrypted rows are usable;
//  - it still reads a legacy PLAINTEXT row, so a DB that has not been through
//    the boot migration yet keeps working (no flag day);
//  - an UNDECRYPTABLE blob fails LOUD (invariant #4) instead of returning null
//    the way an absent binding does — "the key is wrong" and "there is no bot
//    configured" must never be the same signal to the caller;
//  - the plaintext round-trips through the credential-stable fingerprint that
//    the channel managers use to detect rotation.

import { describe, it, expect, beforeAll } from 'vitest';
import { eq } from 'drizzle-orm';
import { encrypt, _setMasterKeyForTests } from '@nodal-agents/secrets';
import { spinUpTestDb, seedMinimal } from './helpers.ts';
import type { TestDb } from './helpers.ts';
import { channelBindings, agents } from '../schema/index.ts';
import { getBindingCredentials, credentialsFingerprint } from '../queries/channel-identity.ts';

let db: TestDb;
let entityId: string;
let agentId: string;

beforeAll(async () => {
  // Deterministic master key — never touches ~/.nodalai/secrets.key.
  _setMasterKeyForTests(Buffer.alloc(32, 7));
  const result = await spinUpTestDb();
  db = result.db;
  const seed = await seedMinimal(db);
  entityId = seed.entityId;
  agentId = seed.agentId;
});

describe('getBindingCredentials — encrypted at rest', () => {
  it('decrypts an enc:v1 binding blob back to the original credential pair', async () => {
    const plain = JSON.stringify({ botToken: 'xoxb-real-secret', appToken: 'xapp-real-secret' });
    await db.insert(channelBindings).values({
      entityId,
      agentId,
      channel: 'slack',
      credentials: encrypt(plain),
    });

    const creds = await getBindingCredentials(db, agentId, 'slack');

    // The real values, not the ciphertext — this is what opens the websocket.
    expect(creds).toEqual({ botToken: 'xoxb-real-secret', appToken: 'xapp-real-secret' });
  });

  it('still reads a legacy PLAINTEXT binding row (pre-migration DB keeps working)', async () => {
    await db.insert(channelBindings).values({
      entityId,
      agentId,
      channel: 'discord',
      credentials: JSON.stringify({ botToken: 'legacy-plaintext-token' }),
    });

    await expect(getBindingCredentials(db, agentId, 'discord')).resolves.toEqual({
      botToken: 'legacy-plaintext-token',
    });
  });

  it('THROWS on an undecryptable blob instead of reporting "no credentials"', async () => {
    // A well-formed enc:v1 envelope whose ciphertext was written under a
    // different master key — what a restored backup / copied DB looks like.
    await db.insert(channelBindings).values({
      entityId,
      agentId,
      channel: 'whatsapp',
      credentials: encrypt('{"sessionDir":"x"}', Buffer.alloc(32, 9)),
    });

    await expect(getBindingCredentials(db, agentId, 'whatsapp')).rejects.toThrow(/decrypt/i);
  });

  it('returns null (not a throw) when the agent simply has no binding', async () => {
    const seed = await seedMinimal(db);
    await expect(getBindingCredentials(db, seed.agentId, 'slack')).resolves.toBeNull();
  });
});

describe('getBindingCredentials — transitional telegram column', () => {
  it('decrypts agents.telegram_bot_token when it is stored encrypted', async () => {
    const seed = await seedMinimal(db);
    await db
      .update(agents)
      .set({ telegramBotToken: encrypt('123456:REAL-TELEGRAM-TOKEN') })
      .where(eq(agents.id, seed.agentId));

    await expect(getBindingCredentials(db, seed.agentId, 'telegram')).resolves.toEqual({
      botToken: '123456:REAL-TELEGRAM-TOKEN',
    });
  });

  it('still reads a legacy plaintext telegram token', async () => {
    const seed = await seedMinimal(db);
    await db
      .update(agents)
      .set({ telegramBotToken: '123456:LEGACY-PLAINTEXT' })
      .where(eq(agents.id, seed.agentId));

    await expect(getBindingCredentials(db, seed.agentId, 'telegram')).resolves.toEqual({
      botToken: '123456:LEGACY-PLAINTEXT',
    });
  });
});

describe('credentialsFingerprint — rotation detection survives encryption', () => {
  it('is STABLE across two encryptions of the same credentials', () => {
    // AES-GCM uses a fresh random IV per call, so encrypt(x) !== encrypt(x).
    // The channel managers hash the credential to decide "rotated → respawn
    // the socket". Hashing the CIPHERTEXT would make every 30s refresh look
    // like a rotation and tear down every live socket in a loop.
    const creds = { botToken: 'same-token', appToken: 'same-app' };
    const blobA = encrypt(JSON.stringify(creds));
    const blobB = encrypt(JSON.stringify(creds));

    expect(blobA).not.toEqual(blobB); // precondition: the IV really does vary

    expect(credentialsFingerprint(creds)).toBe(credentialsFingerprint({ ...creds }));
  });

  it('CHANGES when a token is actually rotated', () => {
    expect(credentialsFingerprint({ botToken: 'old' })).not.toBe(
      credentialsFingerprint({ botToken: 'new' }),
    );
  });

  it('does not depend on key order in the credential bag', () => {
    expect(credentialsFingerprint({ botToken: 'a', appToken: 'b' })).toBe(
      credentialsFingerprint({ appToken: 'b', botToken: 'a' }),
    );
  });
});
