// code_projects — les deux gestes que le produit ne peut pas poser à ta place,
// et depuis la migration 0088, l'identité canonique et la configuration de
// preuve du livrable « code_project » pour le plan « Vérifier & Corriger ».
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
// Une ligne n'existe que si au moins un des deux gestes a été posé, OU qu'une
// configuration de preuve a été déclarée — la table reste vide sur une install
// qui ne renomme, ne masque, ni ne configure rien.
//
// `project_key` (0088) est la clé d'IDENTITÉ, produite par `projectKey()`
// (@nodal-agents/shared) — jamais l'égalité de texte sur `project_path`, qui
// laissait deux casses du même dossier Windows créer deux lignes (revue Codex,
// 26/08). C'est elle que porte la nouvelle contrainte d'unicité, et c'est elle
// que la finalisation d'un job (T09) utilise pour retrouver la configuration
// de preuve d'un livrable `code_project`.
//
// `verify_commands` est la séquence de preuve (v5-A, VerifyCommand[] —
// @nodal-agents/shared) déclarée par le propriétaire — 1 à 5 commandes
// ordonnées, exécutées jusqu'au premier rouge. NULL = pas encore configurée
// (`not_configured`). `verification_epoch` s'incrémente à chaque changement de
// configuration ; `verify_approved_manifest_hash` est l'empreinte (D1,
// hashVerificationManifest) de la révision exacte que le propriétaire a
// approuvée — toute divergence retombe en `pending_approval`, jamais exécutée
// sans re-validation.
import {
  pgTable,
  uuid,
  text,
  boolean,
  timestamp,
  integer,
  jsonb,
  index,
  unique,
  check,
} from 'drizzle-orm/pg-core';
import { sql } from 'drizzle-orm';
import type { VerifyCommand } from '@nodal-agents/shared';
import { entities } from './entities.ts';
import { users } from './users.ts';
import { agents } from './agents.ts';
import { agentJobs } from './jobs.ts';

export const codeProjects = pgTable(
  'code_projects',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    entityId: uuid('entity_id')
      .notNull()
      .references(() => entities.id, { onDelete: 'cascade' }),
    /** Chemin absolu slash-normalisé du projet (la valeur AFFICHÉE — jamais recasée après coup). */
    projectPath: text('project_path').notNull(),
    /**
     * Clé d'identité canonique — `projectKey(project_path)`. Porte la
     * contrainte d'unicité (0088) ; `project_path` reste le texte tel qu'il a
     * été écrit la première fois, uniquement pour l'affichage.
     */
    projectKey: text('project_key').notNull(),
    /** Nom choisi par le propriétaire. NULL = nom du dossier. */
    displayName: text('display_name'),
    /** Masqué de la liste ET du contexte injecté aux agents. */
    hidden: boolean('hidden').notNull().default(false),
    /** Séquence de preuve déclarée (v5-A). NULL = livrable `not_configured`. */
    verifyCommands: jsonb('verify_commands').$type<VerifyCommand[] | null>(),
    /** Incrémenté à chaque changement de `verify_commands` — invalide l'approbation en cours. */
    verificationEpoch: integer('verification_epoch').notNull().default(0),
    /** Empreinte (D1) de la révision exacte approuvée par le propriétaire. */
    verifyApprovedManifestHash: text('verify_approved_manifest_hash'),
    verifyApprovedAt: timestamp('verify_approved_at', { withTimezone: true }),
    /** SET NULL : l'utilisateur approbateur peut disparaître, l'approbation reste tracée. */
    verifyApprovedBy: uuid('verify_approved_by').references(() => users.id, {
      onDelete: 'set null',
    }),
    /**
     * Ce que le projet PRODUIT — du code, ou des documents (0093).
     *
     * Le registre n'est pas réservé au code : un dossier de documents est un
     * projet au même titre, avec le même terrain et le même rattachement. La
     * colonne existe pour que l'écran le dise, jamais pour que le runtime en
     * déduise un comportement — c'est l'outil qui déclare ce qu'il produit
     * (`deliverableType`), pas le dossier où il écrit.
     */
    kind: text('kind').notNull().default('code'),
    /**
     * L'agent responsable : celui dont le terrain contient ce projet. SET NULL
     * — supprimer un agent coupe le lien, il n'emporte pas le projet.
     */
    agentId: uuid('agent_id').references(() => agents.id, { onDelete: 'set null' }),
    /**
     * LE discriminant du registre (0093). NULL = ligne de COMPTABILITÉ (un
     * renommage, un masquage, une configuration de preuve, ou la ligne créée
     * toute seule par l'intention de mutation quand une écriture atterrit dans
     * une racine dérivée) ; NOT NULL = projet DÉCLARÉ, celui qu'un écran liste
     * et auquel un travail se rattache.
     *
     * Aucun lecteur existant ne regarde cette colonne : l'onglet Code et la
     * vérification continuent de lire la ligne par clé, exactement comme avant.
     */
    registeredAt: timestamp('registered_at', { withTimezone: true }),
    /** D'où vient la déclaration : `spaces` (l'écran) ou `conversation` (P6). NULL si non enregistré. */
    registeredFrom: text('registered_from').$type<'spaces' | 'conversation' | null>(),
    /**
     * Le job qui a déclaré ce projet, quand la déclaration vient d'une
     * conversation. SET NULL : la purge des vieux jobs ne doit pas désinscrire
     * un projet vivant.
     */
    registeredJobId: uuid('registered_job_id').references(() => agentJobs.id, {
      onDelete: 'set null',
    }),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [
    // Remplace l'ancien code_projects_entity_path_unique (texte exact,
    // 0086) — la migration 0088 le retire par son vrai nom Postgres
    // (code_projects_entity_id_project_path_key, jamais nommé côté Drizzle).
    unique('code_projects_entity_key_unique').on(table.entityId, table.projectKey),
    index('idx_code_projects_entity').on(table.entityId),
    // Index PARTIEL (0093) : la liste des projets ne lit que les lignes
    // enregistrées, qui resteront minoritaires devant la comptabilité produite
    // par les écritures.
    index('idx_code_projects_registered')
      .on(table.entityId)
      .where(sql`${table.registeredAt} IS NOT NULL`),
    check('code_projects_kind_check', sql`${table.kind} IN ('code','documents')`),
    check(
      'code_projects_registered_from_check',
      sql`${table.registeredFrom} IS NULL OR ${table.registeredFrom} IN ('spaces','conversation')`,
    ),
    check(
      'code_projects_verify_commands_check',
      sql`${table.verifyCommands} IS NULL OR (jsonb_typeof(${table.verifyCommands}) = 'array' AND jsonb_array_length(${table.verifyCommands}) BETWEEN 1 AND 5)`,
    ),
  ],
);

export type CodeProjectRow = typeof codeProjects.$inferSelect;
export type CodeProjectInsert = typeof codeProjects.$inferInsert;
