-- 0089 — le modèle central du plan « Vérifier & Corriger » : où en est
-- chaque livrable d'un job (table d'état), et la trace de chaque commande de
-- preuve qui l'a établi (verification_runs).
--
-- `job_deliverable_verification_state` : une ligne par livrable d'un job,
-- lisible en un SELECT — jamais reconstituée en rejouant l'historique. Deux
-- familles cohabitent, distinguées par `deliverable_type` :
--
--   MUTABLE (code_project, office_file, document, other) — le livrable se
--   MODIFIE puis se PROUVE : `dirty_generation` avance à chaque écriture,
--   `verified_generation` rattrape quand la preuve passe verte. `outcome`
--   reste NULL.
--
--   ATOMIQUE (outbound_action) — le livrable se TENTE puis se CONSTATE :
--   `outcome` porte prepared → attempted → confirmed | rejected |
--   outcome_unknown. Les deux générations restent NULL.
--
-- Les colonnes propres à l'atomique (outcome, idempotency_key), ainsi que
-- red_streak/repair_attempts, sont créées ICI mais SANS AUCUN ÉCRIVAIN avant
-- les tickets qui les branchent (v6-A pour l'atomique, les passes de
-- réparation pour red_streak/repair_attempts) — une colonne existe avant que
-- quelque chose l'écrive, jamais l'inverse en silence.
--
-- `verification_runs` est la trace D'UNE COMMANDE — modèle direct de
-- llm_calls (une ligne par appel, jamais résumée) : `sequence_id` regroupe
-- les commandes d'une même preuve, `command_rank` les ordonne. `job_id` est
-- ON DELETE SET NULL comme llm_calls.job_id : une preuve exécutée reste un
-- fait audité même après que le job qui l'a demandée a disparu.
--
-- Les deux tables citent EXACTEMENT les listes de
-- packages/shared/src/types/verification.ts dans leurs CHECK.
CREATE TABLE IF NOT EXISTS job_deliverable_verification_state (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  job_id uuid NOT NULL REFERENCES agent_jobs(id) ON DELETE CASCADE,
  deliverable_type text NOT NULL
    CHECK (deliverable_type IN ('code_project','office_file','document','outbound_action','other')),
  canonical_key text NOT NULL,
  outcome text
    CHECK (outcome IS NULL OR outcome IN ('prepared','attempted','confirmed','rejected','outcome_unknown')),
  idempotency_key text,
  display_path_snapshot text,
  dirty_generation integer,
  verified_generation integer,
  decision_status text NOT NULL
    CHECK (decision_status IN ('dirty','green','red','pending_approval','not_configured','infra_error')),
  command_hash_snapshot text,
  red_streak integer NOT NULL DEFAULT 0,
  repair_attempts integer NOT NULL DEFAULT 0,
  tested_epoch integer,
  updated_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (job_id, deliverable_type, canonical_key),
  CONSTRAINT job_deliverable_verification_state_generation_check
    CHECK (verified_generation IS NULL OR verified_generation <= dirty_generation),
  -- La famille du livrable impose sa forme : un ATOMIQUE ne porte jamais de
  -- génération, un MUTABLE ne porte jamais d'outcome.
  CONSTRAINT job_deliverable_verification_state_family_check
    CHECK (
      (deliverable_type = 'outbound_action' AND dirty_generation IS NULL AND verified_generation IS NULL AND outcome IS NOT NULL)
      OR
      (deliverable_type <> 'outbound_action' AND outcome IS NULL AND dirty_generation IS NOT NULL)
    )
);
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS verification_runs (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  job_id uuid REFERENCES agent_jobs(id) ON DELETE SET NULL,
  entity_id uuid REFERENCES entities(id) ON DELETE CASCADE,
  deliverable_type text NOT NULL,
  canonical_key text NOT NULL,
  manifest_hash text,
  sequence_id uuid NOT NULL,
  command_rank integer NOT NULL,
  command text NOT NULL,
  exit_code integer,
  outcome_kind text NOT NULL CHECK (outcome_kind IN ('exit','timeout','spawn_error')),
  stdout_tail text,
  stderr_tail text,
  duration_ms integer,
  verdict text NOT NULL CHECK (verdict IN ('green','red','infra_error')),
  tested_generation integer,
  tested_epoch integer,
  created_at timestamptz NOT NULL DEFAULT now()
);
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS idx_verification_runs_job_created
  ON verification_runs (job_id, created_at);
