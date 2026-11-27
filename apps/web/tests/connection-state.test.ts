// @vitest-environment node
/**
 * A connection's state, as the dashboard reads it: the same rows and the same
 * rule a job reads (`connection_states`, `connectorConnection`,
 * `connectorAccessFor`). Reconnect repairs the row it was clicked on. On a
 * real pglite database; providers faked at `fetch`.
 */
import { describe, it, expect, beforeAll, afterAll, afterEach, vi } from 'vitest';
import { randomBytes } from 'node:crypto';
import {
  _setMasterKeyForTests,
  _resetMasterKeyCacheForTests,
  encrypt,
} from '@nodal-agents/secrets';
import { spinUpTestDb, seedMinimal } from '@nodal-agents/db/test-utils';
import type { TestDb } from '@nodal-agents/db/test-utils';
import {
  agentConnectorAssignments,
  connectionStates,
  connectors,
  credentials,
  mcpServers,
  readConnectionState,
  recordConnectionState,
} from '@nodal-agents/db';
import { getOAuthProvider } from '@nodal-agents/shared';
import { listConnectorsAction, listMcpServersAction } from '../src/lib/actions.ts';
import { listCredentialsAction, refreshCredentialAction } from '../src/lib/credentials.ts';

let _testDb: TestDb | null = null;
let _testUserId = 'placeholder-user-id';
let _testEntityId = 'placeholder-entity-id';
let _agentId = 'placeholder-agent-id';

vi.mock('server-only', () => ({}));
vi.mock('next/cache', () => ({ revalidatePath: vi.fn() }));
vi.mock('next/headers', () => ({ headers: async () => new Headers() }));
vi.mock('next/navigation', () => ({
  redirect: (url: string) => {
    throw Object.assign(new Error(`NEXT_REDIRECT ${url}`), { redirectTo: url });
  },
}));
vi.mock('@/lib/server.ts', () => ({
  getDb: () => {
    if (!_testDb) throw new Error('Test DB not initialized');
    return _testDb;
  },
  getAuthProvider: () => ({
    getSession: async () => ({ userId: _testUserId, entityId: _testEntityId }),
    handleAuthRequest: null,
  }),
  requireAuth: vi.fn().mockImplementation(async () => ({
    userId: _testUserId,
    entityId: _testEntityId,
  })),
  requireAuthWithEntity: vi.fn(),
  requireUserWithEntity: vi.fn(),
  applyActiveEntity: vi.fn(async (session: unknown) => session),
  ACTIVE_ENTITY_COOKIE: 'nodalai_active_entity',
}));
vi.mock('@nodal-agents/auth', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@nodal-agents/auth')>();
  return {
    ...actual,
    requireAuth: vi.fn().mockImplementation(async () => ({
      userId: _testUserId,
      entityId: _testEntityId,
    })),
  };
});
vi.mock('../src/lib/cli-config.ts', () => ({
  NODALAI_CONFIG_PATH: '/tmp/test/config.json',
  readNodalaiConfig: vi.fn(),
  mergeNodalaiConfig: vi.fn(),
}));
vi.mock('@nodal-agents/adapter-mcp', () => ({ connectMcp: vi.fn() }));

beforeAll(async () => {
  _setMasterKeyForTests(randomBytes(32));
  const { db } = await spinUpTestDb();
  _testDb = db;
  const seed = await seedMinimal(db);
  _testUserId = seed.userId;
  _testEntityId = seed.entityId;
  _agentId = seed.agentId;
});

afterAll(() => {
  _resetMasterKeyCacheForTests();
  _testDb = null;
});

afterEach(async () => {
  vi.unstubAllGlobals();
  await _testDb!.delete(agentConnectorAssignments);
  await _testDb!.delete(connectors);
  await _testDb!.delete(mcpServers);
  await _testDb!.delete(connectionStates);
});

const GOOGLE_SCOPES = [
  ...getOAuthProvider('gmail')!.scopes,
  ...getOAuthProvider('google-drive')!.scopes,
].join(' ');

