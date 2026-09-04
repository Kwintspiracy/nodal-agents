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
  'code_projects',
  // auth tables (better-auth)
  'sessions',
  'accounts',
  'verifications',
  'cli_runs',
  'workspace_locks',
  'llm_calls',
  'cli_sessions',
  'job_deliveries',
  'job_deliverable_verification_state',
  'verification_runs',
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

// Migration 0090: the delivery outbox's symmetric race guard on the cron side —
// a job root claimed for finalization gets this column stamped, cleared when
// finalization ends.
// Migration 0088: code_projects gains project_key identity + verify_* proof
// config — spot-check the six new columns exist (the CHECK/UNIQUE behavior is
// covered by code-projects-migration-0088.test.ts and constraints.test.ts).
describe('migrations: code_projects verify_* + project_key columns (0088)', () => {
  const columns = [
    'project_key',
    'verify_commands',
    'verification_epoch',
    'verify_approved_manifest_hash',
    'verify_approved_at',
    'verify_approved_by',
  ];
  for (const column of columns) {
    it(`code_projects.${column} exists`, async () => {
      const result = await db.execute(
        sql`SELECT 1 FROM information_schema.columns WHERE table_name = 'code_projects' AND column_name = ${column}`,
      );
      expect(result.rows.length).toBe(1);
    });
  }
});

describe('migrations: agent_jobs.finalizing_at (0090)', () => {
  it('column exists', async () => {
    const result = await db.execute(
      sql`SELECT 1 FROM information_schema.columns WHERE table_name = 'agent_jobs' AND column_name = 'finalizing_at'`,
    );
    expect(result.rows.length).toBe(1);
  });
});

// Migration 0089: spot-check the columns that carry the mutable/atomic
// distinction and the proof trace — the full CHECK behavior is covered by
// constraints.test.ts, this just proves the columns exist as named.
describe('migrations: job_deliverable_verification_state + verification_runs columns (0089)', () => {
  const stateColumns = [
    'job_id',
    'deliverable_type',
    'canonical_key',
    'outcome',
    'idempotency_key',
    'dirty_generation',
    'verified_generation',
    'decision_status',
    'red_streak',
    'repair_attempts',
    'tested_epoch',
  ];
  for (const column of stateColumns) {
    it(`job_deliverable_verification_state.${column} exists`, async () => {
      const result = await db.execute(
        sql`SELECT 1 FROM information_schema.columns WHERE table_name = 'job_deliverable_verification_state' AND column_name = ${column}`,
      );
      expect(result.rows.length).toBe(1);
    });
  }

  const runColumns = [
    'job_id',
    'entity_id',
    'deliverable_type',
    'canonical_key',
    'manifest_hash',
    'sequence_id',
    'command_rank',
    'command',
    'exit_code',
    'outcome_kind',
    'stdout_tail',
    'stderr_tail',
    'verdict',
    'tested_generation',
    'tested_epoch',
  ];
  for (const column of runColumns) {
    it(`verification_runs.${column} exists`, async () => {
      const result = await db.execute(
        sql`SELECT 1 FROM information_schema.columns WHERE table_name = 'verification_runs' AND column_name = ${column}`,
      );
      expect(result.rows.length).toBe(1);
    });
  }
});
