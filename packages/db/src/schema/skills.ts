// agent_skills, skill_versions, skill_connectors, agent_skill_assignments tables

import {
  pgTable,
  text,
  uuid,
  boolean,
  integer,
  jsonb,
  timestamp,
  index,
  unique,
} from 'drizzle-orm/pg-core';
import { sql } from 'drizzle-orm';
import { entities } from './entities.ts';
import { agents } from './agents.ts';
import { connectors } from './connectors.ts';

// ─── agent_skills ─────────────────────────────────────────────────────────────

export const agentSkills = pgTable(
  'agent_skills',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    entityId: uuid('entity_id').references(() => entities.id, { onDelete: 'cascade' }),
    name: text('name').notNull(),
    slug: text('slug').notNull(),
    content: text('content').notNull(),
    active: boolean('active').default(true),
    description: text('description'),
    defaultContent: text('default_content'),
    contentOverridden: boolean('content_overridden').default(false),
    requiredConfig: jsonb('required_config').default(sql`'[]'::jsonb`),
    operations: jsonb('operations').default(sql`'[]'::jsonb`),
    requiredBuiltins: text('required_builtins')
      .array()
      .notNull()
      .default(sql`'{}'::text[]`),
    // ─── Community-installed skills (open Agent Skills / SKILL.md format) ───
    // is_community = true for skills installed at runtime from an external
    // source (vs system catalog or user-authored custom skills). source is the
    // install origin (GitHub URL / skills.sh path). installed_scripts records
    // the bundled scripts detected at install (.py/.sh/etc.) — surfaced to the
    // user as a warning, since the runtime does NOT execute skill scripts.
    isCommunity: boolean('is_community').notNull().default(false),
    source: text('source'),
    // `sha256` is the ORIGIN hash of each script at install/update time — the
    // baseline for the three-way update check (computeScriptsState). Optional:
    // rows installed before the three-way check have no hashes and fall back
    // to the historical local-vs-upstream compare until their next apply.
    installedScripts:
      jsonb('installed_scripts').$type<
        Array<{ path: string; language: string; sha256?: string }>
      >(),
    // ─── Community skill update tracking (migration 0069) ───────────────────
    // updateAvailable: set by checkSkillUpdate (skills/check-updates.ts) when
    //   the upstream source diverges from what's installed (content and/or
    //   scripts). Surfaced in the dashboard so the owner can review + apply.
    // updateDetail: what the last check found — null before the first check.
    // lastUpdateCheckAt: throttle timestamp for the cron phase
    //   (run-skill-update-check.ts) — NULL means never checked.
    updateAvailable: boolean('update_available').notNull().default(false),
    updateDetail: jsonb('update_detail').$type<{
      contentChanged: boolean;
      scriptsChanged: boolean;
      /**
       * Three-way script state from computeScriptsState — 'conflict' means
       * upstream moved AND the local files were patched (applying overwrites
       * the patches); 'local-only' means only the local files were patched
       * (no badge — nothing new upstream). Absent on rows checked before the
       * three-way checker shipped.
       */
      scriptsState?: 'clean' | 'update' | 'conflict' | 'local-only';
      checkedAt: string;
    }>(),
    lastUpdateCheckAt: timestamp('last_update_check_at', { withTimezone: true }),
    // ─── Learning-loop columns (Phase A) ─────────────────────────────────────
    // createdBy: provenance — 'user' (default) | 'system' | 'agent'
    // state: lifecycle — 'active' (default) | 'stale' | 'archived'
    // lastUsedAt: fire-and-forget timestamp bumped each job, NULL = never used
    // patchCount: agent-authored patches applied so far
    // archivedAt: when the skill moved to state='archived' (NULL while active)
    createdBy: text('created_by').notNull().default('user'),
    // Which agent authored this skill (populated by the Tier-1 reflection pass).
    // NULL for user/system skills and curator umbrella skills (created_by_agent_id=null).
    createdByAgentId: uuid('created_by_agent_id').references(() => agents.id, {
      onDelete: 'set null',
    }),
    state: text('state').notNull().default('active'),
    lastUsedAt: timestamp('last_used_at', { withTimezone: true }),
    patchCount: integer('patch_count').notNull().default(0),
    archivedAt: timestamp('archived_at', { withTimezone: true }),
    createdAt: timestamp('created_at', { withTimezone: true }).defaultNow(),
    updatedAt: timestamp('updated_at', { withTimezone: true }).defaultNow(),
  },
  (table) => [
    index('idx_agent_skills_entity_id').on(table.entityId),
    index('idx_skills_active').on(table.active, table.slug),
    index('idx_agent_skills_is_community').on(table.isCommunity),
    // F-6 (audit #2): slug AND name were UNIQUE GLOBALLY — a 2nd workspace/
    // entity installing the same community skill (e.g. slug 'comfyui') or
    // creating a skill with the same display name crashed the insert, and in
    // multi-user mode let one entity squat/enumerate another's slugs or
    // names. Scoped to (entity_id, slug) / (entity_id, name): every real
    // insert always sets entityId (createSkillRepo takes it as a required
    // param; the system-skill seeder and community-skill installer both pass
    // it too — no production path leaves it NULL), but the column itself is
    // nullable, so NULLS NOT DISTINCT closes the same NULL-entity gap as
    // DB-1/agent_plugins (multiple (NULL, 'x') rows would otherwise all
    // satisfy a plain UNIQUE).
    unique('agent_skills_entity_slug_unique').on(table.entityId, table.slug).nullsNotDistinct(),
    unique('agent_skills_entity_name_unique').on(table.entityId, table.name).nullsNotDistinct(),
  ],
);

