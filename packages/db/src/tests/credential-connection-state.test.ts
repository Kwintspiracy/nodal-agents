// credential-connection-state.test.ts — a credential's state is written where
// it is learnt (the token refresh) and stops the next request to a provider
// that ended the grant. Fakes at the transport (`fetch`), the real test DB.

import { describe, it, expect, beforeAll, afterAll, afterEach, vi } from 'vitest';
import { randomBytes } from 'node:crypto';
import { eq } from 'drizzle-orm';
import {
  _setMasterKeyForTests,
  _resetMasterKeyCacheForTests,
  encrypt,
  decrypt,
} from '@nodal-agents/secrets';
import { ConnectionUnavailableError, type CredentialType } from '@nodal-agents/shared';
import type { PGlite } from '@electric-sql/pglite';
import { spinUpTestDb, seedMinimal } from './helpers.ts';
import type { TestDb } from './helpers.ts';
import { credentials, connectionStates } from '../schema/index.ts';
import { getDecryptedCredentialById, refreshAndPersistCredential } from '../queries/credentials.ts';
import {
  readConnectionState,
  readConnectionStates,
  recordConnectionState,
} from '../queries/connection-states.ts';
import { REDACTED_TEXT, connectionKey } from '@nodal-agents/shared';
import { fakeSecret } from '@nodal-agents/test-kit';

let db: TestDb;
let pg: PGlite;
let userId: string;

beforeAll(async () => {
  _setMasterKeyForTests(randomBytes(32));
  ({ db, pg } = await spinUpTestDb());
  userId = (await seedMinimal(db)).userId;
  // A failure injected between the provider's answer and its storage: the
  // first `failBudget` UPDATEs of a credential raise. A sequence is not
  // transactional, so the count survives the rollback of the failed write.
  await pg.exec(`
    CREATE TABLE fail_budget (n int NOT NULL);
    INSERT INTO fail_budget VALUES (0);
    CREATE SEQUENCE fail_seq;
    CREATE FUNCTION fail_credential_update() RETURNS trigger AS $$
    BEGIN
      IF nextval('fail_seq') <= (SELECT n FROM fail_budget) THEN
        RAISE EXCEPTION 'injected storage failure';
      END IF;
      RETURN NEW;
    END $$ LANGUAGE plpgsql;
    CREATE TRIGGER credentials_fail_update BEFORE UPDATE ON credentials
      FOR EACH ROW EXECUTE FUNCTION fail_credential_update();
  `);
});

afterAll(() => {
  _resetMasterKeyCacheForTests();
});

afterEach(async () => {
  vi.restoreAllMocks();
  await pg.exec(`UPDATE fail_budget SET n = 0; SELECT setval('fail_seq', 1, false);`);
});

async function failNextCredentialUpdates(n: number): Promise<void> {
  await pg.exec(`UPDATE fail_budget SET n = ${n}; SELECT setval('fail_seq', 1, false);`);
}

async function insertExpiredCredential(
  type: CredentialType = 'google-oauth',
  overrides: Record<string, unknown> = {},
): Promise<string> {
  const payload = {
    accessToken: 'old-access',
    refreshToken: 'old-refresh',
    expiresAt: new Date(Date.now() - 60_000).toISOString(),
    clientId: 'client-id',
    clientSecret: 'client-secret',
    scopes: 'scope-a',
    accountName: 'someone@example.test',
    ...overrides,
  };
  const [row] = await db
    .insert(credentials)
    .values({
      ownerUserId: userId,
      name: `cred-${randomBytes(4).toString('hex')}`,
      type,
      payload: encrypt(JSON.stringify(payload)),
    })
    .returning();
  return row!.id;
}

function tokenResponse(body: Record<string, unknown>, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'Content-Type': 'application/json' },
  });
}

async function storedPayload(id: string): Promise<Record<string, unknown>> {
  const [row] = await db.select().from(credentials).where(eq(credentials.id, id));
  return JSON.parse(decrypt(row!.payload)) as Record<string, unknown>;
}

