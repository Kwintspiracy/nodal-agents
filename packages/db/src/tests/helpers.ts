// Test helpers — spinUpTestDb() using pglite + drizzle, with manual schema creation
// We use inline SQL rather than drizzle-kit migrations because:
// 1. pglite doesn't support pgvector ivfflat index creation in-process
// 2. drizzle-kit generate requires a live DB connection
// 3. We can still test all CRUD/FK/CHECK paths with inline DDL

import { PGlite } from '@electric-sql/pglite';
import { vector } from '@electric-sql/pglite/vector';
import { drizzle } from 'drizzle-orm/pglite';
import * as schema from '../schema/index.ts';

export type TestDb = ReturnType<typeof drizzle<typeof schema>>;

/**
 * Spins up an in-memory PGlite instance with the full schema applied.
 * Returns a Drizzle db instance ready for queries.
 *
 * Use once per test file (beforeAll), not per test.
 * For test isolation use transactions that rollback (see wrapInTx).
 */
export async function spinUpTestDb(): Promise<{ db: TestDb; pg: PGlite }> {
  // Load the vector extension via the pglite extension mechanism
  const pg = new PGlite({ extensions: { vector } });

  // The vector extension must be created in the DB after PGlite boots
  await pg.exec(`CREATE EXTENSION IF NOT EXISTS vector;`);

  // ── Core tables ──────────────────────────────────────────────────────────────
  await pg.exec(`
    CREATE TABLE IF NOT EXISTS users (
      id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
      email text NOT NULL UNIQUE,
      password_hash text,
      name text NOT NULL DEFAULT '',
      email_verified boolean NOT NULL DEFAULT false,
      image text,
      created_at timestamptz NOT NULL DEFAULT now(),
      updated_at timestamptz NOT NULL DEFAULT now()
    );

    CREATE TABLE IF NOT EXISTS user_profiles (
      user_id uuid PRIMARY KEY REFERENCES users(id) ON DELETE CASCADE,
      display_name text,
      avatar_url text,
      timezone text NOT NULL DEFAULT 'UTC',
      locale text NOT NULL DEFAULT 'en',
      created_at timestamptz NOT NULL DEFAULT now(),
      updated_at timestamptz NOT NULL DEFAULT now()
    );

    CREATE TABLE IF NOT EXISTS entities (
      id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
      user_id uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
      name text NOT NULL,
      slug text NOT NULL UNIQUE,
      description text,
      icon text DEFAULT '🏢',
      industry text,
      goal text,
      timezone text,
      mcp_token uuid DEFAULT gen_random_uuid(),
      root_agent_id uuid,
      root_grants jsonb NOT NULL DEFAULT '{}',
      created_at timestamptz DEFAULT now(),
      updated_at timestamptz DEFAULT now(),
      last_curator_run_at timestamptz,
      reflection_enabled boolean NOT NULL DEFAULT false,
      memory_curation_enabled boolean NOT NULL DEFAULT true,
      skill_assignment_mode text NOT NULL DEFAULT 'approval',
      lan_command_yolo boolean NOT NULL DEFAULT false
    );

    CREATE TABLE IF NOT EXISTS entity_members (
      id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
      entity_id uuid NOT NULL REFERENCES entities(id) ON DELETE CASCADE,
      user_id uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
      role text DEFAULT 'owner' CHECK (role IN ('owner','admin','member','viewer')),
      created_at timestamptz DEFAULT now(),
      UNIQUE (entity_id, user_id)
    );

    CREATE TABLE IF NOT EXISTS entity_llm_keys (
      id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
      entity_id uuid NOT NULL REFERENCES entities(id) ON DELETE CASCADE,
      provider text NOT NULL,
      api_key text NOT NULL DEFAULT '',
      api_key_last4 text NOT NULL DEFAULT '',
      base_url text,
      nickname text,
      context_window integer,
      is_active boolean NOT NULL DEFAULT true,
      created_at timestamptz NOT NULL DEFAULT now(),
      updated_at timestamptz NOT NULL DEFAULT now()
    );

    CREATE TABLE IF NOT EXISTS agents (
      id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
      entity_id uuid REFERENCES entities(id) ON DELETE CASCADE,
      name text NOT NULL,
      slug text NOT NULL,
      personality text NOT NULL,
      model text DEFAULT 'claude-sonnet-4-6-20260217',
      llm_key_id uuid REFERENCES entity_llm_keys(id) ON DELETE SET NULL,
      fallback_chain jsonb DEFAULT '[]'::jsonb,
      active boolean DEFAULT true,
      is_default boolean DEFAULT false,
      role text DEFAULT 'agent' CHECK (role IN ('agent','orchestrator','system')),
      orchestrator_mode text CHECK (orchestrator_mode IN ('router','planner') OR orchestrator_mode IS NULL),
      telegram_bot_token text,
      telegram_bot_username text,
      telegram_offset bigint,
      last_seen_chat_id_telegram text,
      requires_approval text[] DEFAULT '{}',
      capabilities text[] DEFAULT '{}',
      task_context_template text,
      avatar_url text,
      system_agent boolean DEFAULT false,
      max_tokens_per_job integer NOT NULL DEFAULT 0 CHECK (max_tokens_per_job >= 0),
      memory_token_budget integer NOT NULL DEFAULT 1500,
      position integer NOT NULL DEFAULT 0,
      created_at timestamptz DEFAULT now(),
      updated_at timestamptz DEFAULT now(),
      -- F-6 (audit #2, migration 0056): slug moved from a global UNIQUE to
      -- unique per (entity_id, slug), NULLS NOT DISTINCT.
      UNIQUE NULLS NOT DISTINCT (entity_id, slug)
    );

    -- FK from entities.root_agent_id → agents.id (added after agents table exists)
    DO $$
    BEGIN
      IF NOT EXISTS (
        SELECT 1 FROM information_schema.table_constraints
        WHERE constraint_name = 'entities_root_agent_id_fkey'
          AND table_name = 'entities'
      ) THEN
        ALTER TABLE entities
          ADD CONSTRAINT entities_root_agent_id_fkey
          FOREIGN KEY (root_agent_id) REFERENCES agents(id) ON DELETE SET NULL;
      END IF;
    END;
    $$;

    CREATE TABLE IF NOT EXISTS agent_jobs (
      id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
      entity_id uuid REFERENCES entities(id) ON DELETE CASCADE,
      agent_id uuid REFERENCES agents(id) ON DELETE CASCADE,
      status text DEFAULT 'pending' CHECK (status IN ('pending','processing','completed','failed','awaiting_approval','awaiting_delegation','cancelled')),
      channel text NOT NULL CHECK (channel IN ('telegram','api','whatsapp','internal','cron','task-board','slack','discord','dashboard','webhook')),
      task text NOT NULL,
      original_task text,
      chat_id text,
      conversation_id uuid,
      -- schedule_id references agent_schedules, created further below — the FK
      -- is added via ALTER TABLE right after that table exists (mirrors the
      -- entities/agents forward-reference pattern above).
      schedule_id uuid,
      trigger_context jsonb,
      system_prompt text,
      messages jsonb DEFAULT '[]',
      search_text text,
      search_tsv tsvector GENERATED ALWAYS AS (to_tsvector('simple', coalesce(search_text, ''))) STORED,
      tools_used text[] DEFAULT '{}',
      turn integer DEFAULT 0,
      result text,
      error text,
      chain_count integer DEFAULT 0,
      request_id text,
      parent_job_id uuid REFERENCES agent_jobs(id),
      parent_request_id text,
      total_duration_ms integer DEFAULT 0,
      input_tokens integer DEFAULT 0,
      output_tokens integer DEFAULT 0,
      effective_input_tokens integer DEFAULT 0,
      total_cost_usd real DEFAULT 0,
      served_provider text,
      delegation_depth integer DEFAULT 0,
      last_failed_delegation_slug text,
      pending_delegation jsonb,
      completed_at timestamptz,
      created_at timestamptz DEFAULT now(),
      updated_at timestamptz DEFAULT now()
    );

    CREATE TABLE IF NOT EXISTS agent_tasks (
      id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
      entity_id uuid NOT NULL REFERENCES entities(id) ON DELETE CASCADE,
      orchestrator_id uuid NOT NULL REFERENCES agents(id) ON DELETE CASCADE,
      title text NOT NULL CHECK (char_length(title) <= 200),
      description text CHECK (description IS NULL OR char_length(description) <= 2000),
      status text NOT NULL DEFAULT 'todo' CHECK (status IN ('todo','in_progress','done','cancelled','blocked')),
      priority text NOT NULL DEFAULT 'medium' CHECK (priority IN ('low','medium','high')),
      job_id uuid REFERENCES agent_jobs(id) ON DELETE SET NULL,
      result text,
      created_by_agent_id uuid REFERENCES agents(id) ON DELETE CASCADE,
      assigned_agent_id uuid REFERENCES agents(id) ON DELETE CASCADE,
      input_tokens integer DEFAULT 0,
      output_tokens integer DEFAULT 0,
      cost_usd numeric(10,6) DEFAULT 0,
      depends_on uuid[] DEFAULT '{}',
      context jsonb DEFAULT '{}',
      root_job_id uuid,
      locked_at timestamptz,
      locked_by text,
      created_at timestamptz NOT NULL DEFAULT now(),
      updated_at timestamptz NOT NULL DEFAULT now()
    );

    CREATE TABLE IF NOT EXISTS credentials (
      id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
      owner_user_id uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
      name text NOT NULL,
      type text NOT NULL CHECK (type IN ('google-oauth','notion-oauth','airtable-oauth')),
      payload text NOT NULL,
      created_at timestamptz DEFAULT now(),
      updated_at timestamptz DEFAULT now()
    );

    CREATE TABLE IF NOT EXISTS connectors (
      id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
      entity_id uuid REFERENCES entities(id) ON DELETE CASCADE,
      name text NOT NULL,
      slug text NOT NULL,
      base_url text,
      api_key text,
      active boolean DEFAULT true,
      auth_type text NOT NULL DEFAULT 'api_key' CHECK (auth_type IN ('api_key','oauth2','bearer','basic','none')),
      credential_id uuid REFERENCES credentials(id) ON DELETE SET NULL,
      created_at timestamptz DEFAULT now(),
      updated_at timestamptz DEFAULT now()
      -- Multi-instance brique (migration 0016): the (entity_id, slug) UNIQUE
      -- constraint was dropped in prod to allow several instances of the same
      -- connector type per entity (e.g. several Gmail accounts). Not declared
      -- here either, so the test DB matches prod.
    );

    CREATE TABLE IF NOT EXISTS agent_connector_assignments (
      id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
      agent_id uuid NOT NULL REFERENCES agents(id) ON DELETE CASCADE,
      connector_id uuid NOT NULL REFERENCES connectors(id) ON DELETE CASCADE,
      entity_id uuid NOT NULL REFERENCES entities(id) ON DELETE CASCADE,
      enabled_operations text[],
      created_at timestamptz DEFAULT now(),
      updated_at timestamptz DEFAULT now(),
      CONSTRAINT agent_connector_unique UNIQUE (agent_id, connector_id)
    );

    CREATE TABLE IF NOT EXISTS tool_calls (
      id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
      entity_id uuid REFERENCES entities(id) ON DELETE CASCADE,
      job_id uuid REFERENCES agent_jobs(id) ON DELETE CASCADE,
      tool_name text NOT NULL,
      tool_input jsonb,
      tool_output text,
      duration_ms integer,
      turn integer,
      created_at timestamptz DEFAULT now()
    );

    CREATE TABLE IF NOT EXISTS approval_requests (
      id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
      entity_id uuid REFERENCES entities(id) ON DELETE CASCADE,
      job_id uuid NOT NULL REFERENCES agent_jobs(id) ON DELETE CASCADE,
      agent_id uuid REFERENCES agents(id) ON DELETE CASCADE,
      tool_name text NOT NULL,
      tool_input jsonb NOT NULL,
      status text DEFAULT 'pending' CHECK (status IN ('pending','approved','rejected','expired')),
      requested_at timestamptz DEFAULT now(),
      resolved_at timestamptz,
      resolved_by text,
      expires_at timestamptz DEFAULT now() + interval '1 hour',
      notes text,
      executed_at timestamptz
    );

    CREATE TABLE IF NOT EXISTS approval_rules (
      id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
      entity_id uuid REFERENCES entities(id) ON DELETE CASCADE,
      agent_id uuid REFERENCES agents(id) ON DELETE CASCADE,
      tool_name text NOT NULL,
      action text NOT NULL CHECK (action IN ('auto_approve','require_approval','block')),
      condition_json jsonb DEFAULT '{}',
      created_at timestamptz DEFAULT now(),
      updated_at timestamptz DEFAULT now(),
      UNIQUE NULLS NOT DISTINCT (entity_id, agent_id, tool_name)
    );

    CREATE TABLE IF NOT EXISTS agent_memory (
      id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
      entity_id uuid REFERENCES entities(id) ON DELETE CASCADE,
      agent_id uuid REFERENCES agents(id) ON DELETE CASCADE,
      fact text NOT NULL,
      search_tsv tsvector GENERATED ALWAYS AS (to_tsvector('english', coalesce(fact, ''))) STORED,
      category text DEFAULT 'context' CHECK (category IN ('preference','context','outcome','learned_rule')),
      importance integer DEFAULT 3 CHECK (importance >= 1 AND importance <= 5),
      source text DEFAULT 'agent' CHECK (source IN ('agent','reflection','manual')),
      skill_tags text[] DEFAULT '{}',
      memory_layer text,
      embedding vector(1536),
      valid_from timestamptz DEFAULT now(),
      valid_to timestamptz,
      fact_hash text,
      archived boolean DEFAULT false,
      importance_locked boolean NOT NULL DEFAULT false,
      last_accessed_at timestamptz DEFAULT now(),
      access_count integer DEFAULT 0,
      created_at timestamptz DEFAULT now(),
      updated_at timestamptz DEFAULT now()
    );

    CREATE TABLE IF NOT EXISTS webhook_triggers (
      id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
      entity_id uuid REFERENCES entities(id) ON DELETE CASCADE,
      agent_id uuid REFERENCES agents(id) ON DELETE CASCADE,
      name text NOT NULL,
      slug text NOT NULL UNIQUE,
      task_template text NOT NULL,
      active boolean DEFAULT true,
      secret text,
      last_triggered_at timestamptz,
      trigger_count integer DEFAULT 0,
      created_at timestamptz DEFAULT now(),
      updated_at timestamptz DEFAULT now()
    );

    CREATE TABLE IF NOT EXISTS agent_skills (
      id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
      entity_id uuid REFERENCES entities(id) ON DELETE CASCADE,
      name text NOT NULL,
      slug text NOT NULL,
      content text NOT NULL,
      active boolean DEFAULT true,
      description text,
      default_content text,
      content_overridden boolean DEFAULT false,
      required_config jsonb DEFAULT '[]',
      operations jsonb DEFAULT '[]',
      required_builtins text[] NOT NULL DEFAULT '{}',
      is_community boolean NOT NULL DEFAULT false,
      source text,
      installed_scripts jsonb,
      created_by text NOT NULL DEFAULT 'user',
      created_by_agent_id uuid REFERENCES agents(id) ON DELETE SET NULL,
      state text NOT NULL DEFAULT 'active',
      last_used_at timestamptz,
      patch_count integer NOT NULL DEFAULT 0,
      archived_at timestamptz,
      created_at timestamptz DEFAULT now(),
      updated_at timestamptz DEFAULT now(),
      -- F-6 (audit #2, migration 0056): slug and name moved from global
      -- UNIQUE to unique per (entity_id, slug) / (entity_id, name),
      -- NULLS NOT DISTINCT.
      UNIQUE NULLS NOT DISTINCT (entity_id, slug),
      UNIQUE NULLS NOT DISTINCT (entity_id, name)
    );

    CREATE TABLE IF NOT EXISTS skill_versions (
      id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
      entity_id uuid REFERENCES entities(id) ON DELETE CASCADE,
      skill_id uuid REFERENCES agent_skills(id) ON DELETE CASCADE,
      version integer NOT NULL,
      content text NOT NULL,
      name text NOT NULL,
      created_at timestamptz DEFAULT now()
    );

    CREATE TABLE IF NOT EXISTS skill_connectors (
      skill_id uuid NOT NULL REFERENCES agent_skills(id) ON DELETE CASCADE,
      connector_id uuid NOT NULL REFERENCES connectors(id) ON DELETE CASCADE,
      entity_id uuid REFERENCES entities(id) ON DELETE CASCADE,
      PRIMARY KEY (skill_id, connector_id)
    );

    CREATE TABLE IF NOT EXISTS agent_skill_assignments (
      id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
      entity_id uuid NOT NULL REFERENCES entities(id) ON DELETE CASCADE,
      agent_id uuid NOT NULL REFERENCES agents(id) ON DELETE CASCADE,
      skill_id uuid NOT NULL REFERENCES agent_skills(id) ON DELETE CASCADE,
      approval_overrides jsonb DEFAULT '{}',
      use_custom_instructions boolean NOT NULL DEFAULT false,
      enabled_operations text[],
      scripts_authorized boolean NOT NULL DEFAULT false,
      files_writable boolean NOT NULL DEFAULT false,
      created_at timestamptz NOT NULL DEFAULT now(),
      UNIQUE (agent_id, skill_id)
    );

    CREATE TABLE IF NOT EXISTS agent_schedules (
      id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
      entity_id uuid REFERENCES entities(id) ON DELETE CASCADE,
      agent_id uuid NOT NULL REFERENCES agents(id) ON DELETE CASCADE,
      type text NOT NULL DEFAULT 'cron' CHECK (type IN ('cron','heartbeat')),
      name text NOT NULL,
      cron_expr text NOT NULL,
      timezone text,
      task text,
      objectives text,
      active boolean DEFAULT true,
      last_run timestamptz,
      next_run timestamptz,
      last_status text CHECK (last_status IN ('success','failed','no_action','budget_exhausted') OR last_status IS NULL),
      chat_id text,
      notify_on_success boolean NOT NULL DEFAULT false,
      daily_budget_usd real NOT NULL DEFAULT 5.0,
      created_at timestamptz DEFAULT now(),
      updated_at timestamptz DEFAULT now()
    );

    ALTER TABLE agent_jobs
      ADD CONSTRAINT agent_jobs_schedule_id_fkey
      FOREIGN KEY (schedule_id) REFERENCES agent_schedules(id) ON DELETE SET NULL;

    CREATE TABLE IF NOT EXISTS mcp_servers (
      id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
      entity_id uuid REFERENCES entities(id) ON DELETE CASCADE,
      name text NOT NULL,
      slug text NOT NULL,
      transport text NOT NULL CHECK (transport IN ('http','stdio')),
      url text,
      command text,
      args text[] DEFAULT '{}',
      env_vars jsonb DEFAULT '{}',
      api_key text,
      api_key_last4 text,
      auth_scheme text CHECK (auth_scheme IN ('header','query','bearer') OR auth_scheme IS NULL),
      auth_param_name text,
      active boolean DEFAULT true,
      available_tools jsonb,
      created_at timestamptz DEFAULT now(),
      updated_at timestamptz DEFAULT now()
      -- Multi-instance brique (migration 0017): the (entity_id, slug) UNIQUE
      -- index was dropped in prod to allow several instances of the same MCP
      -- server type per entity (e.g. two Cogni Cortex accounts). Not declared
      -- here either, so the test DB matches prod.
    );

    CREATE TABLE IF NOT EXISTS agent_mcp_servers (
      id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
      entity_id uuid NOT NULL REFERENCES entities(id) ON DELETE CASCADE,
      agent_id uuid NOT NULL REFERENCES agents(id) ON DELETE CASCADE,
      mcp_server_id uuid NOT NULL REFERENCES mcp_servers(id) ON DELETE CASCADE,
      enabled_tools jsonb,
      created_at timestamptz NOT NULL DEFAULT now(),
      updated_at timestamptz NOT NULL DEFAULT now(),
      UNIQUE (agent_id, mcp_server_id)
    );

    CREATE TABLE IF NOT EXISTS mcp_connections (
      id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
      entity_id uuid NOT NULL REFERENCES entities(id) ON DELETE CASCADE,
      slug text NOT NULL,
      active boolean NOT NULL DEFAULT true,
      tool_config jsonb NOT NULL DEFAULT '{}',
      created_at timestamptz NOT NULL DEFAULT now(),
      updated_at timestamptz NOT NULL DEFAULT now(),
      UNIQUE (entity_id, slug)
    );

    CREATE TABLE IF NOT EXISTS configurator_sessions (
      id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
      entity_id uuid NOT NULL REFERENCES entities(id) ON DELETE CASCADE,
      agent_id uuid REFERENCES agents(id) ON DELETE CASCADE,
      messages jsonb NOT NULL DEFAULT '[]',
      status text NOT NULL DEFAULT 'active',
      turn_count integer NOT NULL DEFAULT 0,
      created_at timestamptz NOT NULL DEFAULT now(),
      updated_at timestamptz NOT NULL DEFAULT now()
    );

    CREATE TABLE IF NOT EXISTS agent_plugins (
      id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
      entity_id uuid REFERENCES entities(id) ON DELETE CASCADE,
      name text NOT NULL,
      slug text NOT NULL,
      description text,
      plugin_type text NOT NULL CHECK (plugin_type IN ('webhook','transform','schedule')),
      config jsonb DEFAULT '{}',
      active boolean DEFAULT true,
      hook text NOT NULL CHECK (hook IN ('pre_task','post_task','pre_tool','post_tool','on_memory_save')),
      webhook_url text,
      created_at timestamptz DEFAULT now(),
      updated_at timestamptz DEFAULT now(),
      UNIQUE NULLS NOT DISTINCT (entity_id, slug)
    );

    CREATE TABLE IF NOT EXISTS agent_assignments (
      id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
      orchestrator_id uuid NOT NULL REFERENCES agents(id) ON DELETE CASCADE,
      sub_agent_id uuid NOT NULL REFERENCES agents(id) ON DELETE CASCADE,
      entity_id uuid NOT NULL REFERENCES entities(id) ON DELETE CASCADE,
      instructions text,
      created_at timestamptz NOT NULL DEFAULT now(),
      UNIQUE (orchestrator_id, sub_agent_id)
    );

    CREATE TABLE IF NOT EXISTS agent_workspaces (
      id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
      agent_id uuid NOT NULL REFERENCES agents(id) ON DELETE CASCADE,
      entity_id uuid REFERENCES entities(id) ON DELETE CASCADE,
      label text NOT NULL,
      path text NOT NULL,
      position integer NOT NULL DEFAULT 0,
      created_at timestamptz NOT NULL DEFAULT now(),
      updated_at timestamptz NOT NULL DEFAULT now(),
      UNIQUE (agent_id, label)
    );

    CREATE TABLE IF NOT EXISTS conversations (
      id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
      entity_id uuid REFERENCES entities(id) ON DELETE CASCADE,
      agent_id uuid NOT NULL REFERENCES agents(id) ON DELETE CASCADE,
      title text NOT NULL DEFAULT '',
      created_at timestamptz DEFAULT now(),
      updated_at timestamptz DEFAULT now()
    );

    CREATE TABLE IF NOT EXISTS chat_messages (
      id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
      entity_id uuid REFERENCES entities(id) ON DELETE CASCADE,
      agent_id uuid NOT NULL REFERENCES agents(id) ON DELETE CASCADE,
      conversation_id uuid REFERENCES conversations(id) ON DELETE CASCADE,
      role text NOT NULL CHECK (role IN ('user','assistant')),
      content text NOT NULL,
      job_id uuid REFERENCES agent_jobs(id) ON DELETE SET NULL,
      created_at timestamptz DEFAULT now()
    );

    CREATE TABLE IF NOT EXISTS agent_budgets (
      id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
      agent_id uuid UNIQUE REFERENCES agents(id) ON DELETE CASCADE,
      entity_id uuid REFERENCES entities(id) ON DELETE CASCADE,
      daily_token_limit bigint DEFAULT 0,
      monthly_token_limit bigint DEFAULT 0,
      alert_threshold_pct integer DEFAULT 80 CHECK (alert_threshold_pct >= 0 AND alert_threshold_pct <= 100),
      auto_pause boolean DEFAULT false,
      max_job_tokens integer DEFAULT 150000,
      created_at timestamptz DEFAULT now(),
      updated_at timestamptz DEFAULT now()
    );

    CREATE TABLE IF NOT EXISTS rate_limits (
      key text PRIMARY KEY,
      count integer DEFAULT 1,
      window_start timestamptz DEFAULT now()
    );

    -- ── app_settings (migration 0045) ────────────────────────────────────────

    CREATE TABLE IF NOT EXISTS app_settings (
      key text PRIMARY KEY,
      value text NOT NULL DEFAULT '',
      updated_at timestamptz NOT NULL DEFAULT now()
    );

    -- ── entity_settings (migration 0055 — M-2, audit #2) ─────────────────────

    CREATE TABLE IF NOT EXISTS entity_settings (
      entity_id uuid NOT NULL REFERENCES entities(id) ON DELETE CASCADE,
      key text NOT NULL,
      value text NOT NULL DEFAULT '',
      updated_at timestamptz NOT NULL DEFAULT now(),
      PRIMARY KEY (entity_id, key)
    );

    -- ── telegram_allowed_chats (migration 0057 — H-1 inbound authorization) ──

    CREATE TABLE IF NOT EXISTS telegram_allowed_chats (
      id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
      entity_id uuid REFERENCES entities(id) ON DELETE CASCADE,
      agent_id uuid NOT NULL REFERENCES agents(id) ON DELETE CASCADE,
      chat_id text NOT NULL,
      role text NOT NULL DEFAULT 'member',
      status text NOT NULL DEFAULT 'pending',
      requester_name text,
      created_at timestamptz DEFAULT now(),
      updated_at timestamptz DEFAULT now(),
      CONSTRAINT telegram_allowed_chats_agent_chat_unique UNIQUE (agent_id, chat_id),
      CONSTRAINT telegram_allowed_chats_role_check CHECK (role IN ('owner','member')),
      CONSTRAINT telegram_allowed_chats_status_check CHECK (status IN ('active','pending'))
    );

    -- F1 (audit #2 remediation follow-up, migration 0060): at most one active
    -- role='owner' row per agent — closes the concurrent-first-contact race
    -- that could create co-owners.
    CREATE UNIQUE INDEX IF NOT EXISTS telegram_allowed_chats_single_owner
      ON telegram_allowed_chats (agent_id) WHERE role = 'owner';

    -- ── auth tables (better-auth) ────────────────────────────────────────────

    CREATE TABLE IF NOT EXISTS sessions (
      id text PRIMARY KEY,
      user_id uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
      expires_at timestamptz NOT NULL,
      token text NOT NULL UNIQUE,
      ip_address text,
      user_agent text,
      created_at timestamptz NOT NULL DEFAULT now(),
      updated_at timestamptz NOT NULL DEFAULT now()
    );

    CREATE TABLE IF NOT EXISTS accounts (
      id text PRIMARY KEY,
      user_id uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
      provider_id text NOT NULL,
      account_id text NOT NULL,
      access_token text,
      refresh_token text,
      id_token text,
      access_token_expires_at timestamptz,
      refresh_token_expires_at timestamptz,
      scope text,
      password text,
      created_at timestamptz NOT NULL DEFAULT now(),
      updated_at timestamptz NOT NULL DEFAULT now()
    );

    CREATE TABLE IF NOT EXISTS verifications (
      id text PRIMARY KEY,
      identifier text NOT NULL,
      value text NOT NULL,
      expires_at timestamptz NOT NULL,
      created_at timestamptz NOT NULL DEFAULT now(),
      updated_at timestamptz NOT NULL DEFAULT now()
    );
  `);

  const db = drizzle(pg, { schema });
  return { db, pg };
}

