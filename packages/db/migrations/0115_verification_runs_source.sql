-- D'où vient une preuve — et la preuve d'un relecteur, enfin enregistrée (#59).
--
-- Sur le run 20b73ed1 (16/09/2026), un relecteur a lancé six scénarios
-- Playwright sur l'application livrée : de loin la preuve la plus solide du
-- run. `verification_runs` portait ZÉRO ligne pour ce job. La seule preuve que
-- le système retenait était le `new Function()` du développeur, qui dit que le
-- JavaScript se parse — la plus faible des deux, et la seule qui comptait.
--
-- L'outil `review_verdict` n'écrit rien par conception, et ce n'est pas un
-- bug : rien n'avait jamais été écrit pour recopier les commandes du relecteur
-- sous le travail qu'il relisait. Ces deux colonnes portent ce chaînon.
--
-- `source` : 'job' pour la preuve que la finalisation lance elle-même (le seul
-- écrivain jusqu'ici, donc le défaut appliqué aux lignes existantes),
-- 'reviewer' pour une commande qu'un relecteur a réellement exécutée.
--
-- `source_job_id` : le job qui a EXÉCUTÉ la commande, quand ce n'est pas
-- `job_id`. L'écran remonte de là à l'agent pour dire d'où vient la preuve ;
-- aucun nom n'est recopié dans la ligne (invariants #1 et #2). `ON DELETE SET
-- NULL` comme `job_id` : une commande qui a tourné reste un fait constaté même
-- si le job du relecteur est effacé.
ALTER TABLE "verification_runs" ADD COLUMN IF NOT EXISTS "source" text NOT NULL DEFAULT 'job';

ALTER TABLE "verification_runs" ADD COLUMN IF NOT EXISTS "source_job_id" uuid
  REFERENCES "agent_jobs"("id") ON DELETE SET NULL;

ALTER TABLE "verification_runs" DROP CONSTRAINT IF EXISTS "verification_runs_source_check";
ALTER TABLE "verification_runs" ADD CONSTRAINT "verification_runs_source_check"
  CHECK ("source" IN ('job','reviewer'));

-- La section Verification d'un run lit ses lignes par `job_id` ; celle-ci
-- répond à l'autre question, « qu'est-ce que CE relecteur a fait tourner ? »,
-- posée par la réécriture idempotente d'un second verdict.
CREATE INDEX IF NOT EXISTS "idx_verification_runs_source_job"
  ON "verification_runs" ("source_job_id");
