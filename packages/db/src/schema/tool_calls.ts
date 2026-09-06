// tool_calls table — individual tool invocations within a job

import { pgTable, text, uuid, integer, jsonb, timestamp, index, check } from 'drizzle-orm/pg-core';
import { sql } from 'drizzle-orm';
import { entities } from './entities.ts';
import { agentJobs } from './jobs.ts';

export const toolCalls = pgTable(
  'tool_calls',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    entityId: uuid('entity_id').references(() => entities.id, { onDelete: 'cascade' }),
    jobId: uuid('job_id').references(() => agentJobs.id, { onDelete: 'cascade' }),
    toolName: text('tool_name').notNull(),
    toolInput: jsonb('tool_input'),
    toolOutput: text('tool_output'),
    durationMs: integer('duration_ms'),
    turn: integer('turn'),
    // The AI SDK tool-call id of the originating tool_use block (étape D):
    // makes this row JOINABLE to the transcript message and to llm_calls by
    // turn — the full-copy tool_output was previously unlinkable.
    toolCallId: text('tool_call_id'),
    // P1 (plan « De la maquette au produit ») : la carte DÉCLARÉE par l'outil
    // et la charge utile que son present() a tirée de la sortie — persistées
    // ici pour que l'écran lise la ligne sans rejouer l'outil ni connaître son
    // nom. null sur les lignes antérieures à 0092 et sur celles que
    // l'enregistreur vivant du CLI écrit sans sortie exploitable : l'écran le
    // dit tel quel (entrée et sortie brutes), il n'invente pas une carte.
    card: text('card'),
    presented: jsonb('presented'),
    // L'échec du présentateur, s'il y en a eu un : `presented` est alors NULL et
    // CETTE colonne dit pourquoi — requêtable, pas seulement loggée (revue
    // passe 14). NULL = aucune erreur (charge présente, ou rien à présenter).
    presentationError: text('presentation_error'),
    // P7 (0095) : le niveau de risque DÉCLARÉ par l'outil (`read` | `write` |
    // `destructive`), tel quel. Pourquoi : l'écran doit dire si un tour a fait
    // sortir quelque chose du chat, et un connecteur tiers ne déclare que la
    // carte `generic` — la même pour une lecture et pour une écriture. Son
    // niveau de risque est alors le seul classement possible. NULL sur les
    // lignes antérieures à 0095 et sur les lignes `cli:*` (écrites hors
    // registre) : l'écran dit « incertain » plutôt que de deviner.
    riskLevel: text('risk_level'),
    createdAt: timestamp('created_at', { withTimezone: true }).defaultNow(),
  },
  (table) => [
    index('idx_tool_calls_entity_id').on(table.entityId),
    index('idx_tool_calls_job').on(table.jobId),
    index('idx_tool_calls_job_created').on(table.jobId, sql`${table.createdAt} DESC`),
    index('idx_tool_calls_recent').on(sql`${table.createdAt} DESC`),
    check(
      'tool_calls_risk_level_check',
      sql`${table.riskLevel} IS NULL OR ${table.riskLevel} IN ('read','write','destructive')`,
    ),
  ],
);

export type ToolCallRow = typeof toolCalls.$inferSelect;
export type ToolCallInsert = typeof toolCalls.$inferInsert;
