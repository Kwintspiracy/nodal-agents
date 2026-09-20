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

import { pgTable, text, uuid, integer, timestamp, index, unique, check } from 'drizzle-orm/pg-core';
import { sql } from 'drizzle-orm';
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
    /**
     * COMBIEN DE TEMPS LA PHOTO A PRIS, en millisecondes (#261, migration 0119).
     *
     * Mesurée autour du seul appel de `snapshot`, aux deux endroits qui
     * photographient : le seam de `packages/tools` et le harnais CLI du runner.
     *
     * Elle existe pour que la montée d'un dossier SE VOIE avant qu'elle ne
     * refuse quoi que ce soit : `git add` est borné à 30 secondes, et jusqu'ici
     * la durée ne vivait que sur le chemin d'ÉCHEC, en mémoire, le temps de
     * rendre la phrase du refus. Une photo qui réussit en 24 secondes ne
     * laissait aucune trace — le cas qu'il faut justement voir venir.
     *
     * NULL = pas mesurée (une ligne d'avant la colonne). L'écran le dit ; il
     * n'affiche jamais un zéro, qui se lirait « instantané » (invariant #4).
     */
    snapshotMs: integer('snapshot_ms'),
  },
  (table) => [
    unique('job_checkpoints_job_turn_workspace_unique').on(
      table.jobId,
      table.turn,
      table.workspace,
    ),
    index('idx_job_checkpoints_job').on(table.jobId),
    // 0119 (#261) : « la dernière photo de cet espace », un `ORDER BY taken_at
    // DESC LIMIT 1` par espace. Sans lui, le parcours dégénère pour un espace
    // SILENCIEUX — dont la dernière photo est justement la plus ancienne, donc
    // la plus loin (revue C, passe 2 de la PR #324).
    index('idx_job_checkpoints_taken_at').on(sql`${table.takenAt} DESC`),
    // La durée est un CONSTAT, jamais négative. Pas de borne supérieure : une
    // photo peut légitimement durer plus que le budget de `git add`, et une
    // borne inventée refuserait la ligne au moment où elle intéresse le plus.
    check(
      'job_checkpoints_snapshot_ms_check',
      sql`${table.snapshotMs} IS NULL OR ${table.snapshotMs} >= 0`,
    ),
  ],
);

export type JobCheckpointRow = typeof jobCheckpoints.$inferSelect;
export type JobCheckpointInsert = typeof jobCheckpoints.$inferInsert;
