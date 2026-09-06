// agent_jobs table

import {
  pgTable,
  text,
  uuid,
  integer,
  real,
  jsonb,
  timestamp,
  index,
  check,
} from 'drizzle-orm/pg-core';
import { sql } from 'drizzle-orm';
import { entities } from './entities.ts';
import { agents } from './agents.ts';
import { agentSchedules } from './schedules.ts';

/**
 * Structured provenance for a job fired by an automated trigger, injected into
 * the system prompt's `## Runtime` block (buildRuntimeBlock in
 * packages/orchestration/src/system-prompt.ts) so the agent has a deterministic
 * cursor ("since when") instead of relying on its own memory.
 *
 * `cron`: `prevRunAt` is the schedule's `last_run` value AS IT WAS before this
 * fire claimed it — null on a schedule's first-ever run.
 *
 * `webhook` (Brique 5): a `webhook_triggers` row fired this job. `slug`
 * identifies the trigger row itself (stable across renames); `webhookName` is
 * the human-readable name at fire time; `triggeredAt` is the ISO timestamp the
 * runner received the request.
 */
export type JobTriggerContext =
  | {
      type: 'cron';
      scheduleName: string;
      prevRunAt: string | null;
      /**
       * L'id de l'automatisation, porté par la PROVENANCE (revue passe 26) :
       * `agent_jobs.schedule_id` est SET NULL quand l'automatisation est
       * supprimée, et deux automatisations supprimées puis recréées sous le
       * même nom fusionnaient en une seule ligne de la page Scheduled. Absent
       * sur les jobs antérieurs — la page retombe alors sur le nom, et le dit.
       */
      scheduleId?: string;
      /**
       * The schedule's EXPLICITLY chosen notify channel (agent_schedules.notify_channel),
       * carried onto the job so both delivery paths (delivery-guard's send tools
       * AND deliver-results.ts's adapter-direct return) honor the SAME channel the
       * chatId was resolved against — never one path picking the chosen channel
       * and the other falling back to priority-order. Absent/null when the
       * schedule left it on auto (see run-schedules.ts).
       */
      notifyChannel?: 'telegram' | 'discord' | 'slack' | 'whatsapp' | null;
    }
  | {
      type: 'webhook';
      webhookName: string;
      slug: string;
      triggeredAt: string;
      /**
       * The trigger's EXPLICITLY chosen notify channel (webhook_triggers.notify_channel,
       * B2). Same purpose as the cron variant's `notifyChannel` above — carried
       * onto the job so both delivery paths agree on which channel the chatId
       * was resolved against. Absent/null when the trigger left it on auto
       * (see routes/webhook.ts).
       */
      notifyChannel?: 'telegram' | 'discord' | 'slack' | 'whatsapp' | null;
    }
  | {
      /**
       * The job was created through Nodal's MCP server (PR C — an external
       * client such as the owner's terminal or a CLI-runtime agent called
       * `run_task`).
       *
       * `caller` is a DECLARATIVE label the client chose for itself — a
       * User-Agent, not an identity. stdio gives the server no way to verify
       * who launched it, so this field must NEVER grant a right or select an
       * agent: authorization stays entirely with the agent the server was
       * launched for. Its only job is to make "who asked for this?" readable
       * in the Runs page. Lying in it grants nothing.
       */
      type: 'mcp';
      caller?: string;
      triggeredAt: string;
    };

