// mcp-stdio-create-action.test.ts — the Connectors screen writes a stdio MCP server the way the runner reads it.
//
// createMcpServerFromCatalogAction (custom stdio) goes through
// createStdioMcpServerRepo (packages/db), the path create_mcp and the bench
// take too (#794): each environment value encrypted on its own, read back by
// decryptMcpServerEnv, the function the runner decrypts with before it starts
// the server. Only the connection is replaced, at the adapter boundary: the
// assertions are on the mcp_servers row the action left.

import { describe, it, expect, beforeAll, vi } from 'vitest';
import { randomBytes } from 'node:crypto';
import { spinUpTestDb, seedMinimal } from '@nodal-agents/db/test-utils';
import type { TestDb } from '@nodal-agents/db/test-utils';
import { decryptMcpServerEnv, eq, mcpServers } from '@nodal-agents/db';
import { _setMasterKeyForTests } from '@nodal-agents/secrets';

let testDb: TestDb;
let session: { userId: string; entityId: string };
const connected: Array<{ command: string; args: string[]; env: Record<string, string> }> = [];

vi.mock('@/lib/server.ts', () => ({
  getDb: () => testDb,
  getAuthProvider: () => ({ name: 'local-auth' }),
  ACTIVE_ENTITY_COOKIE: 'nodalai_active_entity',
  applyActiveEntity: (s: { userId: string; entityId?: string }) => ({
    ...s,
    entityId: session.entityId,
  }),
}));
vi.mock('next/headers', () => ({
  headers: async () => new Headers(),
  cookies: async () => ({ set: () => {}, get: () => null, delete: () => {} }),
}));
vi.mock('next/cache', () => ({ revalidatePath: () => {} }));
vi.mock('@nodal-agents/auth', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@nodal-agents/auth')>();
  return {
    ...actual,
    requireAuth: async () => ({ userId: session.userId, entityId: session.entityId }),
  };
});
vi.mock('@nodal-agents/adapter-mcp', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@nodal-agents/adapter-mcp')>();
  return {
    ...actual,
    connectMcp: async (o: { command: string; args: string[]; env: Record<string, string> }) => {
      connected.push({ command: o.command, args: o.args, env: o.env });
      return {
        tools: [{ name: 'lookup', inputSchema: { type: 'object' } }],
        instructions: 'Ask before writing.',
        close: async () => undefined,
      };
    },
  };
});

beforeAll(async () => {
  _setMasterKeyForTests(randomBytes(32));
  testDb = (await spinUpTestDb()).db;
  const s = await seedMinimal(testDb);
  session = { userId: s.userId, entityId: s.entityId };
});

describe('createMcpServerFromCatalogAction, stdio @cap:connecter-un-service/moteur', () => {
  it('writes each environment value encrypted, that the runner reads back as it was typed', async () => {
    const { createMcpServerFromCatalogAction } = await import('../actions.ts');
    const r = await createMcpServerFromCatalogAction({
      slug: 'custom-stdio-mcp',
      name: 'Local tools',
      customSlug: 'local-tools',
      customCommand: 'node',
      customArgs: ['server.js'],
      customEnv: { API_TOKEN: 'tok-123456', ROOT: 'D:/data' },
    });
    expect(r.ok).toBe(true);
    // The server was started with the values in clear, as typed.
    expect(connected).toEqual([
      { command: 'node', args: ['server.js'], env: { API_TOKEN: 'tok-123456', ROOT: 'D:/data' } },
    ]);
    const [row] = await testDb.select().from(mcpServers).where(eq(mcpServers.slug, 'local-tools'));
    expect(row).toMatchObject({
      entityId: session.entityId,
      transport: 'stdio',
      command: 'node',
      args: ['server.js'],
      active: true,
      instructions: 'Ask before writing.',
    });
    const stored = row!.envVars as Record<string, string>;
    expect(JSON.stringify(stored)).not.toContain('tok-123456');
    for (const v of Object.values(stored)) expect(v.startsWith('enc:v1:')).toBe(true);
    expect(decryptMcpServerEnv(row!.envVars)).toEqual({ API_TOKEN: 'tok-123456', ROOT: 'D:/data' });
  });
});
