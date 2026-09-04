// verification.ts — le modèle central du plan « Vérifier & Corriger »
// (migration 0089) : où en est chaque livrable d'un job, et la trace de
// chaque commande de preuve qui l'a établi.
//
// `job_deliverable_verification_state` est une TABLE D'ÉTAT : une ligne par
// livrable d'un job (job_id, deliverable_type, canonical_key), lisible en un
// SELECT — jamais reconstituée en rejouant l'historique. Deux familles de
// livrables y cohabitent, distinguées par `deliverable_type` :
//
//   MUTABLE (code_project, office_file, document, other) — le livrable se
//   MODIFIE puis se PROUVE : `dirty_generation` avance à chaque écriture,
//   `verified_generation` rattrape quand la preuve passe verte. `outcome`
//   reste NULL — un fichier n'a pas de verdict binaire tenté/confirmé.
//
//   ATOMIQUE (outbound_action) — le livrable se TENTE puis se CONSTATE :
//   `outcome` porte la machine d'état prepared → attempted → confirmed |
//   rejected | outcome_unknown. Les deux générations restent NULL — envoyer
//   un message n'a pas de \"version sale\".
//
// Les colonnes propres à l'atomique (outcome, idempotency_key) ainsi que
// red_streak/repair_attempts sont créées ICI mais n'ont AUCUN écrivain avant
// les tickets qui les branchent (v6-A pour l'atomique, les passes de
// réparation pour red_streak/repair_attempts) — une colonne existe avant que
// quelque chose l'écrive, jamais l'inverse en silence.
//
// `verification_runs` est la trace D'UNE COMMANDE — modèle direct de
// `llm_calls` (une ligne par appel, jamais résumée) : `sequence_id` regroupe
// les commandes d'une même preuve (une exécution de `runCommandSequence`),
// `command_rank` les ordonne. `job_id` est ON DELETE SET NULL (comme
// llm_calls.job_id) : une preuve exécutée reste un fait audité même après que
// le job qui l'a demandée a disparu.
//
// Les deux tables citent EXACTEMENT les listes de
// `@nodal-agents/shared` (packages/shared/src/types/verification.ts) dans
// leurs CHECK — un écart entre les deux se voit au premier test de
// contrainte (constraints.test.ts).

import { pgTable, text, uuid, integer, timestamp, index, check, unique } from 'drizzle-orm/pg-core';
import { sql } from 'drizzle-orm';
import { entities } from './entities.ts';
import { agentJobs } from './jobs.ts';

// ─── job_deliverable_verification_state ────────────────────────────────────

