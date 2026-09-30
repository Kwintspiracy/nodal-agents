// approval_requests + approval_rules tables

import {
  pgTable,
  text,
  uuid,
  jsonb,
  timestamp,
  integer,
  index,
  check,
  unique,
} from 'drizzle-orm/pg-core';
import { sql } from 'drizzle-orm';
import { entities } from './entities.ts';
import { agents } from './agents.ts';
import { agentJobs } from './jobs.ts';

// ─── approval_requests ────────────────────────────────────────────────────────

export const approvalRequests = pgTable(
  'approval_requests',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    entityId: uuid('entity_id').references(() => entities.id, { onDelete: 'cascade' }),
    jobId: uuid('job_id')
      .notNull()
      .references(() => agentJobs.id, { onDelete: 'cascade' }),
    agentId: uuid('agent_id').references(() => agents.id, { onDelete: 'cascade' }),
    toolName: text('tool_name').notNull(),
    toolInput: jsonb('tool_input').notNull(),
    // The AI SDK tool-call id of the gated tool_use block (étape D). Lets the
    // resume path replace the EXACT awaiting marker instead of matching by
    // toolName alone (a fragility documented in the runner), and stamps the
    // replayed tool_calls row with its original id.
    toolCallId: text('tool_call_id'),
    /**
     * Ce que cette ligne DEMANDE (0098, P10a) : 'approval' — approuver ou
     * refuser une action — ou 'question' — choisir une option parmi celles que
     * l'agent propose (`ask_user`).
     *
     * POSÉE par la porte à la création, depuis ce que l'outil déclare
     * (`ToolDefinition.asksUser`), jamais devinée après coup par le nom de
     * l'outil : le web, le runner et Telegram la lisent tous les trois sans
     * avoir le registre d'outils sous la main.
     */
    kind: text('kind').notNull().default('approval'),
    status: text('status').default('pending'),
    /**
     * L'option choisie, TELLE QUELLE — le libellé, jamais l'index (0098).
     * Posée à la résolution, et seulement sur une ligne `kind = 'question'` :
     * l'écran et le transcript la relisent des mois plus tard, quand la liste
     * d'options n'existe plus qu'ici, dans `tool_input`. NULL tant que
     * personne n'a répondu, et sur un refus.
     */
    answer: text('answer'),
    /**
     * Why the autonomy checklist held this command (#464): one entry per kind
     * of action — `{ category, state, details }`, the details being the
     * commands that did it. The approval card shows them; NULL when the
     * checklist did not hold the call.
     */
    gateReasons: jsonb('gate_reasons'),
    requestedAt: timestamp('requested_at', { withTimezone: true }).defaultNow(),
    resolvedAt: timestamp('resolved_at', { withTimezone: true }),
    resolvedBy: text('resolved_by'),
    expiresAt: timestamp('expires_at', { withTimezone: true }).default(
      sql`now() + interval '1 hour'`,
    ),
    notes: text('notes'),
    /**
     * Stamped by the runner's resume step once the approved/rejected tool has
     * been executed (or its marker replaced). NULL = not yet executed.
     * Guards against double-execution on duplicate resume triggers.
     */
    executedAt: timestamp('executed_at', { withTimezone: true }),
    /**
     * La prise du job (`agent_jobs.claim_generation`) du run qui a RÉSERVÉ
     * l'exécution de cet appel approuvé (#566, migration 0135). NULL : pas
     * réservée. Posée atomiquement avant l'exécution, sous la prise du job :
     * un appel approuvé ne tourne qu'une fois, même quand le job change de run.
     */
    executionClaim: integer('execution_claim'),
    /**
     * Le tool_result de cet appel, consigné avec `executed_at` (#566) : un run
     * qui reprend le job après celui qui l'a exécuté le reprend tel quel au
     * lieu de le perdre. NULL pour une demande close avant cette colonne.
     */
    executionOutput: jsonb('execution_output'),
  },
  (table) => [
    index('idx_approval_requests_entity_id').on(table.entityId),
    index('idx_approval_status').on(table.status, table.requestedAt),
    index('idx_approval_requests_agent_id').on(table.agentId),
    index('idx_approval_requests_job_id').on(table.jobId),
    check(
      'approval_requests_status_check',
      sql`${table.status} IN ('pending','approved','rejected','expired')`,
    ),
    check('approval_requests_kind_check', sql`${table.kind} IN ('approval','question')`),
  ],
);

export type ApprovalRequestRow = typeof approvalRequests.$inferSelect;
export type ApprovalRequestInsert = typeof approvalRequests.$inferInsert;

// ─── approval_card_messages ───────────────────────────────────────────────────

