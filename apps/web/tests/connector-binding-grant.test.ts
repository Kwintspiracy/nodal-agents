// @vitest-environment node
/**
 * A connector is bound to a credential only for what the credential's grant
 * covers — the two binding actions, the connector card and the operations
 * grid, on a real pglite database.
 *
 * Providers covered: Google (several connectors, several rights each),
 * Microsoft (short-form Graph scopes), Airtable (a single connector) and
 * Notion (no scopes at all: unchanged behaviour).
 */
import { describe, it, expect, beforeAll, afterAll, vi } from 'vitest';
import { randomBytes } from 'node:crypto';
import {
  _setMasterKeyForTests,
  _resetMasterKeyCacheForTests,
  encrypt,
} from '@nodal-agents/secrets';
import { spinUpTestDb, seedMinimal } from '@nodal-agents/db/test-utils';
import type { TestDb } from '@nodal-agents/db/test-utils';
import { agentConnectorAssignments, connectors, credentials, eq } from '@nodal-agents/db';
import { getOAuthProvider } from '@nodal-agents/shared';
// Static: the action module pulls every adapter (googleapis, Graph). Loaded at
// collection, its cost is not counted against the first test's timeout.
import {
  assignCredentialAction,
  createOrAssignOAuthConnectorAction,
  listAgentConnectorsAction,
  listConnectorsAction,
} from '../src/lib/actions.ts';

let _testDb: TestDb | null = null;
let _testUserId = 'placeholder-user-id';
let _testEntityId = 'placeholder-entity-id';
let _agentId = 'placeholder-agent-id';

vi.mock('server-only', () => ({}));
vi.mock('next/cache', () => ({ revalidatePath: vi.fn() }));
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

const DRIVE = 'https://www.googleapis.com/auth/drive';
const GMAIL_READONLY = 'https://www.googleapis.com/auth/gmail.readonly';
const GMAIL_SEND = 'https://www.googleapis.com/auth/gmail.send';

async function credential(type: string, scopes: string): Promise<string> {
  const [row] = await _testDb!
    .insert(credentials)
    .values({
      ownerUserId: _testUserId,
      name: `${type} test`,
      type,
      payload: encrypt(
        JSON.stringify({
          clientId: 'c',
          clientSecret: 's',
          refreshToken: 'rt',
          accessToken: 'at',
          expiresAt: null,
          scopes,
          accountName: 'binding@example.com',
          tokenUrl: 'https://example.invalid/token',
        }),
      ),
    })
    .returning({ id: credentials.id });
  return row!.id;
}

async function connectorRows(slug: string) {
  return _testDb!
    .select({ id: connectors.id, credentialId: connectors.credentialId })
    .from(connectors)
    .where(eq(connectors.slug, slug));
}

