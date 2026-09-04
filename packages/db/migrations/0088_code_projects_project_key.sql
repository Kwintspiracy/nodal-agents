-- 0088 — project_key devient l'identité canonique de code_projects, et la
-- table porte désormais la configuration de preuve d'un livrable
-- `code_project` (plan « Vérifier & Corriger », décisions de découpage
-- tranchées le 03/09).
--
-- L'ancienne contrainte d'unicité (0086, `UNIQUE (entity_id, project_path)`,
-- jamais nommée côté SQL — Postgres l'a appelée
-- `code_projects_entity_id_project_path_key`) portait sur le TEXTE EXACT du
-- chemin. Deux écritures du même dossier Windows avec une casse différente
-- créaient donc deux lignes distinctes (revue Codex, 26/08) : masquer l'une ne
-- défaisait pas l'autre, et le projet restait annoncé aux agents malgré le
-- geste de rangement. `project_key` (@nodal-agents/shared, `projectKey()`)
-- porte l'identité réelle — casse repliée UNIQUEMENT pour un chemin Windows
-- (lettre de lecteur ou partage UNC), préservée sur un chemin POSIX.
--
-- Cette migration :
--   ① ajoute les six colonnes (project_key encore NULLABLE — la backfill n'a
--     pas encore tourné) ;
--   ② calcule project_key pour chaque ligne existante, en SQL, EXACTEMENT
--     l'algorithme de packages/shared/src/project-key.ts ;
--   ③ fusionne les doublons de casse hérités : pour chaque (entity_id,
--     project_key), une seule ligne survit — la plus récemment mise à jour
--     (`updated_at DESC`, `id ASC` en cas d'égalité) ;
--   ④ verrouille project_key (NOT NULL) et pose la nouvelle contrainte
--     d'unicité (entity_id, project_key) ;
--   ⑤ retire l'ancienne contrainte (entity_id, project_path) par son VRAI nom,
--     retrouvé dans pg_constraint plutôt que supposé.
--
-- Note explicite : la clause « manifeste identique sinon la ligne perdante est
-- effacée ⇒ pending_approval » n'a RIEN à faire ici — les colonnes verify_*
-- naissent DANS cette même migration (étape ①), donc aucune ligne fusionnée en
-- ③ n'en porte encore. La fusion ne discute que project_path/display_name/
-- hidden, comme avant 0088.
ALTER TABLE code_projects
  ADD COLUMN IF NOT EXISTS project_key text,
  ADD COLUMN IF NOT EXISTS verify_commands jsonb
    CHECK (verify_commands IS NULL OR (jsonb_typeof(verify_commands) = 'array' AND jsonb_array_length(verify_commands) BETWEEN 1 AND 5)),
  ADD COLUMN IF NOT EXISTS verification_epoch integer NOT NULL DEFAULT 0,
  ADD COLUMN IF NOT EXISTS verify_approved_manifest_hash text,
  ADD COLUMN IF NOT EXISTS verify_approved_at timestamptz,
  ADD COLUMN IF NOT EXISTS verify_approved_by uuid REFERENCES users(id) ON DELETE SET NULL;
--> statement-breakpoint
-- ② Backfill : réimplémentation SQL de projectKey() — remplace les
-- antislashs, retire le(s) slash(es) final(aux), replie la casse SEULEMENT
-- pour une lettre de lecteur (`C:/…`) ou un partage UNC (`//serveur/…`).
UPDATE code_projects cp
SET project_key = CASE
  WHEN norm.n ~ '^[A-Za-z]:/' OR norm.n LIKE '//%' THEN lower(norm.n)
  ELSE norm.n
END
FROM (
  SELECT id, regexp_replace(replace(project_path, '\', '/'), '/+$', '') AS n
  FROM code_projects
) norm
WHERE cp.id = norm.id;
--> statement-breakpoint
-- ③ Fusion des doublons : par (entity_id, project_key), ne garder que la
-- ligne la plus récemment mise à jour (id croissant en cas d'exact ex-æquo).
DELETE FROM code_projects cp
USING (
  SELECT id,
         ROW_NUMBER() OVER (
           PARTITION BY entity_id, project_key
           ORDER BY updated_at DESC, id ASC
         ) AS rn
  FROM code_projects
) ranked
WHERE cp.id = ranked.id AND ranked.rn > 1;
--> statement-breakpoint
-- ④ project_key devient l'identité verrouillée.
ALTER TABLE code_projects ALTER COLUMN project_key SET NOT NULL;
--> statement-breakpoint
ALTER TABLE code_projects
  ADD CONSTRAINT code_projects_entity_key_unique UNIQUE (entity_id, project_key);
--> statement-breakpoint
-- ⑤ Retire l'ancienne contrainte (entity_id, project_path) — retrouvée par sa
-- vraie forme dans pg_constraint, jamais supposée par un nom Drizzle qui n'a
-- existé sur aucune base réelle.
DO $$
DECLARE
  old_constraint_name text;
BEGIN
  SELECT con.conname INTO old_constraint_name
  FROM pg_constraint con
  JOIN pg_class rel ON rel.oid = con.conrelid
  WHERE rel.relname = 'code_projects'
    AND con.contype = 'u'
    AND con.conname <> 'code_projects_entity_key_unique'
    AND (
      SELECT array_agg(a.attname ORDER BY a.attname)
      FROM unnest(con.conkey) AS k(attnum)
      JOIN pg_attribute a ON a.attrelid = con.conrelid AND a.attnum = k.attnum
    ) = ARRAY['entity_id', 'project_path']::name[]
  LIMIT 1;

  IF old_constraint_name IS NOT NULL THEN
    EXECUTE format('ALTER TABLE code_projects DROP CONSTRAINT %I', old_constraint_name);
  END IF;
END $$;