describe('a credential has a state, written by the refresh @cap:connecter-un-service/moteur', () => {
  it('a grant the provider ended marks the credential needs_reauth, and no further request is sent', async () => {
    const id = await insertExpiredCredential();
    const fetchMock = vi
      .spyOn(globalThis, 'fetch')
      .mockResolvedValue(
        tokenResponse(
          { error: 'invalid_grant', error_description: 'Token has been expired or revoked.' },
          400,
        ),
      );

    const first = await getDecryptedCredentialById(db, id).catch((e: unknown) => e);
    expect(first).toBeInstanceOf(ConnectionUnavailableError);
    const state = await readConnectionState(db, { kind: 'credential', id });
    expect(state).toMatchObject({
      state: 'needs_reauth',
      cause: 'grant_refused',
      detail: '400 invalid_grant Token has been expired or revoked.',
    });
    expect(state.observedAt).toBeInstanceOf(Date);
    expect(fetchMock.mock.calls.map((c) => String(c[0]))).toEqual([
      'https://oauth2.googleapis.com/token',
    ]);

    // The next use (the next job, the next tool call) reads the state and
    // sends nothing to the token endpoint.
    const second = await getDecryptedCredentialById(db, id).catch((e: unknown) => e);
    expect(second).toBeInstanceOf(ConnectionUnavailableError);
    expect((second as ConnectionUnavailableError).connection.cause).toBe('grant_refused');
    expect(fetchMock.mock.calls).toHaveLength(1);
  });

  it('the same rule for a second provider (Microsoft): invalid_grant is needs_reauth', async () => {
    const id = await insertExpiredCredential('microsoft-oauth');
    const fetchMock = vi
      .spyOn(globalThis, 'fetch')
      .mockResolvedValue(
        tokenResponse({ error: 'invalid_grant', error_description: 'AADSTS70043' }, 400),
      );

    await expect(getDecryptedCredentialById(db, id)).rejects.toBeInstanceOf(
      ConnectionUnavailableError,
    );
    expect(await readConnectionState(db, { kind: 'credential', id })).toMatchObject({
      state: 'needs_reauth',
      cause: 'grant_refused',
    });
    expect(String(fetchMock.mock.calls[0]![0])).toContain('login.microsoftonline.com');
  });

  it('a refusal of the app’s own credentials (invalid_client, an expired secret) is its own cause', async () => {
    const id = await insertExpiredCredential('microsoft-oauth');
    vi.spyOn(globalThis, 'fetch').mockResolvedValue(
      tokenResponse({ error: 'invalid_client', error_description: 'client secret expired' }, 401),
    );
    await expect(getDecryptedCredentialById(db, id)).rejects.toBeInstanceOf(
      ConnectionUnavailableError,
    );
    expect(await readConnectionState(db, { kind: 'credential', id })).toMatchObject({
      state: 'needs_reauth',
      cause: 'client_refused',
    });
  });

  it('a 409 after a recent refresh (a provider that rotates) does not end the grant, and the stored refresh token is kept', async () => {
    const id = await insertExpiredCredential('airtable-oauth');
    vi.spyOn(globalThis, 'fetch').mockResolvedValueOnce(tokenResponse({ error: 'conflict' }, 409));
    await expect(getDecryptedCredentialById(db, id)).rejects.toBeInstanceOf(
      ConnectionUnavailableError,
    );
    const state = await readConnectionState(db, { kind: 'credential', id });
    expect(state).toMatchObject({ state: 'unreachable', cause: 'provider_unavailable' });
    expect(state.retryAfter!.getTime()).toBeGreaterThan(Date.now());
    expect((await storedPayload(id))['refreshToken']).toBe('old-refresh');
  });

  it('an unreachable token endpoint is unreachable with a retry time, and is not asked again before it', async () => {
    const id = await insertExpiredCredential();
    const fetchMock = vi.spyOn(globalThis, 'fetch').mockRejectedValue(
      Object.assign(new TypeError('fetch failed'), {
        cause: Object.assign(new Error('connect ECONNREFUSED 127.0.0.1:443'), {
          code: 'ECONNREFUSED',
        }),
      }),
    );

    await expect(getDecryptedCredentialById(db, id)).rejects.toBeInstanceOf(
      ConnectionUnavailableError,
    );
    const state = await readConnectionState(db, { kind: 'credential', id });
    expect(state).toMatchObject({ state: 'unreachable', cause: 'network' });
    expect(state.retryAfter!.getTime()).toBeGreaterThan(Date.now());

    await expect(getDecryptedCredentialById(db, id)).rejects.toBeInstanceOf(
      ConnectionUnavailableError,
    );
    expect(fetchMock.mock.calls).toHaveLength(1);

    // Once the retry time has passed, the next use tries again.
    await db
      .update(connectionStates)
      .set({ retryAfter: new Date(Date.now() - 1000) })
      .where(eq(connectionStates.sourceId, id));
    fetchMock.mockResolvedValueOnce(
      tokenResponse({ access_token: 'new-access', expires_in: 3600 }),
    );
    const fresh = await getDecryptedCredentialById(db, id);
    expect(fresh!.payload.accessToken).toBe('new-access');
    expect(await readConnectionState(db, { kind: 'credential', id })).toMatchObject({
      state: 'working',
      cause: 'succeeded',
    });
  });

  it('a payload that cannot be decrypted is broken, and the token endpoint is never called', async () => {
    const [row] = await db
      .insert(credentials)
      .values({
        ownerUserId: userId,
        name: 'unreadable',
        type: 'google-oauth',
        payload: 'enc:v1:aa:bb:cc',
      })
      .returning();
    const fetchMock = vi.spyOn(globalThis, 'fetch');
    const err = await getDecryptedCredentialById(db, row!.id).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(ConnectionUnavailableError);
    expect((err as ConnectionUnavailableError).connection).toMatchObject({
      state: 'broken',
      cause: 'undecryptable',
    });
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('"Refresh now" always tries, even on needs_reauth, and a success puts the credential back to working', async () => {
    const id = await insertExpiredCredential();
    vi.spyOn(globalThis, 'fetch').mockResolvedValueOnce(
      tokenResponse({ error: 'invalid_grant' }, 400),
    );
    await expect(getDecryptedCredentialById(db, id)).rejects.toBeInstanceOf(
      ConnectionUnavailableError,
    );

    vi.spyOn(globalThis, 'fetch').mockResolvedValueOnce(
      tokenResponse({ access_token: 'after-reconnect', expires_in: 3600 }),
    );
    const refreshed = await refreshAndPersistCredential(db, id);
    expect(refreshed.accessToken).toBe('after-reconnect');
    expect(await readConnectionState(db, { kind: 'credential', id })).toMatchObject({
      state: 'working',
      cause: 'succeeded',
    });
    const usable = await getDecryptedCredentialById(db, id);
    expect(usable!.payload.accessToken).toBe('after-reconnect');
  });
});

describe('a rotated refresh token is never lost', () => {
  it('a storage failure between the answer and its write is retried: the new refresh token is stored and used', async () => {
    const id = await insertExpiredCredential('airtable-oauth');
    vi.spyOn(globalThis, 'fetch').mockResolvedValueOnce(
      tokenResponse({
        access_token: 'rotated-access',
        expires_in: 3600,
        refresh_token: 'rotated-refresh',
      }),
    );
    await failNextCredentialUpdates(1);

    const result = await getDecryptedCredentialById(db, id);
    expect(result!.payload.accessToken).toBe('rotated-access');
    const stored = await storedPayload(id);
    expect(stored['refreshToken']).toBe('rotated-refresh');
    expect(stored['accessToken']).toBe('rotated-access');
    expect(await readConnectionState(db, { kind: 'credential', id })).toMatchObject({
      state: 'working',
    });
  });

  it('a write that keeps failing after a rotation records rotation_lost, never working on a dead token', async () => {
    const id = await insertExpiredCredential('airtable-oauth');
    vi.spyOn(globalThis, 'fetch').mockResolvedValueOnce(
      tokenResponse({
        access_token: 'rotated-access',
        expires_in: 3600,
        refresh_token: 'rotated-refresh',
      }),
    );
    await failNextCredentialUpdates(2);

    const err = await getDecryptedCredentialById(db, id).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(ConnectionUnavailableError);
    expect(await readConnectionState(db, { kind: 'credential', id })).toMatchObject({
      state: 'needs_reauth',
      cause: 'rotation_lost',
    });
  });

  it('without rotation the stored refresh token stays valid: the new access token is still used', async () => {
    const id = await insertExpiredCredential();
    vi.spyOn(globalThis, 'fetch').mockResolvedValueOnce(
      tokenResponse({ access_token: 'unrotated-access', expires_in: 3600 }),
    );
    await failNextCredentialUpdates(2);

    const result = await getDecryptedCredentialById(db, id);
    expect(result!.payload.accessToken).toBe('unrotated-access');
    expect((await storedPayload(id))['refreshToken']).toBe('old-refresh');
  });
});

describe('what a provider said of a connection leaves through the outbound seam @cap:connecter-un-service/moteur', () => {
  const KEY = fakeSecret('github', 'Ab3Cd5Ef7Gh9Ij1Kl3Mn5Op7Qr9St1Uv3Wx5Yz');

  it.each(['connector', 'mcp_server', 'channel'] as const)(
    'a %s whose failure detail holds a credential is read with it masked, the rest of the words kept',
    async (kind) => {
      const ref = { kind, id: `${kind}-${randomBytes(4).toString('hex')}` };
      await recordConnectionState(db, ref, {
        state: 'needs_reauth',
        cause: 'grant_refused',
        detail: `HTTP 401: token ${KEY} is not valid for this resource`,
        observedAt: new Date(),
        retryAfter: null,
      });
      const read = (await readConnectionStates(db, [ref])).get(connectionKey(ref));
      expect(read?.detail).toBe(`HTTP 401: token ${REDACTED_TEXT} is not valid for this resource`);
      expect((await readConnectionState(db, ref)).detail).not.toContain(KEY);
      // The row keeps what was learnt: only what leaves is masked.
      const [row] = await db
        .select({ detail: connectionStates.detail })
        .from(connectionStates)
        .where(eq(connectionStates.sourceId, ref.id));
      expect(row?.detail).toContain(KEY);
    },
  );
});
