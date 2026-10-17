// tool_call_reads — CE QU'UN APPEL D'OUTIL A LU (migration 0149, le pendant de
// `tool_call_writes`).
//
// Une ligne = un fichier qu'un appel a lu avec succès : son chemin RÉEL (la
// même forme que `tool_call_writes.path`) et l'empreinte sha-256 des octets
// LUS, rapportée par le lecteur lui-même (`ToolContext.reportReadContent`),
// jamais une relecture du disque. Le lien à la ligne `tool_calls` donne l'outil
// et l'ordre (`seq`). Une lecture ratée ne laisse aucune ligne. Ce qu'une
// commande, un harnais ou un outil MCP lit n'est pas ici : la plateforme
// n'ouvre pas ces fichiers elle-même.
//
// Avec le chemin ET l'empreinte, un lecteur de cette table distingue le fichier
// posé (son chemin réel) d'une copie identique ailleurs (un autre chemin), et
// le fichier intact d'un fichier modifié avant la lecture (une autre empreinte).

import { pgTable, text, uuid, timestamp, index, unique, check } from 'drizzle-orm/pg-core';
import { sql } from 'drizzle-orm';
import { agentJobs } from './jobs.ts';
import { toolCalls } from './tool_calls.ts';

export const toolCallReads = pgTable(
  'tool_call_reads',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    /** La ligne `tool_calls` de l'appel : son outil, et son ordre (`seq`). */
    toolCallId: uuid('tool_call_id')
      .notNull()
      .references(() => toolCalls.id, { onDelete: 'cascade' }),
    jobId: uuid('job_id')
      .notNull()
      .references(() => agentJobs.id, { onDelete: 'cascade' }),
    /** Chemin RÉEL (lien symbolique résolu), slash-normalisé : le même que `tool_call_writes`. */
    path: text('path').notNull(),
    /** L'empreinte sha-256 des octets LUS, en hexadécimal minuscule. */
    sha256: text('sha256').notNull(),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [
    unique('tool_call_reads_call_path_unique').on(table.toolCallId, table.path),
    index('idx_tool_call_reads_job').on(table.jobId),
    index('idx_tool_call_reads_path').on(table.path),
    check('tool_call_reads_sha256_check', sql`${table.sha256} ~ '^[0-9a-f]{64}$'`),
  ],
);

export type ToolCallReadRow = typeof toolCallReads.$inferSelect;
export type ToolCallReadInsert = typeof toolCallReads.$inferInsert;
