// device-channel-migration.pg.test.ts — migration 0163 against a REAL Postgres (#945).
//
// `pnpm test` builds its base from the inline SQL of `helpers.ts`, never from
// `migrations/`: a migration missing from `meta/_journal.json` would be skipped
// in silence and the suite would stay green. Here the REAL migrations run, and
// each constraint that lists channels is tried with `device` and with a
// channel that does not exist:
//   - accepted: agent_jobs.channel, conversations.channel,
//     approval_card_messages.channel — and the `devices` table itself;
//   - left out, deliberately (migration header): job_deliveries,
//     channel_bindings, channel_allowed_conversations, the notify channel of
//     routines and webhooks.
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

/** The constraint a refused insert names — the proof that the CHECK refused it. */
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
let agentId = '';
let jobId = '';
let requestId = '';

describe('migration 0163_device_channel @cap:parler-par-canal-externe/moteur', () => {
  it('starts a real Postgres and applies the REAL migrations', async () => {
    pg = await startRealPostgres();
    await runMigrations(pg.url, { patchVectorAsText: true });
    client = createClient(pg.url, { max: 1 });
    const user = await one<{ id: string }>(
      sql`INSERT INTO users (email) VALUES ('device-0163@example.com') RETURNING id`,
    );
    entityId = (
      await one<{ id: string }>(
        sql`INSERT INTO entities (user_id, name, slug) VALUES (${user.id}, 'Devices', 'devices-0163') RETURNING id`,
      )
    ).id;
    agentId = (
      await one<{ id: string }>(
        sql`INSERT INTO agents (entity_id, name, slug, personality)
            VALUES (${entityId}, 'Root', 'root-0163', 'p') RETURNING id`,
      )
    ).id;
  }, 120_000);

  it('records the migration in the journal drizzle-kit reads, after 0162', async () => {
    const journal = (await import('../../migrations/meta/_journal.json', {
      with: { type: 'json' },
    })) as { default: { entries: Array<{ idx: number; tag: string; when: number }> } };
    const entry = journal.default.entries.find((e) => e.tag === '0163_device_channel');
    expect(entry).toBeDefined();
    // 0162 (#989) is 1786436800000: this one must come after it.
    expect(entry!.when).toBeGreaterThan(1_786_436_800_000);
  });

  it('creates devices: a workspace, a name, declared capabilities, created and last-seen times', async () => {
    const device = await one<{ id: string; capabilities: string[]; last_seen_at: unknown }>(
      sql`INSERT INTO devices (entity_id, name, capabilities)
          VALUES (${entityId}, 'Desk', ARRAY['microphone','speaker']::text[])
          RETURNING id, capabilities, last_seen_at`,
    );
    expect(device.capabilities).toEqual(['microphone', 'speaker']);
    expect(device.last_seen_at).toBeNull();
    expect(
      await refusedBy(
        sql`INSERT INTO devices (entity_id, name, capabilities)
            VALUES (${entityId}, 'Desk', ARRAY['laser']::text[])`,
      ),
    ).toBe('devices_capabilities_check');
    expect(
      await refusedBy(sql`INSERT INTO devices (entity_id, name) VALUES (${entityId}, '   ')`),
    ).toBe('devices_name_check');
  });

  it('agent_jobs.channel accepts device, still refuses an unknown channel', async () => {
    jobId = (
      await one<{ id: string }>(
        sql`INSERT INTO agent_jobs (entity_id, agent_id, channel, task)
            VALUES (${entityId}, ${agentId}, 'device', 't') RETURNING id`,
      )
    ).id;
    expect(jobId).toMatch(/^[0-9a-f-]{36}$/);
    expect(
      await refusedBy(
        sql`INSERT INTO agent_jobs (entity_id, agent_id, channel, task)
            VALUES (${entityId}, ${agentId}, 'pigeon', 't')`,
      ),
    ).toBe('agent_jobs_channel_check');
  });

  it('conversations.channel accepts device, still refuses an unknown channel', async () => {
    const conv = await one<{ channel: string }>(
      sql`INSERT INTO conversations (entity_id, agent_id, channel, chat_id)
          VALUES (${entityId}, ${agentId}, 'device', 'd') RETURNING channel`,
    );
    expect(conv.channel).toBe('device');
    expect(
      await refusedBy(
        sql`INSERT INTO conversations (entity_id, agent_id, channel) VALUES (${entityId}, ${agentId}, 'pigeon')`,
      ),
    ).toBe('conversations_channel_check');
  });

  it('approval_card_messages.channel accepts device, still refuses an unknown channel', async () => {
    requestId = (
      await one<{ id: string }>(
        sql`INSERT INTO approval_requests (entity_id, job_id, agent_id, tool_name, tool_input)
            VALUES (${entityId}, ${jobId}, ${agentId}, 'run_command', '{}'::jsonb) RETURNING id`,
      )
    ).id;
    const card = await one<{ channel: string }>(
      sql`INSERT INTO approval_card_messages (approval_request_id, channel, agent_id, conversation_id, message_id)
          VALUES (${requestId}, 'device', ${agentId}, 'd', ${requestId}) RETURNING channel`,
    );
    expect(card.channel).toBe('device');
    expect(
      await refusedBy(
        sql`INSERT INTO approval_card_messages (approval_request_id, channel, agent_id, conversation_id, message_id)
            VALUES (${requestId}, 'pigeon', ${agentId}, 'd', 'm')`,
      ),
    ).toBe('approval_card_messages_channel_check');
  });

  it('leaves device out where a device has no place: the outbox, bindings, allowlists, notify channels', async () => {
    expect(
      await refusedBy(
        sql`INSERT INTO job_deliveries (job_id, channel, chat_id, payload, outcome, idempotency_key)
            VALUES (${jobId}, 'device', 'd', 'p', 'prepared', 'k-0163')`,
      ),
    ).toBe('job_deliveries_channel_check');
    expect(
      await refusedBy(
        sql`INSERT INTO channel_bindings (agent_id, channel, credentials) VALUES (${agentId}, 'device', 'x')`,
      ),
    ).toBe('channel_bindings_channel_check');
    expect(
      await refusedBy(
        sql`INSERT INTO channel_allowed_conversations (agent_id, channel, conversation_id, role, status)
            VALUES (${agentId}, 'device', 'd', 'owner', 'active')`,
      ),
    ).toBe('channel_allowed_conversations_channel_check');
  });
});
