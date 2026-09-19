// constated_writes — LA LISTE DES FICHIERS LIVRÉS D'UN RUN, telle qu'elle a
// été CONSTATÉE, pas telle que l'agent l'a déclarée (issue #199).
//
// Avant cette table, le bloc Files d'un run était reconstruit à l'affichage en
// relisant les lignes `tool_calls` : ce qu'un outil avait NOMMÉ. Un shell qui
// écrit dix fichiers sans les nommer n'y paraissait pas, et un outil qui
// nommait un fichier sans l'écrire y paraissait quand même. La liste montrée à
// la personne était donc une déclaration, jamais un constat.
//
// Une ligne = un fichier, pour un job, avec son genre et LA FAÇON DONT IL A
// ÉTÉ CONSTATÉ. `constated_by` n'est pas un détail d'implémentation : c'est ce
// que l'écran doit dire pour que personne ne lise une liste « disque » comme
// une liste « git » (invariant #4 — l'absence se dit).
//
// POURQUOI LE CHEMIN EST DU TEXTE LIBRE, et pourquoi il n'y a pas de clé
// étrangère vers un projet : le même run peut écrire dans plusieurs dépôts, et
// un projet n'existe en base que si le propriétaire a posé un geste dessus
// (voir `code-projects.ts`). La ligne dit ce qui a été écrit, à charge de
// l'écran de la rattacher.
//
// L'UNICITÉ EST (job, tour, chemin). Un même fichier écrit par deux commandes
// du MÊME tour est un seul fichier livré ; le réécrire au tour suivant est une
// autre ligne, parce que c'est un autre moment du run. Sans cette clé, une
// boucle de dix commandes sur le même fichier faisait dix lignes dans le bloc
// Files.

import { pgTable, text, uuid, integer, timestamp, index, unique } from 'drizzle-orm/pg-core';
import { sql } from 'drizzle-orm';
import { check } from 'drizzle-orm/pg-core';
import type { ConstatedBy, ConstatedChangeKind } from '@nodal-agents/shared';
import { agentJobs } from './jobs.ts';

export const constatedWrites = pgTable(
  'constated_writes',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    jobId: uuid('job_id')
      .notNull()
      .references(() => agentJobs.id, { onDelete: 'cascade' }),
    /** Le compteur de tour du runner — celui que `ToolContext.turn` porte. */
    turn: integer('turn').notNull(),
    /** Chemin ABSOLU slash-normalisé, tel que le constat l'a vu. */
    path: text('path').notNull().$type<string>(),
    /** added | modified | deleted | renamed. */
    changeKind: text('change_kind').notNull().$type<ConstatedChangeKind>(),
    /** git | disk — d'où vient cette ligne, jamais deviné à l'affichage. */
    constatedBy: text('constated_by').notNull().$type<ConstatedBy>(),
    /** Le nom d'avant, pour un renommage seulement. */
    renamedFrom: text('renamed_from'),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [
    unique('constated_writes_job_turn_path_unique').on(table.jobId, table.turn, table.path),
    index('idx_constated_writes_job').on(table.jobId),
    check(
      'constated_writes_change_kind_check',
      sql`${table.changeKind} IN ('added', 'modified', 'deleted', 'renamed')`,
    ),
    check('constated_writes_constated_by_check', sql`${table.constatedBy} IN ('git', 'disk')`),
  ],
);

export type ConstatedWriteRow = typeof constatedWrites.$inferSelect;
export type ConstatedWriteInsert = typeof constatedWrites.$inferInsert;
