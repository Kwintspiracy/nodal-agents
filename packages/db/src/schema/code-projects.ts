// code_projects — les deux gestes que le produit ne peut pas poser à ta place.
//
// Un « projet » est DÉRIVÉ à l'affichage : c'est la racine commune des fichiers
// touchés par les sessions de code. Il n'existe pas en base, et il n'a pas à y
// exister — il apparaît dès qu'un agent écrit quelque part, disparaît quand le
// dossier disparaît, sans qu'aucune ligne ne soit à tenir à jour.
//
// Restent deux décisions qui n'appartiennent qu'au propriétaire, parce
// qu'aucun indice dans le système ne les donne (0086 raconte les six tentatives
// de devinette et pourquoi elles ont toutes été écartées) :
//
//   RENOMMER — le nom du dossier n'est pas toujours le nom du projet.
//              `display_name` NULL = on affiche le nom du dossier.
//   MASQUER  — ce qu'on ne veut plus voir. Le dossier n'est JAMAIS touché :
//              c'est un choix d'affichage, réversible en un clic.
//
// Le masquage porte plus loin que l'ancien archivage (0083), qui n'était lu que
// par l'interface : il retire aussi le projet du bloc `## Runtime` injecté aux
// agents. Ranger un projet et continuer à l'annoncer dans le prompt de tout le
// monde n'avait pas de sens.
//
// Une ligne n'existe que si au moins un des deux gestes a été posé : la table
// reste vide sur une install qui ne renomme ni ne masque rien.

import { pgTable, uuid, text, boolean, timestamp, index, unique } from 'drizzle-orm/pg-core';
import { entities } from './entities.ts';

export const codeProjects = pgTable(
  'code_projects',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    entityId: uuid('entity_id')
      .notNull()
      .references(() => entities.id, { onDelete: 'cascade' }),
    /** Chemin absolu slash-normalisé du projet (la clé de groupement dérivée). */
    projectPath: text('project_path').notNull(),
    /** Nom choisi par le propriétaire. NULL = nom du dossier. */
    displayName: text('display_name'),
    /** Masqué de la liste ET du contexte injecté aux agents. */
    hidden: boolean('hidden').notNull().default(false),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [
    unique('code_projects_entity_path_unique').on(table.entityId, table.projectPath),
    index('idx_code_projects_entity').on(table.entityId),
  ],
);

export type CodeProjectRow = typeof codeProjects.$inferSelect;
export type CodeProjectInsert = typeof codeProjects.$inferInsert;