/**
 * Seed a minimal set of rows needed for FK-dependent tests.
 * Returns { userId, entityId, agentId, llmKeyId, jobId } for use in tests.
 *
 * Also seeds an entity_llm_keys row wired to the agent (llmKeyId) so that
 * execute.ts's fail-loud guard (Brique 25) passes out of the box.
 * Tests that specifically test the missing-llmKeyId path can clear the field:
 *   await db.update(agents).set({ llmKeyId: null }).where(eq(agents.id, seed.agentId))
 */
export async function seedMinimal(db: TestDb) {
  // user
  const [user] = await db
    .insert(schema.users)
    .values({ email: `test-${Date.now()}@example.com` })
    .returning();
  if (!user) throw new Error('Failed to seed user');

  // entity
  const [entity] = await db
    .insert(schema.entities)
    .values({
      userId: user.id,
      name: 'Test Entity',
      slug: `test-entity-${Date.now()}`,
    })
    .returning();
  if (!entity) throw new Error('Failed to seed entity');

  // entity_llm_keys — seeded with a mock/test provider so execute.ts resolves
  // the client from DB (Brique 25 fail-loud guard) in all runner tests.
  // apiKey is intentionally empty: production code skips decryption when the
  // ciphertext column is '' (Brique 26), and runner tests stub createLlmClient
  // anyway so the value never matters at the network layer.
  const [llmKey] = await db
    .insert(schema.entityLlmKeys)
    .values({
      entityId: entity.id,
      provider: 'openai-compatible',
      apiKey: '',
      baseUrl: 'http://localhost:11434',
      nickname: 'Test LLM Key',
      isActive: true,
    })
    .returning();
  if (!llmKey) throw new Error('Failed to seed entity_llm_keys');

  // agent — wired to the LLM key so execute.ts does not fail with agent_no_llm_configured
  const [agent] = await db
    .insert(schema.agents)
    .values({
      entityId: entity.id,
      name: 'Test Agent',
      slug: `test-agent-${Date.now()}`,
      personality: 'You are a test agent.',
      llmKeyId: llmKey.id,
    })
    .returning();
  if (!agent) throw new Error('Failed to seed agent');

  // job
  const [job] = await db
    .insert(schema.agentJobs)
    .values({
      entityId: entity.id,
      agentId: agent.id,
      channel: 'api',
      task: 'Test task',
    })
    .returning();
  if (!job) throw new Error('Failed to seed job');

  return {
    userId: user.id,
    entityId: entity.id,
    agentId: agent.id,
    llmKeyId: llmKey.id,
    jobId: job.id,
  };
}
