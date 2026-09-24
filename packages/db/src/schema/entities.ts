// entities + entity_members tables

import {
  pgTable,
  text,
  uuid,
  jsonb,
  boolean,
  integer,
  real,
  timestamp,
  uniqueIndex,
  index,
  check,
} from 'drizzle-orm/pg-core';
import { sql } from 'drizzle-orm';
import { users } from './users.ts';

// ─── entities ─────────────────────────────────────────────────────────────────

export const entities = pgTable(
  'entities',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    // FK to our own users table (replaces auth.users)
    userId: uuid('user_id')
      .notNull()
      .references(() => users.id, { onDelete: 'cascade' }),
    name: text('name').notNull(),
    slug: text('slug').notNull().unique(),
    description: text('description'),
    icon: text('icon').default('🏢'),
    industry: text('industry'),
    goal: text('goal'),
    // IANA timezone for this workspace (e.g. 'Europe/Paris'). Captured from the
    // user's browser at onboarding, editable in Settings. Authoritative for the
    // agent: it reads the current local time and schedules crons in THIS zone.
    // null = fall back to the server's resolved timezone (legacy / pre-capture).
    timezone: text('timezone'),
    mcpToken: uuid('mcp_token').defaultRandom(),
    // ROOT agent designation (Wave 1 — V4 ROOT agent, 2026-05-29).
    // Points at the agent that receives meta-tools. Set null when no root
    // agent is designated. FK uses a lazy callback to avoid the circular
    // import (agents.ts imports entities.ts for its own FK — a direct TS
    // import here would create a module cycle; the lazy arrow breaks it at
    // Drizzle schema resolution time while TS only sees the type via the
    // forward-reference pattern).
    rootAgentId: uuid('root_agent_id'),
    // Per-grant toggles + autonomy level for the root agent. Stored as JSONB
    // and parsed at runtime via parseRootGrants() from @nodal-agents/shared.
    // Default is an empty object — the runtime falls back to DEFAULT_ROOT_GRANTS.
    rootGrants: jsonb('root_grants')
      .notNull()
      .default(sql`'{}'::jsonb`),
    createdAt: timestamp('created_at', { withTimezone: true }).defaultNow(),
    updatedAt: timestamp('updated_at', { withTimezone: true }).defaultNow(),
    lastCuratorRunAt: timestamp('last_curator_run_at', { withTimezone: true }),
    reflectionEnabled: boolean('reflection_enabled').notNull().default(false),
    // `memory_curation_enabled` lived here from 0.7.0 to migration 0122 (#411):
    // a per-workspace gate on the memory curator that no screen ever exposed.
    // Memory curation is now gated by the runner's MEMORY_CURATION_ENABLED
    // kill-switch only; "do not touch this fact" is the pin on the fact.
    // Controls whether agent-authored skills are auto-assigned to the authoring
    // agent ('auto') or queued for the entity owner to approve ('approval').
    skillAssignmentMode: text('skill_assignment_mode')
      .notNull()
      .default('approval')
      .$type<'auto' | 'approval'>(),
    /**
     * Frein d'urgence de l'auto-exécution (0082, inversion du modèle à deux
     * clés — décision Quentin 24/08). true = TOUT l'auto-run de code du
     * workspace est en pause : les règles auto_approve des outils d'exécution
     * (run_command, code_task, scripts, MCP stdio) deviennent dormantes sans
     * être supprimées — le runner les déshabille à l'exécution. false
     * (défaut) = les toggles Yolo par agent (owner-only) s'appliquent tels
     * quels. Remplace lan_command_yolo, qui était une PRÉ-CONDITION
     * d'activation : redondante (les toggles par agent étaient déjà
     * owner-only) et pénible — sa vraie valeur était le coupe-circuit, qui
     * devient son seul rôle.
     */
    autoRunPaused: boolean('auto_run_paused').notNull().default(false),
    /**
     * Interrupteur maitre du serveur MCP (PR C, decision Quentin 23/08).
     * Defaut FERME : un point d'entree externe qui cree des jobs doit etre
     * ouvert par un geste explicite, pas exister parce qu'un paquet est
     * installe. Verifie au demarrage du serveur ET a chaque appel — couper
     * l'interrupteur coupe les clients deja connectes.
     */
    mcpServerEnabled: boolean('mcp_server_enabled').notNull().default(false),
    /**
     * Les surfaces sous vérification (D8, plan « Vérifier & Corriger »,
     * migration 0091) : jsonb lu par parseVerificationSurfaces() de
     * @nodal-agents/shared. `'{}'` est VOULU — le défaut « toutes activées »
     * vit dans le parseur, jamais deviné par un backfill (même leçon que
     * 0084 : un réglage est un geste, pas un état inventé).
     */
    verificationSurfaces: jsonb('verification_surfaces')
      .notNull()
      .default(sql`'{}'::jsonb`),
    /**
     * Combien de tours de réparation un run reçoit au plus après une preuve
     * rouge (issue #377, migration 0121). La borne de #375 était écrite en
     * dur dans `finalize.ts` ; elle se règle désormais par espace.
     *
     * `0` — le run finit avec le verdict rouge immédiatement, comme avant
     * #375. `1` (défaut) — un tour, la décision D2 du plan. Jusqu'à `3`.
     *
     * LE CHECK EST EN BASE, pas seulement dans le formulaire : cette colonne
     * borne une boucle du runner (invariant #8), et une valeur de 9 999 écrite
     * par un script ferait tourner un agent toute la nuit sur une preuve qui
     * ne passera jamais.
     */
    proofRepairAttempts: integer('proof_repair_attempts').notNull().default(1),
    /**
     * Ce qu'un run peut coûter, en dollars, avant d'être arrêté avec ce qu'il
     * a déjà écrit (issue #442, migration 0126). Remplace la variable
     * d'environnement `MAX_COST_PER_JOB_USD` ; défaut 2, la valeur qu'elle
     * avait. `0` = aucun plafond.
     */
    maxRunCostUsd: real('max_run_cost_usd').notNull().default(2),
    /**
     * Combien d'heures un run peut TOURNER (attentes exclues), puis il est
     * arrêté avec ce qu'il a déjà écrit (issue #442). `0` = aucune limite.
     */
    maxRunHours: real('max_run_hours').notNull().default(0),
  },
  (table) => [
    check(
      'entities_proof_repair_attempts_check',
      sql`${table.proofRepairAttempts} >= 0 AND ${table.proofRepairAttempts} <= 3`,
    ),
    check(
      'entities_max_run_cost_usd_check',
      sql`${table.maxRunCostUsd} >= 0 AND ${table.maxRunCostUsd} <= 1000`,
    ),
    check(
      'entities_max_run_hours_check',
      sql`${table.maxRunHours} >= 0 AND ${table.maxRunHours} <= 72`,
    ),
    uniqueIndex('entities_mcp_token_idx').on(table.mcpToken),
    index('idx_entities_user_id').on(table.userId),
    index('idx_entities_root_agent_id').on(table.rootAgentId),
  ],
);