async function googleCredential(
  opts: { account?: string; expired?: boolean } = {},
): Promise<string> {
  const [row] = await _testDb!
    .insert(credentials)
    .values({
      ownerUserId: _testUserId,
      name: `Google ${randomBytes(3).toString('hex')}`,
      type: 'google-oauth',
      payload: encrypt(
        JSON.stringify({
          clientId: 'cid',
          clientSecret: 'cs',
          refreshToken: 'rt-old',
          accessToken: 'at-old',
          expiresAt: new Date(Date.now() + (opts.expired ? -60_000 : 3600_000)).toISOString(),
          scopes: GOOGLE_SCOPES,
          accountName: opts.account ?? 'owner@example.test',
          tokenUrl: 'https://oauth2.googleapis.com/token',
        }),
      ),
    })
    .returning();
  return row!.id;
}

async function connector(c: {
  slug: string;
  name: string;
  credentialId?: string | null;
  apiKey?: string;
  assign?: boolean;
}): Promise<string> {
  const [row] = await _testDb!
    .insert(connectors)
    .values({
      entityId: _testEntityId,
      slug: c.slug,
      name: c.name,
      authType: c.apiKey !== undefined ? 'api_key' : 'oauth2',
      active: true,
      ...(c.apiKey !== undefined
        ? { apiKey: encrypt(c.apiKey) }
        : { credentialId: c.credentialId ?? null }),
    })
    .returning();
  if (c.assign) {
    await _testDb!.insert(agentConnectorAssignments).values({
      agentId: _agentId,
      connectorId: row!.id,
      entityId: _testEntityId,
      enabledOperations: null,
    });
  }
  return row!.id;
}

async function instances() {
  const r = await listConnectorsAction();
  if (!r.ok) throw new Error(r.message);
  return new Map(r.data.instances.map((i) => [i.name, i]));
}

describe('the connectors page reads the state a job reads @cap:connecter-un-service/moteur', () => {
  it('each connector shows its own state, from its rows and what was learnt', async () => {
    const refused = await googleCredential({ account: 'refused@example.test' });
    await recordConnectionState(
      _testDb!,
      { kind: 'credential', id: refused },
      {
        state: 'needs_reauth',
        cause: 'grant_refused',
        detail: '400 invalid_grant',
        observedAt: new Date(),
        retryAfter: null,
      },
    );
    const fine = await googleCredential();
    const [unreadable] = await _testDb!
      .insert(credentials)
      .values({
        ownerUserId: _testUserId,
        name: 'Bad',
        type: 'google-oauth',
        payload: 'enc:v1:aa:bb:cc',
      })
      .returning();
    await connector({ slug: 'gmail', name: 'Refused mail', credentialId: refused });
    await connector({ slug: 'gmail', name: 'Fine mail', credentialId: fine });
    await connector({ slug: 'gmail', name: 'Orphan mail', credentialId: null });
    await connector({
      slug: 'google-drive',
      name: 'Unreadable drive',
      credentialId: unreadable!.id,
    });
    const flaky = await connector({ slug: 'tavily', name: 'Flaky search', apiKey: 'tvly-key' });
    await recordConnectionState(
      _testDb!,
      { kind: 'connector', id: flaky },
      {
        state: 'unreachable',
        cause: 'network',
        detail: 'ENOTFOUND',
        observedAt: new Date(),
        retryAfter: new Date(Date.now() + 60_000),
      },
    );

    const byName = await instances();
    expect(byName.get('Refused mail')!.connection).toMatchObject({
      state: 'needs_reauth',
      cause: 'grant_refused',
      detail: '400 invalid_grant',
    });
    expect(byName.get('Refused mail')!.access?.kind).toBe('needs_reauth');
    expect(byName.get('Fine mail')!.connection).toMatchObject({
      state: 'working',
      cause: 'not_checked',
    });
    expect(byName.get('Orphan mail')!.connection).toMatchObject({
      state: 'needs_reauth',
      cause: 'credential_removed',
    });
    expect(byName.get('Unreadable drive')!.connection).toMatchObject({
      state: 'broken',
      cause: 'undecryptable',
    });
    expect(byName.get('Flaky search')!.connection).toMatchObject({
      state: 'unreachable',
      cause: 'network',
    });
    // Unreachable still offers what the grant covers: a later attempt can work.
    expect(byName.get('Flaky search')!.access?.kind).toBe('unreachable');
  });

  it('the credentials page reads the credential state; the MCP page reads each server state and its own transport', async () => {
    const id = await googleCredential();
    await recordConnectionState(
      _testDb!,
      { kind: 'credential', id },
      {
        state: 'needs_reauth',
        cause: 'grant_refused',
        detail: null,
        observedAt: new Date(),
        retryAfter: null,
      },
    );
    const creds = await listCredentialsAction();
    if (!creds.ok) throw new Error(creds.message);
    expect(creds.data.find((c) => c.id === id)!.connection).toMatchObject({
      state: 'needs_reauth',
    });

    const [server] = await _testDb!
      .insert(mcpServers)
      .values({
        entityId: _testEntityId,
        name: 'My db',
        slug: 'my-db',
        transport: 'stdio',
        command: 'my-db-server',
      })
      .returning();
    await recordConnectionState(
      _testDb!,
      { kind: 'mcp_server', id: server!.id },
      {
        state: 'broken',
        cause: 'command_not_found',
        detail: 'spawn my-db-server ENOENT',
        observedAt: new Date(),
        retryAfter: null,
      },
    );
    const mcp = await listMcpServersAction();
    if (!mcp.ok) throw new Error(mcp.message);
    const row = mcp.data.instances.find((i) => i.id === server!.id)!;
    expect(row.transport).toBe('stdio');
    expect(row.connection).toMatchObject({ state: 'broken', cause: 'command_not_found' });
  });

  it('"Refresh now" on a refused grant says the state in words, never the raw provider body, and records it', async () => {
    const id = await googleCredential({ expired: true });
    vi.stubGlobal(
      'fetch',
      vi.fn().mockResolvedValue(
        new Response(JSON.stringify({ error: 'invalid_grant', error_description: 'Bad Request' }), {
          status: 400,
          headers: { 'content-type': 'application/json' },
        }),
      ),
    );
    const r = await refreshCredentialAction(id);
    expect(r.ok).toBe(false);
    if (r.ok) throw new Error('unreachable');
    expect(r.code).toBe('connection_needs_reauth');
    expect(r.message).toContain(
      'The provider no longer accepts this authorisation. Reconnect to authorise again.',
    );
    expect(r.message).not.toContain('refreshAndPersistCredential');
    expect(await readConnectionState(_testDb!, { kind: 'credential', id })).toMatchObject({
      state: 'needs_reauth',
      cause: 'grant_refused',
    });
  });
});

