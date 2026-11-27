// @vitest-environment node
// oauth-start.test.ts — POST /api/oauth/[provider]/start asks the provider for
// the rights of the connector being connected.
//
// The path names the credential type (the OAuth client, hence the registered
// redirect URI); the body names the connector. Every assertion reads the
// authorization URL the route really built, on several providers: Google
// (five connectors on one credential type), Microsoft and Airtable (one each),
// Notion (no scopes at all).

import { describe, it, expect, beforeAll, afterAll, vi } from 'vitest';
import { randomBytes } from 'node:crypto';
import {
  _setMasterKeyForTests,
  _resetMasterKeyCacheForTests,
  encrypt,
} from '@nodal-agents/secrets';
import { spinUpTestDb, seedMinimal } from '@nodal-agents/db/test-utils';
import type { TestDb } from '@nodal-agents/db/test-utils';
import { credentials, users } from '@nodal-agents/db';
import { getOAuthProvider } from '@nodal-agents/shared';

let _testDb: TestDb | null = null;
let _testUserId = 'placeholder-user-id';
let _testEntityId = 'placeholder-entity-id';

vi.mock('server-only', () => ({}));
vi.mock('next/cache', () => ({ revalidatePath: vi.fn() }));

vi.mock('@/lib/server.ts', () => ({
  getDb: () => {
    if (!_testDb) throw new Error('Test DB not initialized');
    return _testDb;
  },
  getAuthProvider: () => ({ getSession: async () => null, handleAuthRequest: null }),
  requireAuth: vi.fn().mockImplementation(async () => ({
    userId: _testUserId,
    entityId: _testEntityId,
  })),
  requireAuthWithEntity: vi.fn(),
  requireUserWithEntity: vi.fn(),
}));

beforeAll(async () => {
  _setMasterKeyForTests(randomBytes(32));
  const { db } = await spinUpTestDb();
  _testDb = db;
  const seed = await seedMinimal(db);
  _testUserId = seed.userId;
  _testEntityId = seed.entityId;
});

afterAll(() => {
  _resetMasterKeyCacheForTests();
  _testDb = null;
});

const ORIGIN = 'http://localhost:3000';
const DRIVE = 'https://www.googleapis.com/auth/drive';

