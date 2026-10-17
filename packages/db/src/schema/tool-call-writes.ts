// tool_call_writes — CE QU'UN APPEL D'OUTIL A FAIT À CHAQUE FICHIER QU'IL VISAIT
// (issue #779, migration 0148).
//
// `constated_writes` est la liste des fichiers livrés d'un run (une ligne par
// job, tour et chemin) : elle ne dit pas quel appel a écrit, ni ce qu'il y
// avait avant. Cette table le dit, appel par appel : pour chaque cible FICHIER
// d'un appel qui a tourné, l'empreinte du contenu avant et après. Une chaîne
// de garde se lit alors dans l'ordre `tool_calls.seq` : l'état avant d'un appel
// est l'état après du précédent, et l'état final celui du dernier. Une rupture
// dit qu'autre chose a écrit entre les deux.
//
// Trois états (`absent`, `file`, `unreadable`), et l'empreinte est là si et
// seulement si l'état est `file` : un refus de lecture n'est pas une absence.
// Une commande, un harnais ou un outil MCP qui écrit sans déclarer de cible
// fichier ne laisse AUCUNE ligne : c'est la rupture de chaîne qui le montre.

import { pgTable, text, uuid, timestamp, index, unique, check } from 'drizzle-orm/pg-core';
import { sql } from 'drizzle-orm';
import { agentJobs } from './jobs.ts';
import { toolCalls } from './tool_calls.ts';

/** L'état d'un fichier, tel que le seam l'a lu. */
export type ToolCallFileKind = 'absent' | 'file' | 'unreadable';

export const toolCallWrites = pgTable(
  'tool_call_writes',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    /** La ligne `tool_calls` de l'appel : son ordre se lit sur son `seq`. */
    toolCallId: uuid('tool_call_id')
      .notNull()
      .references(() => toolCalls.id, { onDelete: 'cascade' }),
    jobId: uuid('job_id')
      .notNull()
      .references(() => agentJobs.id, { onDelete: 'cascade' }),
    /** Chemin RÉEL (lien symbolique résolu), slash-normalisé : le même que `constated_writes`. */
    path: text('path').notNull(),
    beforeKind: text('before_kind').notNull().$type<ToolCallFileKind>(),
    beforeSha256: text('before_sha256'),
    afterKind: text('after_kind').notNull().$type<ToolCallFileKind>(),
    afterSha256: text('after_sha256'),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [
    unique('tool_call_writes_call_path_unique').on(table.toolCallId, table.path),
    index('idx_tool_call_writes_job').on(table.jobId),
    index('idx_tool_call_writes_call').on(table.toolCallId),
    check(
      'tool_call_writes_before_kind_check',
      sql`${table.beforeKind} IN ('absent', 'file', 'unreadable')`,
    ),
    check(
      'tool_call_writes_after_kind_check',
      sql`${table.afterKind} IN ('absent', 'file', 'unreadable')`,
    ),
    check(
      'tool_call_writes_before_sha_check',
      sql`(${table.beforeKind} = 'file') = (${table.beforeSha256} IS NOT NULL)`,
    ),
    check(
      'tool_call_writes_after_sha_check',
      sql`(${table.afterKind} = 'file') = (${table.afterSha256} IS NOT NULL)`,
    ),
  ],
);

export type ToolCallWriteRow = typeof toolCallWrites.$inferSelect;
export type ToolCallWriteInsert = typeof toolCallWrites.$inferInsert;