export const agentJobs = pgTable(
  'agent_jobs',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    entityId: uuid('entity_id').references(() => entities.id, { onDelete: 'cascade' }),
    agentId: uuid('agent_id').references(() => agents.id, { onDelete: 'cascade' }),
    status: text('status').default('pending'),
    channel: text('channel').notNull(),
    task: text('task').notNull(),
    originalTask: text('original_task'),
    chatId: text('chat_id'),
    /**
     * La conversation dont ce job est un tour (migration 0059, redéfinie par
     * 0094 — P6). Ce n'est plus un uuid frappé à la volée : depuis P6, la
     * valeur RÉFÉRENCE une ligne `conversations`, et l'identité d'un fil est
     * « une conversation par chat, jusqu'à ce que l'utilisateur en ouvre une
     * autre » (`/new` dans un canal, le « + » du dashboard) — plus la règle du
     * SILENCE de 4 h, qui ne survit que comme budget de relecture dans
     * thread-history.ts. Posée à la création par
     * apps/runner/src/job/conversation-id.ts ; les enfants (délégation,
     * task-board) héritent de la valeur de leur créateur ; rien d'autre ne la
     * mute après l'insert. NULL pour un job non conversationnel (cron,
     * webhook, sans parent).
     *
     * PAS DE CLÉ ÉTRANGÈRE, délibérément (0094) : 95 jobs de la base dev
     * portent un uuid dont la conversation a été supprimée par l'utilisateur,
     * et une FK les ramènerait à NULL — la page Runs perdrait le seul
     * regroupement que cette colonne sert à faire. L'identité vaut pour
     * l'avenir ; un ancien uuid orphelin reste tel quel.
     */
    conversationId: uuid('conversation_id'),
    /**
     * The schedule that fired this job (Event Triggers, Brique 1). NULL for
     * jobs that didn't come from a schedule. ON DELETE SET NULL — deleting a
     * schedule must not orphan its job history, just sever the link.
     */
    scheduleId: uuid('schedule_id').references(() => agentSchedules.id, { onDelete: 'set null' }),
    /**
     * Structured trigger provenance (see JobTriggerContext above), injected
     * into the system prompt by the runner so the agent knows "since when" —
     * the deterministic cursor for polling-watcher flows. NULL for jobs not
     * fired by an automated trigger (chat, dashboard, delegated children, ...).
     */
    triggerContext: jsonb('trigger_context').$type<JobTriggerContext>(),
    systemPrompt: text('system_prompt'),
    messages: jsonb('messages').default(sql`'[]'::jsonb`),
    /**
     * Flattened plain-text transcript (task + assistant text + tool outputs +
     * result) for full-text episodic search. Populated at job completion by
     * flattenTranscript(). A generated `search_tsv tsvector` column + GIN index
     * (raw SQL, migration 0050 — not expressible in the Drizzle schema builder)
     * makes it queryable by the `search_history` builtin.
     */
    searchText: text('search_text'),
    toolsUsed: text('tools_used')
      .array()
      .default(sql`'{}'::text[]`),
    turn: integer('turn').default(0),
    result: text('result'),
    error: text('error'),
    chainCount: integer('chain_count').default(0),
    requestId: text('request_id'),
    parentJobId: uuid('parent_job_id'),
    parentRequestId: text('parent_request_id'),
    totalDurationMs: integer('total_duration_ms').default(0),
    inputTokens: integer('input_tokens').default(0),
    outputTokens: integer('output_tokens').default(0),
    /**
     * Cumulative EFFECTIVE (non-cached) input tokens = Σ(inputTokens −
     * cachedInputTokens) per turn. The token budget (Guard 1a) measures this,
     * not raw input, so a job that re-sends a prompt-cached history (cheap, the
     * bulk read from cache) is not penalised as if every re-send were fresh.
     * Persisted alongside input_tokens so the budget stays cumulative across
     * self-chain resumes.
     */
    effectiveInputTokens: integer('effective_input_tokens').default(0),
    /**
     * Cumulative real dollar cost billed to the provider across all turns of
     * this job (sum of per-call costs reported by the provider). Populated only
     * when the provider reports per-call cost (OpenRouter with
     * `usage:{include:true}`); undefined/null for providers that don't report it
     * (Anthropic, Ollama, etc.). Used by the cost-budget guard (Guard 1e) and
     * for cost observability in the dashboard.
     *
     * Stored as a real/float because sub-cent values are common (e.g. $0.00056).
     * Cumulative across self-chain / approval / delegation resumes, exactly like
     * effectiveInputTokens.
     */
    totalCostUsd: real('total_cost_usd').default(0),
    /**
     * The upstream provider that actually served the last LLM call for this job
     * (e.g. 'DeepSeek' when an OpenRouter job was routed to the DeepSeek
     * upstream via provider-order preference). Populated from
     * `providerMetadata.openrouter.provider` on each LLM call; only the last
     * non-empty value is stored. NULL for providers that don't report upstream
     * identity (Anthropic, Ollama, etc.) or when the field was absent.
     */
    servedProvider: text('served_provider'),
    delegationDepth: integer('delegation_depth').default(0),
    /**
     * The slug of the last delegated child that failed on this parent job.
     * Set by `resumeDelegated` when a child returns `{status:'failed'}`, cleared
     * when any subsequent delegation succeeds. The runner uses this to block
     * NAIVE retries (parent re-emitting `assign_<sameSlug>` immediately after a
     * failure) while still allowing FALLBACK strategies (parent emitting
     * `assign_<differentSlug>` after a failure, e.g. note-taker as a fallback
     * after summarizer timeout).
     *
     * Replaces the earlier `failed_delegations_count` global counter from
     * commit `b76d449`, which was too coarse — it blocked ALL further
     * delegations after one failure, including legitimate fallbacks to a
     * different specialist (live regression: job `7767a3c1`, 2026-05-19).
     */
    lastFailedDelegationSlug: text('last_failed_delegation_slug'),
    pendingDelegation: jsonb('pending_delegation'),
    /**
     * Marks a root job as being finalized RIGHT NOW by the delivery cron
     * (migration 0090, plan « Vérifier & Corriger »). Set at claim time (the
     * same instant the cron reserves the job for its finalization phase, in
     * place of the earlier read-then-write race), cleared when finalization
     * ends (success or failure). Lets a second concurrent tick recognize a
     * job already being finalized and skip it, instead of racing the first
     * tick to the terminal write. NULL outside a finalization window.
     */
    finalizingAt: timestamp('finalizing_at', { withTimezone: true }),
    /**
     * La trace FIGÉE des surfaces décochées au moment où ce run a tourné (D8,
     * migration 0091) — un ensemble de clés VerificationSurfaceKey, chacune
     * appendée une fois par le helper d'intention. Le détail d'un run dit
     * « surface hors vérification » depuis CETTE colonne, jamais depuis le
     * réglage courant de l'espace : si l'owner recoche demain, les runs d'hier
     * doivent toujours raconter ce qui s'est passé hier.
     */
    verificationSkippedSurfaces: jsonb('verification_skipped_surfaces')
      .notNull()
      .default(sql`'[]'::jsonb`),
    /**
     * Le projet ENREGISTRÉ auquel ce travail s'est rattaché (0093, P5).
     *
     * Posé UNE SEULE FOIS, par `attachProductionToProject` : le premier projet
     * touché gagne, et l'`UPDATE … WHERE project_id IS NULL` fait cette règle
     * sans lecture préalable. NULL tant qu'aucune production n'est tombée dans
     * un projet déclaré — le rattachement est un registre, jamais une garde.
     *
     * Pas de `.references()` ici, comme `parent_job_id` juste au-dessus : la FK
     * (ON DELETE SET NULL vers code_projects) est posée par la migration. La
     * déclarer côté Drizzle ferait un cycle d'import avec code-projects.ts, qui
     * référence déjà agent_jobs pour `registered_job_id`.
     */
    projectId: uuid('project_id'),
    completedAt: timestamp('completed_at', { withTimezone: true }),
    createdAt: timestamp('created_at', { withTimezone: true }).defaultNow(),
    updatedAt: timestamp('updated_at', { withTimezone: true }).defaultNow(),
  },
  (table) => [
    index('idx_agent_jobs_entity_id').on(table.entityId),
    index('idx_agent_jobs_entity_created').on(table.entityId, sql`${table.createdAt} DESC`),
    index('idx_agent_jobs_entity_status_created').on(
      table.entityId,
      table.status,
      sql`${table.createdAt} DESC`,
    ),
    index('idx_agent_jobs_parent_job_id').on(table.parentJobId),
    // Migration 0059: the Jobs page groups conversational jobs by
    // (entity_id, conversation_id) — this index serves that lookup directly.
    index('idx_agent_jobs_entity_conversation').on(table.entityId, table.conversationId),
    // idx_jobs_parent (F-20, audit #2) was an exact duplicate of
    // idx_agent_jobs_parent_job_id above — same column, same order, both from
    // migration 0000. Dropped in migration 0054; kept this one (matches the
    // idx_agent_jobs_* naming convention used everywhere else on this table).
    index('idx_jobs_status').on(table.status, table.createdAt),
    // DB-3 (audit #2): findUndeliveredRootJobIds (cron/deliver-results.ts)
    // joins on this column filtered to IS NULL every tick; the cron recovery
    // scans (findPendingJobsToRecover, resetOrphanedJobs, failStalePendingJobs
    // in cron/reset-orphans.ts) also filter by status without an entity_id,
    // which idx_jobs_status (kept above) still serves — completed rows vastly
    // outnumber the still-open ones, so a partial index keyed on the open set
    // stays small regardless of table growth.
    index('idx_agent_jobs_completed_at_null')
      .on(table.completedAt)
      .where(sql`${table.completedAt} IS NULL`),
    // Migration 0070: run-schedules.ts filters by schedule_id every tick — the
    // no-overlap guard (schedule_id + status) and the daily budget rollup
    // (schedule_id + created_at range SUM) had no usable index and seq-scanned
    // the whole table. The (schedule_id, created_at) prefix serves both.
    index('idx_agent_jobs_schedule_created').on(table.scheduleId, table.createdAt),
    // 0093 : « les travaux de ce projet » (compte et dernière activité de la
    // liste des projets) — partiel, la colonne reste NULL sur l'immense
    // majorité des jobs.
    index('idx_agent_jobs_project')
      .on(table.projectId)
      .where(sql`${table.projectId} IS NOT NULL`),
    check(
      'agent_jobs_status_check',
      sql`${table.status} IN ('pending','processing','completed','failed','awaiting_approval','awaiting_delegation','cancelled')`,
    ),
    check(
      'agent_jobs_channel_check',
      sql`${table.channel} IN ('telegram','api','whatsapp','internal','cron','task-board','slack','discord','dashboard','webhook','mcp')`,
    ),
  ],
);

// Self-referential FK (parent_job_id) added separately in migration SQL.
export type AgentJobRow = typeof agentJobs.$inferSelect;
export type AgentJobInsert = typeof agentJobs.$inferInsert;
