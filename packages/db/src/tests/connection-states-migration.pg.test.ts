// connection-states-migration.pg.test.ts — migration 0171 against a REAL
// Postgres, on a database that already holds connections.
//
// What existing connections get, and why it is true rather than assumed:
// nothing before 0171 recorded an observation, so the migration writes NO
// row; every existing connection reads `NOT_CHECKED` from the store, and what
// IS known about it comes from its own rows at every read (a connector whose
// credential was deleted is `needs_reauth`, credential_removed). A row written
// here would claim an observation nobody made.

import { describe, it, expect, afterAll } from 'vitest';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { startRealPostgres, type RealPostgres } from '@nodal-agents/test-kit';
import {
  createClient,
  sql,
  connectors,
  credentials,
  entities,
  mcpServers,
  users,
  readConnectionStates,
  recordConnectionState,
} from '@nodal-agents/db';
import { runMigrations } from '@nodal-agents/db/migrate';
import { NOT_CHECKED, connectionKey, connectorConnection } from '@nodal-agents/shared';

let pg: RealPostgres | null = null;

afterAll(async () => {
  await pg?.stop();
});

function harness(): RealPostgres {
  if (!pg) expect.fail('REAL_POSTGRES_NOT_STARTED — the startup test failed before this one');
  return pg;
}

const MIGRATION = fileURLToPath(
  new URL('../../migrations/0171_connection_states.sql', import.meta.url),
);

describe('migration 0171_connection_states @cap:connecter-un-service/moteur', () => {
  it('starts a real Postgres and applies the REAL migrations — red if the binary is missing, not skipped', async () => {
    pg = await startRealPostgres();
    await runMigrations(pg.url, { patchVectorAsText: true });
  }, 120_000);

  it('on a database with connections, existing ones get no invented state; what their rows prove is read', async () => {
    const { db, close } = createClient(harness().url, { max: 1 });
    try {
      // The database as it was before 0171: the table does not exist yet.
      await db.execute(sql`DROP TABLE connection_states`);

      const [u] = await db.insert(users).values({ email: 'states@example.test' }).returning();
      const [e] = await db
        .insert(entities)
        .values({ userId: u!.id, name: 'States', slug: `states-${Date.now()}` })
        .returning();
      const [cred] = await db
        .insert(credentials)
        .values({ ownerUserId: u!.id, name: 'Google', type: 'google-oauth', payload: 'enc:v1:x' })
        .returning();
      const [bound] = await db
        .insert(connectors)
        .values({
          entityId: e!.id,
          name: 'Mail',
          slug: 'gmail',
          authType: 'oauth2',
          credentialId: cred!.id,
        })
        .returning();
      const [orphan] = await db
        .insert(connectors)
        .values({
          entityId: e!.id,
          name: 'Orphan',
          slug: 'gmail',
          authType: 'oauth2',
          credentialId: null,
        })
        .returning();
      const [server] = await db
        .insert(mcpServers)
        .values({
          entityId: e!.id,
          name: 'Fetch',
          slug: 'fetch',
          transport: 'stdio',
          command: 'uvx',
        })
        .returning();

      const migration = readFileSync(MIGRATION, 'utf8');
      await db.execute(sql.raw(migration));
      // Replayed: idempotent.
      await db.execute(sql.raw(migration));

      const count = (await db.execute(
        sql`SELECT count(*)::int AS n FROM connection_states`,
      )) as unknown as Array<{
        n: number;
      }>;
      expect(count[0]!.n, 'the migration must not invent an observation').toBe(0);

      const refs = [
        { kind: 'credential' as const, id: cred!.id },
        { kind: 'connector' as const, id: bound!.id },
        { kind: 'connector' as const, id: orphan!.id },
        { kind: 'mcp_server' as const, id: server!.id },
      ];
      const stored = await readConnectionStates(db, refs);
      for (const ref of refs) expect(stored.get(connectionKey(ref))).toEqual(NOT_CHECKED);

      // What the rows prove, read the way every reader reads it.
      expect(
        connectorConnection({
          secretKind: 'credential',
          secret: 'absent',
          stored: [stored.get(connectionKey(refs[2]!))!],
        }),
      ).toMatchObject({ state: 'needs_reauth', cause: 'credential_removed' });
    } finally {
      await close();
    }
  });

  it('the closed set holds in the real schema: an unknown kind or state is refused, an observation is upserted', async () => {
    const { db, close } = createClient(harness().url, { max: 1 });
    try {
      await expect(
        db.execute(
          sql`INSERT INTO connection_states (source_kind, source_id, state, cause) VALUES ('printer', 'x', 'working', 'succeeded')`,
        ),
      ).rejects.toThrow();
      await expect(
        db.execute(
          sql`INSERT INTO connection_states (source_kind, source_id, state, cause) VALUES ('credential', 'x', 'dead', 'succeeded')`,
        ),
      ).rejects.toThrow();

      const ref = { kind: 'channel' as const, id: 'agent:telegram' };
      await recordConnectionState(db, ref, {
        state: 'needs_reauth',
        cause: 'grant_refused',
        detail: 'telegram_invalid_token',
        observedAt: new Date(),
        retryAfter: null,
      });
      await recordConnectionState(db, ref, {
        state: 'working',
        cause: 'succeeded',
        detail: null,
        observedAt: new Date(),
        retryAfter: null,
      });
      const after = await readConnectionStates(db, [ref]);
      expect(after.get(connectionKey(ref))).toMatchObject({ state: 'working', cause: 'succeeded' });
    } finally {
      await close();
    }
  });
});
