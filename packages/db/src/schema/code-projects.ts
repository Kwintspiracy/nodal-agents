// code_project_archives — l'archivage UI des projets de l'onglet Code.
//
// Un « projet » est DÉRIVÉ à l'affichage (racine git / workspace des fichiers
// touchés par les sessions de code) — il n'existe pas en base. L'archivage,
// lui, doit survivre aux sessions : une ligne par (workspace, chemin) archivé.
// AUCUN effet sur le dossier réel — désarchiver = supprimer la ligne (0083).

import { pgTable, uuid, text, timestamp, index, unique } from 'drizzle-orm/pg-core';
import { entities } from './entities.ts';

export const codeProjectArchives = pgTable(
  'code_project_archives',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    entityId: uuid('entity_id')
      .notNull()
      .references(() => entities.id, { onDelete: 'cascade' }),
    /** Chemin absolu slash-normalisé du projet (la clé de groupement dérivée). */
    projectPath: text('project_path').notNull(),
    archivedAt: timestamp('archived_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [
    unique('code_project_archives_entity_path_unique').on(table.entityId, table.projectPath),
    index('idx_code_project_archives_entity').on(table.entityId),
  ],
);

export type CodeProjectArchiveRow = typeof codeProjectArchives.$inferSelect;
export type CodeProjectArchiveInsert = typeof codeProjectArchives.$inferInsert;
