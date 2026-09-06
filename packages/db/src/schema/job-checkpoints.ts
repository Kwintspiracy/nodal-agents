// job-checkpoints — l'état d'AVANT d'un tour, retrouvable (P11, plan « De la
// maquette au produit »).
//
// Le filet sous les écritures (packages/checkpoints) photographie déjà chaque
// dossier avant le premier outil mutant d'un tour. Cette table est le seul
// endroit qui relie cette photo au TRAVAIL et au TOUR qui l'ont fait prendre :
// sans elle, le sha ne vivait que dans une ligne de journal console, et la
// carte « 12 fichiers » du fil n'avait rien à comparer pour montrer un diff.
//
// Une ligne par (travail, tour, dossier) — voir la migration 0099 pour le
// pourquoi de cette clé et pourquoi le dossier est du texte libre.

import { pgTable, text, uuid, integer, timestamp, index, unique } from 'drizzle-orm/pg-core';
import { agentJobs } from './jobs.ts';

export const jobCheckpoints = pgTable(
  'job_checkpoints',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    jobId: uuid('job_id')
      .notNull()
      .references(() => agentJobs.id, { onDelete: 'cascade' }),
    /** Le compteur de tour du runner — celui que `ToolContext.turn` porte. */
    turn: integer('turn').notNull(),
    /** Le dossier TEL QUE LE SEAM LE CONNAÎT : chemin absolu, graphie d'origine. */
    workspace: text('workspace').notNull(),
    /** Le commit dans le magasin fantôme — l'état d'avant de ce tour. */
    sha: text('sha').notNull(),
    takenAt: timestamp('taken_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [
    unique('job_checkpoints_job_turn_workspace_unique').on(
      table.jobId,
      table.turn,
      table.workspace,
    ),
    index('idx_job_checkpoints_job').on(table.jobId),
  ],
);

export type JobCheckpointRow = typeof jobCheckpoints.$inferSelect;
export type JobCheckpointInsert = typeof jobCheckpoints.$inferInsert;