/**
 * Chaque carte d'approbation (ou de question) livrée sur un canal (0140, #637) :
 * où elle est — canal, agent dont le binding l'a envoyée, conversation, id du
 * message — pour que la carte suive le sort de sa demande.
 *
 * Avant, l'id du message était jeté à l'envoi : seul un clic SUR la carte
 * pouvait la réécrire. Une demande tranchée ailleurs (dashboard, autre canal),
 * expirée par le balayage ou close par l'annulation de son job laissait une
 * carte morte, boutons actifs, dans la conversation du propriétaire.
 *
 * La mise à jour (`approvals/card-settlement.ts` du runner) :
 * - `claimed_at` : un appelant a pris la carte et l'édite en ce moment. Un
 *   bail, pas un verrou : passé `APPROVAL_CARD_CLAIM_LEASE_MS`, un autre la
 *   reprend (le processus qui la tenait est mort).
 * - `attempts` / `last_error` : combien d'éditions ont été tentées, et pourquoi
 *   la dernière a échoué. Un échec est repris au tick suivant, un nombre borné
 *   de fois.
 * - `settled_at` + `outcome` : posés UNE fois, quand c'est fini — `edited`
 *   (l'édition a réussi), `cannot_edit` (le canal ne sait pas éditer) ou
 *   `gave_up` (échecs répétés, abandon dit dans les logs). NULL : pas fini.
 */
export const approvalCardMessages = pgTable(
  'approval_card_messages',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    approvalRequestId: uuid('approval_request_id')
      .notNull()
      .references(() => approvalRequests.id, { onDelete: 'cascade' }),
    channel: text('channel').notNull(),
    agentId: uuid('agent_id')
      .notNull()
      .references(() => agents.id, { onDelete: 'cascade' }),
    conversationId: text('conversation_id').notNull(),
    messageId: text('message_id').notNull(),
    sentAt: timestamp('sent_at', { withTimezone: true }).notNull().defaultNow(),
    claimedAt: timestamp('claimed_at', { withTimezone: true }),
    attempts: integer('attempts').notNull().default(0),
    lastError: text('last_error'),
    settledAt: timestamp('settled_at', { withTimezone: true }),
    outcome: text('outcome'),
  },
  (table) => [
    index('idx_approval_card_messages_request').on(table.approvalRequestId),
    // Un message est UNE carte : l'adoption d'une carte non consignée ne la dédouble jamais.
    unique('approval_card_messages_message_unique').on(
      table.approvalRequestId,
      table.channel,
      table.conversationId,
      table.messageId,
    ),
    check(
      'approval_card_messages_channel_check',
      sql`${table.channel} IN ('telegram','discord','slack','whatsapp')`,
    ),
    check(
      'approval_card_messages_outcome_check',
      sql`${table.outcome} IS NULL OR ${table.outcome} IN ('edited','cannot_edit','gave_up')`,
    ),
  ],
);

export type ApprovalCardMessageRow = typeof approvalCardMessages.$inferSelect;

// ─── approval_rules ───────────────────────────────────────────────────────────

export const approvalRules = pgTable(
  'approval_rules',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    entityId: uuid('entity_id').references(() => entities.id, { onDelete: 'cascade' }),
    agentId: uuid('agent_id').references(() => agents.id, { onDelete: 'cascade' }),
    toolName: text('tool_name').notNull(),
    action: text('action').notNull(),
    conditionJson: jsonb('condition_json').default(sql`'{}'::jsonb`),
    createdAt: timestamp('created_at', { withTimezone: true }).defaultNow(),
    updatedAt: timestamp('updated_at', { withTimezone: true }).defaultNow(),
  },
  (table) => [
    index('idx_approval_rules_entity_id').on(table.entityId),
    check(
      'approval_rules_action_check',
      sql`${table.action} IN ('auto_approve','require_approval','block')`,
    ),
    // DB-1 (audit #2): one canonical rule per (entity, agent-or-null, tool) —
    // without this, two concurrent setAgentApprovalRuleAction calls (or any
    // direct insert) can leave two rows for the same scope with DIVERGENT
    // actions, and matchApprovalRule's `.find()` picks whichever the SELECT
    // happens to return first — a non-deterministic approval gate. agentId IS
    // NULL marks an entity-wide rule (e.g. the run_command LAN master-switch),
    // so a plain UNIQUE would treat two NULL rows as distinct and let the
    // duplicate back in; NULLS NOT DISTINCT (PG15+) closes that gap.
    unique('approval_rules_entity_agent_tool_unique')
      .on(table.entityId, table.agentId, table.toolName)
      .nullsNotDistinct(),
  ],
);

export type ApprovalRuleRow = typeof approvalRules.$inferSelect;
export type ApprovalRuleInsert = typeof approvalRules.$inferInsert;