export type EntityRow = typeof entities.$inferSelect;
export type EntityInsert = typeof entities.$inferInsert;

// ─── entity_members ───────────────────────────────────────────────────────────

export const entityMembers = pgTable(
  'entity_members',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    entityId: uuid('entity_id')
      .notNull()
      .references(() => entities.id, { onDelete: 'cascade' }),
    userId: uuid('user_id')
      .notNull()
      .references(() => users.id, { onDelete: 'cascade' }),
    role: text('role').default('owner'),
    createdAt: timestamp('created_at', { withTimezone: true }).defaultNow(),
  },
  (table) => [
    index('idx_entity_members_entity_id').on(table.entityId),
    index('idx_entity_members_user_id').on(table.userId),
    index('idx_entity_members_user').on(table.userId, table.entityId),
    check(
      'entity_members_role_check',
      sql`${table.role} IN ('owner', 'admin', 'member', 'viewer')`,
    ),
    // R5 (audit #2 follow-up, found while sweeping helpers.ts for the SAME
    // class of phantom constraint): the pglite test DDL already assumed a
    // user can only be a member of an entity once — this table had no such
    // constraint in the real schema/migrations. Both columns are NOT NULL, so
    // a plain UNIQUE is correct (no NULLS NOT DISTINCT needed).
    uniqueIndex('entity_members_entity_user_unique').on(table.entityId, table.userId),
  ],
);

export type EntityMemberRow = typeof entityMembers.$inferSelect;
export type EntityMemberInsert = typeof entityMembers.$inferInsert;