// ─── Reconnect ────────────────────────────────────────────────────────────────

const ORIGIN = 'http://localhost:3000';

async function callback(opts: {
  connector: string;
  credentialId?: string;
  returnTo: string;
  email: string;
}): Promise<string> {
  const { generatePkce, generateState, signStatePayload } = await import('@/lib/oauth-state.ts');
  const { codeVerifier } = generatePkce();
  const state = generateState();
  const requested = getOAuthProvider(opts.connector)!.scopes.join(' ');
  const cookie = signStatePayload({
    v: 1 as const,
    slug: 'google-oauth',
    entityId: _testEntityId,
    state,
    codeVerifier,
    clientId: 'cid',
    clientSecretEnc: encrypt('cs'),
    credentialType: 'google-oauth',
    connector: opts.connector,
    requestedScopes: requested,
    ...(opts.credentialId ? { credentialId: opts.credentialId } : {}),
    returnTo: opts.returnTo,
    createdAt: Date.now(),
  });
  vi.stubGlobal(
    'fetch',
    vi.fn().mockImplementation((url: string) =>
      Promise.resolve(
        String(url).includes('/token')
          ? new Response(
              JSON.stringify({
                access_token: 'at-new',
                refresh_token: 'rt-new',
                expires_in: 3600,
                scope: GOOGLE_SCOPES,
              }),
              { status: 200, headers: { 'content-type': 'application/json' } },
            )
          : new Response(JSON.stringify({ email: opts.email, name: 'Owner' }), {
              status: 200,
              headers: { 'content-type': 'application/json' },
            }),
      ),
    ),
  );
  const url = new URL(`${ORIGIN}/api/oauth/google-oauth/callback`);
  url.searchParams.set('code', 'AUTH_CODE');
  url.searchParams.set('state', state);
  const { GET } = await import('@/app/api/oauth/[provider]/callback/route.ts');
  const res = await GET(
    new Request(url, { headers: { cookie: `nodalai_oauth_state=${cookie}` } }),
    {
      params: Promise.resolve({ provider: 'google-oauth' }),
    },
  );
  expect(res.status).toBe(302);
  return res.headers.get('location') ?? '';
}

async function connectorRows() {
  return _testDb!
    .select({ id: connectors.id, credentialId: connectors.credentialId })
    .from(connectors);
}

