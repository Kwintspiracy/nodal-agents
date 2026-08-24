-- 0083 — archives de projets de l'onglet Code (décision Quentin 25/08).
-- Un « projet » est DÉRIVÉ à l'affichage (racine git / workspace des fichiers
-- touchés) — il n'existe pas en base. L'archivage, lui, est un état UI qui
-- doit survivre : une ligne par (workspace, chemin de projet) archivé.
-- AUCUN effet sur le dossier réel — désarchiver = supprimer la ligne.
CREATE TABLE IF NOT EXISTS "code_project_archives" (
  "id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
  "entity_id" uuid NOT NULL REFERENCES "entities"("id") ON DELETE CASCADE,
  "project_path" text NOT NULL,
  "archived_at" timestamp with time zone DEFAULT now() NOT NULL,
  CONSTRAINT "code_project_archives_entity_path_unique" UNIQUE ("entity_id", "project_path")
);
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "idx_code_project_archives_entity" ON "code_project_archives" ("entity_id");
