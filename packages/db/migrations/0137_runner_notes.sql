-- Ce que le RUNNER a ajouté au résultat d'un job, à part du texte de l'agent
-- (#562, décision du 28/09).
--
-- `stampFailedDelegations` ajoute au résultat la ligne
-- `[delegation stopped: … — no deliverable]` : les écrans la lisent là, c'est
-- voulu (#108). Mais le résultat relu au tour suivant du fil était pris pour
-- les mots de l'agent, ligne du harnais comprise — le mécanisme de #562. Cette
-- colonne dit, exactement, quelles lignes du résultat sont du runner : la
-- relecture les retire des mots de l'agent et les range dans le relevé du
-- runner.
--
-- NULL : rien d'ajouté par le runner (ou job antérieur à cette colonne).
-- 0134, 0135 et 0136 sont prises par des branches ouvertes (#444, #566, #570).
ALTER TABLE agent_jobs
  ADD COLUMN IF NOT EXISTS runner_notes text[];