export const jobDeliverableVerificationState = pgTable(
  'job_deliverable_verification_state',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    jobId: uuid('job_id')
      .notNull()
      .references(() => agentJobs.id, { onDelete: 'cascade' }),
    /** DeliverableType (@nodal-agents/shared) — choisit le canonicaliseur ET la politique. */
    deliverableType: text('deliverable_type').notNull(),
    /** Clé stable du livrable — projectKey(path) pour code_project (T01/T09). */
    canonicalKey: text('canonical_key').notNull(),
    /** AtomicOutcome — livrables ATOMIQUES seulement (v6-A, sans écrivain en ①). */
    outcome: text('outcome'),
    /** Clé d'idempotence du livrable atomique — sans écrivain en ①. */
    idempotencyKey: text('idempotency_key'),
    /** Dernier chemin/étiquette affiché à l'owner, pour l'UI (snapshot, pas une FK vivante). */
    displayPathSnapshot: text('display_path_snapshot'),
    /** Livrables MUTABLES seulement : incrémenté à chaque écriture. */
    dirtyGeneration: integer('dirty_generation'),
    /** Livrables MUTABLES seulement : la génération que la preuve a validée en vert. */
    verifiedGeneration: integer('verified_generation'),
    /** DecisionStatus — l'état lisible affiché à l'owner. */
    decisionStatus: text('decision_status').notNull(),
    /** Empreinte de la dernière commande de preuve exécutée (diagnostic, pas le hash d'approbation). */
    commandHashSnapshot: text('command_hash_snapshot'),
    /** Rouges consécutifs — sans écrivain en ① (passes de réparation). */
    redStreak: integer('red_streak').notNull().default(0),
    /** Tentatives de réparation automatique — sans écrivain en ①. */
    repairAttempts: integer('repair_attempts').notNull().default(0),
    /** verification_epoch de code_projects au moment du dernier test (T09). */
    testedEpoch: integer('tested_epoch'),
    updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [
    unique('job_deliverable_verification_state_job_type_key_unique').on(
      table.jobId,
      table.deliverableType,
      table.canonicalKey,
    ),
    check(
      'job_deliverable_verification_state_deliverable_type_check',
      sql`${table.deliverableType} IN ('code_project','office_file','document','outbound_action','other')`,
    ),
    check(
      'job_deliverable_verification_state_outcome_check',
      sql`${table.outcome} IS NULL OR ${table.outcome} IN ('prepared','attempted','confirmed','rejected','outcome_unknown')`,
    ),
    check(
      'job_deliverable_verification_state_decision_status_check',
      sql`${table.decisionStatus} IN ('dirty','green','red','pending_approval','not_configured','infra_error')`,
    ),
    check(
      'job_deliverable_verification_state_generation_check',
      sql`${table.verifiedGeneration} IS NULL OR ${table.verifiedGeneration} <= ${table.dirtyGeneration}`,
    ),
    // La famille du livrable impose sa forme : un ATOMIQUE ne porte jamais de
    // génération, un MUTABLE ne porte jamais d'outcome.
    check(
      'job_deliverable_verification_state_family_check',
      sql`(${table.deliverableType} = 'outbound_action' AND ${table.dirtyGeneration} IS NULL AND ${table.verifiedGeneration} IS NULL AND ${table.outcome} IS NOT NULL)
          OR (${table.deliverableType} <> 'outbound_action' AND ${table.outcome} IS NULL AND ${table.dirtyGeneration} IS NOT NULL)`,
    ),
  ],
);

export type JobDeliverableVerificationStateRow =
  typeof jobDeliverableVerificationState.$inferSelect;
export type JobDeliverableVerificationStateInsert =
  typeof jobDeliverableVerificationState.$inferInsert;

// ─── verification_runs ──────────────────────────────────────────────────────

export const verificationRuns = pgTable(
  'verification_runs',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    // set null (not cascade): a proof that actually ran is an audited fact —
    // it must survive the deletion of the job that requested it (mirrors
    // llm_calls.job_id).
    jobId: uuid('job_id').references(() => agentJobs.id, { onDelete: 'set null' }),
    entityId: uuid('entity_id').references(() => entities.id, { onDelete: 'cascade' }),
    deliverableType: text('deliverable_type').notNull(),
    canonicalKey: text('canonical_key').notNull(),
    /** Hash du manifeste (D1, @nodal-agents/shared) sous lequel cette commande a tourné. */
    manifestHash: text('manifest_hash'),
    /** Regroupe les commandes d'une même preuve (une exécution de runCommandSequence). */
    sequenceId: uuid('sequence_id').notNull(),
    commandRank: integer('command_rank').notNull(),
    command: text('command').notNull(),
    exitCode: integer('exit_code'),
    outcomeKind: text('outcome_kind').notNull(),
    /** Bornées par le code appelant (T09/T06), jamais illimitées en base. */
    stdoutTail: text('stdout_tail'),
    stderrTail: text('stderr_tail'),
    durationMs: integer('duration_ms'),
    verdict: text('verdict').notNull(),
    /** dirty_generation testé (livrables mutables) — snapshot au moment du run. */
    testedGeneration: integer('tested_generation'),
    /** verification_epoch testé — snapshot au moment du run. */
    testedEpoch: integer('tested_epoch'),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [
    index('idx_verification_runs_job_created').on(table.jobId, table.createdAt),
    check(
      'verification_runs_outcome_kind_check',
      sql`${table.outcomeKind} IN ('exit','timeout','spawn_error')`,
    ),
    check(
      'verification_runs_verdict_check',
      sql`${table.verdict} IN ('green','red','infra_error')`,
    ),
  ],
);

export type VerificationRunRow = typeof verificationRuns.$inferSelect;
export type VerificationRunInsert = typeof verificationRuns.$inferInsert;