describe('binding a connector to a credential follows its grant @cap:connecter-un-service/moteur', () => {
  it('a Drive-only credential is refused for Gmail, naming the missing rights, and no connector is created', async () => {
    const credId = await credential('google-oauth', `${DRIVE} openid`);
    const r = await createOrAssignOAuthConnectorAction('gmail', credId);
    expect(r.ok).toBe(false);
    if (r.ok) throw new Error('unreachable');
    expect(r.code).toBe('missing_access');
    expect(r.message).toContain(GMAIL_READONLY);
    expect(r.message).toContain(GMAIL_SEND);
    expect(await connectorRows('gmail')).toEqual([]);
  });

  it('a Drive-only credential is refused for Calendar too (another connector of the same provider)', async () => {
    const credId = await credential('google-oauth', DRIVE);
    const r = await createOrAssignOAuthConnectorAction('google-calendar', credId);
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.message).toContain('https://www.googleapis.com/auth/calendar.events');
  });

  it('a Drive-only credential still binds Sheets: Google accepts the Drive scope for every Sheets call', async () => {
    const credId = await credential('google-oauth', DRIVE);
    const r = await createOrAssignOAuthConnectorAction('google-sheets', credId);
    expect(r.ok).toBe(true);
    const rows = await connectorRows('google-sheets');
    expect(rows.map((x) => x.credentialId)).toContain(credId);
  });

  it('switching an existing Gmail connector onto a credential without Gmail rights is refused, and the FK is kept', async () => {
    const good = await credential('google-oauth', `${GMAIL_READONLY} ${GMAIL_SEND}`);
    const created = await createOrAssignOAuthConnectorAction('gmail', good);
    expect(created.ok).toBe(true);
    if (!created.ok) throw new Error('unreachable');
    const driveOnly = await credential('google-oauth', DRIVE);
    const r = await assignCredentialAction(created.data.connectorId, driveOnly);
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.code).toBe('missing_access');
    const [row] = await _testDb!
      .select({ credentialId: connectors.credentialId })
      .from(connectors)
      .where(eq(connectors.id, created.data.connectorId));
    expect(row!.credentialId).toBe(good);
  });

  it('Microsoft: a grant without any mail permission is refused for Outlook; Mail.Read binds', async () => {
    const none = await credential('microsoft-oauth', 'openid profile email offline_access');
    const refused = await createOrAssignOAuthConnectorAction('outlook-mail', none);
    expect(refused.ok).toBe(false);
    if (!refused.ok) expect(refused.message).toContain('https://graph.microsoft.com/Mail.Read');
    const readOnly = await credential('microsoft-oauth', 'Mail.Read openid');
    expect((await createOrAssignOAuthConnectorAction('outlook-mail', readOnly)).ok).toBe(true);
  });

  it('Microsoft: a grant written in another form (percent-encoded, lower case) is the same grant', async () => {
    const credId = await credential(
      'microsoft-oauth',
      'https%3A%2F%2Fgraph.microsoft.com%2Fmail.readwrite mail.send openid',
    );
    const created = await createOrAssignOAuthConnectorAction(
      'outlook-mail',
      credId,
      'Outlook form',
    );
    if (!created.ok) throw new Error(created.message);
    const listed = await listConnectorsAction();
    if (!listed.ok) throw new Error(listed.message);
    const row = listed.data.instances.find((i) => i.id === created.data.connectorId)!;
    expect(row.access).toEqual(expect.objectContaining({ kind: 'ready' }));
  });

  it('a single-connector provider (Airtable) binds on its own entry, as before', async () => {
    const credId = await credential(
      'airtable-oauth',
      getOAuthProvider('airtable-oauth')!.scopes.join(' '),
    );
    expect((await createOrAssignOAuthConnectorAction('airtable-oauth', credId)).ok).toBe(true);
  });

  it('a provider without scopes (Notion) binds on an empty grant, as before', async () => {
    const credId = await credential('notion-oauth', '');
    expect((await createOrAssignOAuthConnectorAction('notion-oauth', credId)).ok).toBe(true);
  });
});

describe('the screens read the same grant as the engine @cap:connecter-un-service/moteur', () => {
  it('a Gmail connector on a partial grant is listed as needs_access, with the missing rights; Drive on its grant is ready', async () => {
    const credId = await credential('google-oauth', `${DRIVE} ${GMAIL_READONLY}`);
    const gmail = await createOrAssignOAuthConnectorAction('gmail', credId, 'Gmail partial');
    const drive = await createOrAssignOAuthConnectorAction('google-drive', credId, 'Drive full');
    expect(gmail.ok && drive.ok).toBe(true);
    if (!gmail.ok || !drive.ok) throw new Error('unreachable');

    const listed = await listConnectorsAction();
    if (!listed.ok) throw new Error(listed.message);
    const gmailRow = listed.data.instances.find((i) => i.id === gmail.data.connectorId)!;
    const driveRow = listed.data.instances.find((i) => i.id === drive.data.connectorId)!;
    expect(gmailRow.access?.kind).toBe('needs_access');
    if (gmailRow.access?.kind !== 'needs_access') throw new Error('unreachable');
    expect(gmailRow.access.missingScopes).toContain(GMAIL_SEND);
    expect(gmailRow.access.grantedOperations).toContain('gmail_list_messages');
    expect(driveRow.access).toEqual(expect.objectContaining({ kind: 'ready' }));
  });

  it("the agent's operations grid marks the operations a job will not receive", async () => {
    const credId = await credential('google-oauth', GMAIL_READONLY);
    const gmail = await createOrAssignOAuthConnectorAction('gmail', credId, 'Gmail for grid');
    if (!gmail.ok) throw new Error(gmail.message);
    await _testDb!.insert(agentConnectorAssignments).values({
      agentId: _agentId,
      connectorId: gmail.data.connectorId,
      entityId: _testEntityId,
      enabledOperations: null,
    });
    const r = await listAgentConnectorsAction(_agentId);
    if (!r.ok) throw new Error(r.message);
    const row = r.data.find((x) => x.connectorId === gmail.data.connectorId)!;
    expect(row.access?.kind).toBe('needs_access');
    if (row.access?.kind !== 'needs_access') throw new Error('unreachable');
    expect(row.access.missingOperations).toContain('gmail_send_email');
    expect(row.access.missingOperations).not.toContain('gmail_list_messages');
  });
});
