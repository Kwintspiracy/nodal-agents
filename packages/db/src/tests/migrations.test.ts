// Test: all schema tables can be created on a clean pglite DB (migration smoke test)

import { describe, it, expect, beforeAll } from 'vitest';
import { spinUpTestDb } from './helpers.ts';
import type { TestDb } from './helpers.ts';
import { sql } from 'drizzle-orm';

let db: TestDb;

beforeAll(async () => {
  const result = await spinUpTestDb();
  db = result.db;
});

const expectedTables = [
  'users',
  'user_profiles',
  'entities',
  'entity_members',
  'agents',
  'agent_jobs',
  'agent_tasks',
  'connectors',
  'tool_calls',
  'approval_requests',
  'approval_rules',
  'agent_memory',
  'webhook_triggers',
  'agent_skills',
  'skill_versions',
  'skill_connectors',
  'agent_skill_assignments',
  'agent_schedules',
  'entity_llm_keys',
  'mcp_servers',
  'agent_mcp_servers',
  'mcp_connections',
  'agent_assignments',
  'agent_budgets',
  // auth tables (better-auth)
  'sessions',
  'accounts',
  'verifications',
  'cli_runs',
  'workspace_locks',
];

describe('migrations: all tables exist', () => {
  for (const table of expectedTables) {
    it(`table ${table} exists`, async () => {
      const result = await db.execute(
        sql`SELECT 1 FROM information_schema.tables WHERE table_schema = 'public' AND table_name = ${table}`,
      );
      expect(result.rows.length).toBe(1);
    });
  }
});

// Dead scaffolding dropped by migration 0070 — must NOT come back.
const droppedTables = ['configurator_sessions', 'agent_plugins', 'rate_limits'];

describe('migrations: dropped tables stay dropped (0070)', () => {
  for (const table of droppedTables) {
    it(`table ${table} does not exist`, async () => {
      const result = await db.execute(
        sql`SELECT 1 FROM information_schema.tables WHERE table_schema = 'public' AND table_name = ${table}`,
      );
      expect(result.rows.length).toBe(0);
    });
  }
});

describe('migrations: vector extension', () => {
  it('vector extension is available', async () => {
    const result = await db.execute(sql`SELECT 1 FROM pg_extension WHERE extname = 'vector'`);
    expect(result.rows.length).toBe(1);
  });

  it('agent_memory.embedding is a vector(1536) column', async () => {
    const result = await db.execute(
      sql`SELECT udt_name FROM information_schema.columns WHERE table_name = 'agent_memory' AND column_name = 'embedding'`,
    );
    expect(result.rows.length).toBe(1);
  });
});
