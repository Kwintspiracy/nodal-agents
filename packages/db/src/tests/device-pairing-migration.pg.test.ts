// device-pairing-migration.pg.test.ts — migration 0164 against a REAL Postgres (#946).
//
// `pnpm test` builds its base from the inline SQL of `helpers.ts`, never from
// `migrations/`: a migration missing from `meta/_journal.json` would be skipped
// in silence. Here the REAL migrations run, and the pairing table's rules are
// tried: the user code's shape, the name's length, the capabilities, and the
// rule that a confirmed request names its workspace, device and conversation.
// The device keys: one hash names one device.
//
// The startup is a TEST, not a beforeAll: a beforeAll that throws marks the
// tests skipped, and a silently skipped test is a false green (invariant #4).

import { describe, it, expect, afterAll } from 'vitest';
import { startRealPostgres, type RealPostgres } from '@nodal-agents/test-kit';
import { createClient, sql, type AnyDrizzleDb } from '@nodal-agents/db';
import { runMigrations } from '@nodal-agents/db/migrate';

let pg: RealPostgres | null = null;
let client: ReturnType<typeof createClient> | null = null;

afterAll(async () => {
  await client?.close();
  await pg?.stop();
});

function db(): AnyDrizzleDb {
  if (!client) expect.fail('REAL_POSTGRES_NOT_STARTED — the startup test failed before this one');
  return client.db as unknown as AnyDrizzleDb;
}

async function one<T>(query: ReturnType<typeof sql>): Promise<T> {
  const rows = (await db().execute(query)) as unknown as T[];
  return rows[0]!;
}

async function refusedBy(query: ReturnType<typeof sql>): Promise<string> {
  try {
    await db().execute(query);
  } catch (err) {
    const e = err as { constraint_name?: string; constraint?: string; cause?: unknown };
    const cause = e.cause as { constraint_name?: string; constraint?: string } | undefined;
    return (
      e.constraint_name ??
      e.constraint ??
      cause?.constraint_name ??
      cause?.constraint ??
      String(err)
    );
  }
  return 'accepted';
}

let entityId = '';
let deviceId = '';

const pairing = (extra = sql``) =>
  sql`INSERT INTO device_pairings (device_code_hash, user_code, name, capabilities, protocol_version, requested_from, expires_at ${extra})`;

describe('migration 0164_device_pairing @cap:parler-par-canal-externe/moteur', () => {
  it('starts a real Postgres and applies the REAL migrations', async () => {
    pg = await startRealPostgres();
    await runMigrations(pg.url, { patchVectorAsText: true });
    client = createClient(pg.url, { max: 1 });
    const user = await one<{ id: string }>(
      sql`INSERT INTO users (email) VALUES ('device-0164@example.com') RETURNING id`,
    );
    entityId = (
      await one<{ id: string }>(
        sql`INSERT INTO entities (user_id, name, slug) VALUES (${user.id}, 'Pairing', 'pairing-0164') RETURNING id`,
      )
    ).id;
  }, 120_000);

  it('records the migration in the journal drizzle-kit reads, after 0163', async () => {
    const journal = (await import('../../migrations/meta/_journal.json', {
      with: { type: 'json' },
    })) as { default: { entries: Array<{ idx: number; tag: string; when: number }> } };
    const entry = journal.default.entries.find((e) => e.tag === '0164_device_pairing');
    const before = journal.default.entries.find((e) => e.tag === '0163_device_channel');
    expect(entry).toBeDefined();
    expect(entry!.when).toBeGreaterThan(before!.when);
  });

  it('gives devices a key hash, unique, a removal time and the address it paired from', async () => {
    const d = await one<{
      id: string;
      token_hash: string;
      revoked_at: unknown;
      paired_from: string;
    }>(
      sql`INSERT INTO devices (entity_id, name, token_hash, paired_from)
          VALUES (${entityId}, 'Desk', 'h1', '192.168.1.40')
          RETURNING id, token_hash, revoked_at, paired_from`,
    );
    deviceId = d.id;
    expect(d).toMatchObject({ token_hash: 'h1', revoked_at: null, paired_from: '192.168.1.40' });
    expect(
      await refusedBy(
        sql`INSERT INTO devices (entity_id, name, token_hash) VALUES (${entityId}, 'Twin', 'h1')`,
      ),
    ).toContain('devices_token_hash_unique');
    // Several devices without a key are fine.
    await db().execute(sql`INSERT INTO devices (entity_id, name) VALUES (${entityId}, 'A')`);
    await db().execute(sql`INSERT INTO devices (entity_id, name) VALUES (${entityId}, 'B')`);
  });

  it('device_pairings: a waiting request belongs to no workspace; its rules are checked', async () => {
    const p = await one<{ status: string; entity_id: unknown }>(
      sql`${pairing()} VALUES ('c1', '482913', 'Desk', ARRAY['microphone']::text[], 1, '10.0.0.1', now() + interval '10 minutes')
          RETURNING status, entity_id`,
    );
    expect(p).toEqual({ status: 'pending', entity_id: null });
    expect(
      await refusedBy(sql`${pairing()} VALUES ('c2', '48291', 'Desk', '{}', 1, '10.0.0.1', now())`),
    ).toBe('device_pairings_user_code_check');
    expect(
      await refusedBy(
        sql`${pairing()} VALUES ('c3', '482913', ${'x'.repeat(61)}, '{}', 1, '10.0.0.1', now())`,
      ),
    ).toBe('device_pairings_name_check');
    expect(
      await refusedBy(
        sql`${pairing()} VALUES ('c4', '482913', 'Desk', ARRAY['laser']::text[], 1, '10.0.0.1', now())`,
      ),
    ).toBe('device_pairings_capabilities_check');
    expect(
      await refusedBy(
        sql`${pairing()} VALUES ('c1', '111111', 'Again', '{}', 1, '10.0.0.1', now())`,
      ),
    ).toContain('device_pairings_device_code_hash');
  });

  it('a confirmed request names its workspace, its device and its conversation; a waiting one names none', async () => {
    expect(
      await refusedBy(
        sql`${pairing(sql`, status`)} VALUES ('c5', '482913', 'Desk', '{}', 1, '10.0.0.1', now(), 'confirmed')`,
      ),
    ).toBe('device_pairings_confirmed_check');
    expect(
      await refusedBy(
        sql`${pairing(sql`, entity_id, device_id, conversation_id`)}
            VALUES ('c6', '482913', 'Desk', '{}', 1, '10.0.0.1', now(), ${entityId}, ${deviceId}, gen_random_uuid())`,
      ),
    ).toBe('device_pairings_confirmed_check');
    const ok = await one<{ status: string }>(
      sql`${pairing(sql`, status, entity_id, device_id, conversation_id`)}
          VALUES ('c7', '482913', 'Desk', '{}', 1, '10.0.0.1', now(), 'delivered', ${entityId}, ${deviceId}, gen_random_uuid())
          RETURNING status`,
    );
    expect(ok.status).toBe('delivered');
    expect(
      await refusedBy(
        sql`${pairing(sql`, status`)} VALUES ('c8', '482913', 'Desk', '{}', 1, '10.0.0.1', now(), 'lost')`,
      ),
    ).toBe('device_pairings_status_check');
  });
});