export type AgentSkillRow = typeof agentSkills.$inferSelect;
export type AgentSkillInsert = typeof agentSkills.$inferInsert;

// ─── skill_versions ───────────────────────────────────────────────────────────

export const skillVersions = pgTable(
  'skill_versions',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    entityId: uuid('entity_id').references(() => entities.id, { onDelete: 'cascade' }),
    skillId: uuid('skill_id').references(() => agentSkills.id, { onDelete: 'cascade' }),
    version: integer('version').notNull(),
    content: text('content').notNull(),
    name: text('name').notNull(),
    createdAt: timestamp('created_at', { withTimezone: true }).defaultNow(),
  },
  (table) => [
    index('idx_skill_versions_entity_id').on(table.entityId),
    index('idx_skill_versions_skill_id').on(table.skillId, sql`${table.version} DESC`),
  ],
);

export type SkillVersionRow = typeof skillVersions.$inferSelect;
export type SkillVersionInsert = typeof skillVersions.$inferInsert;

// ─── skill_connectors ─────────────────────────────────────────────────────────

export const skillConnectors = pgTable(
  'skill_connectors',
  {
    skillId: uuid('skill_id')
      .notNull()
      .references(() => agentSkills.id, { onDelete: 'cascade' }),
    connectorId: uuid('connector_id')
      .notNull()
      .references(() => connectors.id, { onDelete: 'cascade' }),
    entityId: uuid('entity_id').references(() => entities.id, { onDelete: 'cascade' }),
  },
  (table) => [
    index('idx_skill_connectors_entity_id').on(table.entityId),
    index('idx_skill_connectors_skill_id').on(table.skillId),
  ],
);

export type SkillConnectorRow = typeof skillConnectors.$inferSelect;
export type SkillConnectorInsert = typeof skillConnectors.$inferInsert;

// ─── agent_skill_assignments ──────────────────────────────────────────────────

export const agentSkillAssignments = pgTable(
  'agent_skill_assignments',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    entityId: uuid('entity_id')
      .notNull()
      .references(() => entities.id, { onDelete: 'cascade' }),
    agentId: uuid('agent_id')
      .notNull()
      .references(() => agents.id, { onDelete: 'cascade' }),
    skillId: uuid('skill_id')
      .notNull()
      .references(() => agentSkills.id, { onDelete: 'cascade' }),
    useCustomInstructions: boolean('use_custom_instructions').notNull().default(false),
    enabledOperations: text('enabled_operations').array(),
    // Per-skill × per-agent authorization to EXECUTE the skill's bundled scripts
    // (installed_scripts) via run_skill_script. Owner opt-in, default FALSE. A
    // community skill may ship .py/.sh scripts, but the runtime refuses to run
    // them unless the owner flips this for a specific agent × skill — the
    // case-by-case execution gate. Loaded by the runner into the ToolContext.
    scriptsAuthorized: boolean('scripts_authorized').notNull().default(false),
    // Per-skill × per-agent authorization to WRITE files into the skill's bundle
    // (the install-store dir) via skill_file_write. Owner opt-in, default FALSE.
    // An agent can always READ its assigned skills' files (skill_file_read), but
    // it can only modify them — drop a workflow, update a reference — when the
    // owner flips this for a specific agent × skill. Loaded by the runner into
    // the ToolContext. Mirrors scriptsAuthorized: a bounded, owner-gated write
    // path that avoids handing the agent a full shell (command-execution).
    filesWritable: boolean('files_writable').notNull().default(false),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [
    // DB-2 (audit #2): the table had no index beyond the PK, so assignSkillRepo's
    // check-then-insert (packages/db/src/repos/skills.ts) could race and leave
    // the same skill assigned twice to one agent. The unique index's leading
    // column (agent_id) also serves the hot read path (execute.ts loads all
    // skills for an agent) — no separate index needed on top of it.
    unique('agent_skill_assignments_agent_skill_unique').on(table.agentId, table.skillId),
  ],
);

export type AgentSkillAssignmentRow = typeof agentSkillAssignments.$inferSelect;
export type AgentSkillAssignmentInsert = typeof agentSkillAssignments.$inferInsert;