describe('Reconnect repairs the row it was clicked on @cap:connecter-un-service/moteur', () => {
  it('a refused grant authorised again: the same credential, working, every connector on it repaired, none created', async () => {
    const id = await googleCredential({ account: 'owner@example.test' });
    const mail = await connector({ slug: 'gmail', name: 'Mail', credentialId: id, assign: true });
    const drive = await connector({
      slug: 'google-drive',
      name: 'Drive',
      credentialId: id,
      assign: true,
    });
    await recordConnectionState(
      _testDb!,
      { kind: 'credential', id },
      {
        state: 'needs_reauth',
        cause: 'grant_refused',
        detail: '400 invalid_grant',
        observedAt: new Date(),
        retryAfter: null,
      },
    );
    const credentialsBefore = await _testDb!.select({ id: credentials.id }).from(credentials);

    const location = await callback({
      connector: 'gmail',
      credentialId: id,
      returnTo: '/connectors?connected=gmail',
      email: 'owner@example.test',
    });
    expect(new URL(location, ORIGIN).searchParams.get('credentialId')).toBe(id);

    expect(await _testDb!.select({ id: credentials.id }).from(credentials)).toHaveLength(
      credentialsBefore.length,
    );
    expect(await readConnectionState(_testDb!, { kind: 'credential', id })).toMatchObject({
      state: 'working',
      cause: 'authorised',
    });
    const rows = await connectorRows();
    expect(rows.map((r) => r.id).sort()).toEqual([mail, drive].sort());
    expect(rows.every((r) => r.credentialId === id)).toBe(true);
    const byName = await instances();
    expect(byName.get('Mail')!.connection.state).toBe('working');
    expect(byName.get('Drive')!.connection.state).toBe('working');
  });

  it('a connector whose credential was deleted: the new credential is bound to THAT connector, its agents keep it, no second connector', async () => {
    const orphan = await connector({
      slug: 'gmail',
      name: 'Orphan',
      credentialId: null,
      assign: true,
    });
    const location = await callback({
      connector: 'gmail',
      returnTo: `/connectors?rebind=${orphan}&connected=gmail`,
      email: 'new@example.test',
    });
    const back = new URL(location, ORIGIN);
    expect(back.searchParams.get('rebind')).toBe(orphan);
    const newCredential = back.searchParams.get('credentialId')!;

    const { default: ConnectorsPage } = await import('@/app/(dashboard)/connectors/page.tsx');
    const sp = Object.fromEntries(back.searchParams);
    const redirected = await ConnectorsPage({ searchParams: Promise.resolve(sp) }).catch(
      (e: { redirectTo?: string }) => e.redirectTo,
    );
    expect(redirected).toBe('/connectors?connected=gmail');

    const rows = await connectorRows();
    expect(rows).toEqual([{ id: orphan, credentialId: newCredential }]);
    const assigned = await _testDb!
      .select({ connectorId: agentConnectorAssignments.connectorId })
      .from(agentConnectorAssignments);
    expect(assigned).toEqual([{ connectorId: orphan }]);
    expect((await instances()).get('Orphan')!.connection.state).toBe('working');
  });

  it('a binding refused on return is shown as failed, never announced as connected', async () => {
    const orphan = await connector({ slug: 'gmail', name: 'Orphan', credentialId: null });
    // A credential that grants nothing Gmail does.
    const [driveOnly] = await _testDb!
      .insert(credentials)
      .values({
        ownerUserId: _testUserId,
        name: 'Drive only',
        type: 'google-oauth',
        payload: encrypt(
          JSON.stringify({
            clientId: 'c',
            clientSecret: 's',
            refreshToken: 'r',
            accessToken: 'a',
            expiresAt: null,
            scopes: 'https://www.googleapis.com/auth/drive.file',
            accountName: 'x@example.test',
          }),
        ),
      })
      .returning();
    const { default: ConnectorsPage } = await import('@/app/(dashboard)/connectors/page.tsx');
    const redirected = await ConnectorsPage({
      searchParams: Promise.resolve({
        rebind: orphan,
        credentialId: driveOnly!.id,
        connected: 'gmail',
      }),
    }).catch((e: { redirectTo?: string }) => e.redirectTo);
    expect(redirected).toMatch(/^\/connectors\?oauth_error=bind_failed&detail=/);
    expect(decodeURIComponent(String(redirected))).toContain(
      'has not been granted access to Gmail',
    );
    expect(await connectorRows()).toEqual([{ id: orphan, credentialId: null }]);
  });
});