async function start(
  path: string,
  body: Record<string, string>,
): Promise<{ status: number; location: URL | null; error: string | null; cookie: string }> {
  const { POST } = await import('@/app/api/oauth/[provider]/start/route.ts');
  const res = await POST(
    new Request(`${ORIGIN}/api/oauth/${path}/start`, {
      method: 'POST',
      headers: { 'content-type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams(body).toString(),
    }),
    { params: Promise.resolve({ provider: path }) },
  );
  const location = res.headers.get('location');
  const error =
    res.status >= 400 ? (((await res.json()) as { error?: string }).error ?? null) : null;
  return {
    status: res.status,
    location: location ? new URL(location) : null,
    error,
    cookie: res.headers.get('set-cookie') ?? '',
  };
}

const CLIENT = { clientId: 'cid', clientSecret: 'csecret' };

function scopeParam(location: URL | null): string[] {
  return (location?.searchParams.get('scope') ?? '').split(' ').filter(Boolean);
}

async function insertCredential(opts: {
  ownerUserId: string;
  type: string;
  scopes: string;
  clientId?: string;
}): Promise<string> {
  const [row] = await _testDb!
    .insert(credentials)
    .values({
      ownerUserId: opts.ownerUserId,
      name: 'Existing',
      type: opts.type,
      payload: encrypt(
        JSON.stringify({
          clientId: opts.clientId ?? 'stored-cid',
          clientSecret: 'stored-secret',
          refreshToken: 'rt',
          accessToken: 'at',
          expiresAt: null,
          scopes: opts.scopes,
          accountName: 'someone@example.com',
          tokenUrl: 'https://oauth2.googleapis.com/token',
        }),
      ),
    })
    .returning({ id: credentials.id });
  return row!.id;
}

describe('POST /api/oauth/[provider]/start — the connector decides the scopes @cap:connecter-un-service/moteur', () => {
  it("a start made for the Gmail card asks Google for Gmail's rights, not Drive's", async () => {
    const r = await start('google-oauth', { ...CLIENT, connector: 'gmail' });
    expect(r.status).toBe(302);
    expect(r.location!.origin).toBe('https://accounts.google.com');
    const asked = scopeParam(r.location);
    expect(asked).toEqual([...getOAuthProvider('gmail')!.scopes]);
    expect(asked).toContain('https://www.googleapis.com/auth/gmail.readonly');
    expect(asked).not.toContain(DRIVE);
    // The redirect URI stays the one registered for the credential type.
    expect(r.location!.searchParams.get('redirect_uri')).toBe(
      `${ORIGIN}/api/oauth/google-oauth/callback`,
    );
  });

  it("a start made for the Calendar card asks for Calendar's rights", async () => {
    const r = await start('google-oauth', { ...CLIENT, connector: 'google-calendar' });
    expect(scopeParam(r.location)).toEqual([...getOAuthProvider('google-calendar')!.scopes]);
  });

  it('a start that names no connector is refused, loudly', async () => {
    const r = await start('google-oauth', { ...CLIENT });
    expect(r.status).toBe(400);
    expect(r.error).toMatch(/connector is required/);
    expect(r.location).toBeNull();
  });

  it('a connector of another credential type is refused (no fall-back to a provider of the type)', async () => {
    const r = await start('google-oauth', { ...CLIENT, connector: 'outlook-mail' });
    expect(r.status).toBe(400);
    expect(r.error).toContain("Connector 'outlook-mail' does not authorise through 'google-oauth'");
  });

  it('a path that is a connector slug rather than a credential type is refused', async () => {
    const r = await start('google-drive', { ...CLIENT, connector: 'google-drive' });
    expect(r.status).toBe(400);
    expect(r.error).toContain('Unknown OAuth provider');
  });

  it("Microsoft: a start for Outlook asks Microsoft for Outlook's entry", async () => {
    const r = await start('microsoft-oauth', { ...CLIENT, connector: 'outlook-mail' });
    expect(r.status).toBe(302);
    expect(r.location!.host).toBe('login.microsoftonline.com');
    expect(scopeParam(r.location)).toEqual([...getOAuthProvider('outlook-mail')!.scopes]);
  });

  it('a provider with a single connector (Airtable) asks for that entry, unchanged', async () => {
    const r = await start('airtable-oauth', { ...CLIENT, connector: 'airtable-oauth' });
    expect(r.status).toBe(302);
    expect(scopeParam(r.location)).toEqual([...getOAuthProvider('airtable-oauth')!.scopes]);
  });

  it('a provider without scopes (Notion) sends no scope parameter', async () => {
    const r = await start('notion-oauth', { ...CLIENT, connector: 'notion-oauth' });
    expect(r.status).toBe(302);
    expect(r.location!.searchParams.has('scope')).toBe(false);
  });

  it("adding access asks for the connector's rights ON TOP of what the credential holds, with its own client", async () => {
    const credentialId = await insertCredential({
      ownerUserId: _testUserId,
      type: 'google-oauth',
      scopes: `${DRIVE} openid`,
      clientId: 'the-stored-client',
    });
    const r = await start('google-oauth', { connector: 'gmail', credentialId });
    expect(r.status).toBe(302);
    const asked = scopeParam(r.location);
    for (const s of getOAuthProvider('gmail')!.scopes) expect(asked).toContain(s);
    expect(asked).toContain(DRIVE);
    expect(r.location!.searchParams.get('client_id')).toBe('the-stored-client');
    // The callback learns which credential to update from the signed cookie.
    const { verifyStateCookie } = await import('@/lib/oauth-state.ts');
    const cookieValue = /nodalai_oauth_state=([^;]+)/.exec(r.cookie)![1]!;
    const state = verifyStateCookie(cookieValue)!;
    expect(state.credentialId).toBe(credentialId);
    expect(state.connector).toBe('gmail');
    expect(state.requestedScopes.split(' ')).toEqual(asked);
  });

  it("adding access to another person's credential is refused", async () => {
    const [other] = await _testDb!
      .insert(users)
      .values({ email: `other-${Date.now()}@example.com`, name: 'Other' })
      .returning({ id: users.id });
    const credentialId = await insertCredential({
      ownerUserId: other!.id,
      type: 'google-oauth',
      scopes: DRIVE,
    });
    const r = await start('google-oauth', { connector: 'gmail', credentialId });
    expect(r.status).toBe(404);
  });

  it('a new credential still needs its client id and secret', async () => {
    const r = await start('google-oauth', { connector: 'gmail', clientId: 'cid' });
    expect(r.status).toBe(400);
    expect(r.error).toBe('Client secret is required');
  });
});
