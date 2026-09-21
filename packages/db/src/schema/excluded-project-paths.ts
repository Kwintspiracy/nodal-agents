// excluded_project_paths — LES DOSSIERS QUE LA DÉTECTION NE PROPOSE PLUS
// (issue #385).
//
// La page Projects liste deux choses : le REGISTRE (`code_projects`, des lignes
// que quelqu'un a déclarées) et la DÉTECTION (des dossiers déduits des
// écritures passées des agents, qui n'ont aucune ligne à eux). Oublier un
// projet (#371) supprime sa ligne de registre — et la détection, qui ne lit pas
// le registre, le ramenait aussitôt marqué « Detected », avec Register et Hide
// offerts de nouveau. Le geste ne tenait pas.
//
// Cette table porte la seule chose qui manquait : le fait qu'une PERSONNE a
// écarté ce dossier. Ce n'est pas un masquage — `code_projects.hidden` est un
// réglage d'une ligne du registre, et un dossier détecté n'en a pas — et ce
// n'est pas une suppression, puisque le dossier reste exactement où il est sur
// le disque.
//
// UNE LIGNE = UN DOSSIER ÉCARTÉ DANS UN ESPACE. L'unicité porte sur
// (`entity_id`, `project_key`), la clé d'IDENTITÉ, jamais sur `project_path` :
// c'est la même règle que le registre depuis la migration 0088, et pour la même
// raison — sous Windows, le même dossier remonte avec des casses différentes
// selon la session, et une unicité sur le texte en ferait deux exclusions dont
// une seule serait lue. `project_path` est gardé à côté, tel qu'il a été écrit,
// parce que c'est lui que l'écran affiche.
//
// RÉVERSIBLE EN UN CLIC : « Detect again » supprime la ligne, et la détection
// reprend son cours. Rien n'est perdu en silence.

import { pgTable, uuid, text, timestamp, index, unique } from 'drizzle-orm/pg-core';
import { entities } from './entities.ts';

export const excludedProjectPaths = pgTable(
  'excluded_project_paths',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    entityId: uuid('entity_id')
      .notNull()
      .references(() => entities.id, { onDelete: 'cascade' }),
    /** Chemin absolu slash-normalisé, tel qu'il s'affiche — jamais recasé après coup. */
    projectPath: text('project_path').notNull(),
    /** `projectKey(project_path)` — l'identité, et ce que porte l'unicité. */
    projectKey: text('project_key').notNull(),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [
    unique('excluded_project_paths_entity_key_unique').on(table.entityId, table.projectKey),
    index('idx_excluded_project_paths_entity').on(table.entityId),
  ],
);

export type ExcludedProjectPathRow = typeof excludedProjectPaths.$inferSelect;
export type ExcludedProjectPathInsert = typeof excludedProjectPaths.$inferInsert;
