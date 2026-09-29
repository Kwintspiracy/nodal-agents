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
--> statement-breakpoint
-- RATTRAPAGE des lignes écrites avant cette colonne (revue Codex de #576,
-- passe 2). La relecture du fil garde les 8 derniers tours d'une conversation
-- sans limite d'âge : sans ce rattrapage, un avis posé hier resterait dans la
-- bouche de l'agent. Chaque motif est le format EXACT que le runner écrit,
-- ancré à la FIN du résultat et précédé d'une ligne vide (ou seul) : une
-- ligne qui lui ressemble au milieu d'un texte de l'agent n'est pas touchée.
-- Chaînes SQL standard (pas E'…') : `\n`, `\[`, `\]` y sont des échappements
-- de l'expression régulière, lus par le moteur de Postgres.
--
-- Chaque motif est borné par ce que SON producteur peut y mettre (revue Codex
-- de #576, passe 3) : un motif « une seule ligne » manquait une ligne du
-- runner dont une partie variable est multiligne.
--
-- 1. L'avis d'échec de délégation — stampFailedDelegations (execute.ts),
--    format inchangé depuis 76761ae9 :
--      `${texte}\n\n[delegation stopped: ${noms} — no deliverable]`, ou l'avis seul.
--    `noms` sont des noms d'outils `assign_<slug>` joints par ', ' : ni saut
--    de ligne ni `]` possibles, le motif d'une ligne est donc complet.
UPDATE agent_jobs
SET runner_notes = ARRAY[substring(result FROM '(\[delegation stopped: [^]\n]+ — no deliverable\])$')]
WHERE runner_notes IS NULL
  AND result ~ '(^|\n\n)\[delegation stopped: [^]\n]+ — no deliverable\]$';
--> statement-breakpoint
-- 2. L'explication générique de failJob (state.ts, genericFailExplanation),
--    format inchangé depuis 173b83a9 — le résultat ENTIER, sur un job échoué :
--      `⚠️ The task could not be completed (${errorCode}) and no explanation was provided.`
--    `errorCode` peut porter un détail multiligne (`shell_policy_invalid:
--    ${detail}`). failJob écrit le même code dans `error` : le résultat attendu
--    se RECONSTRUIT depuis la ligne elle-même, sans motif. Le motif ancré sur
--    le résultat entier (`.` y traverse les sauts de ligne) couvre un `error`
--    que l'assainissement des octets aurait rendu différent du texte.
UPDATE agent_jobs
SET runner_notes = ARRAY[result]
WHERE runner_notes IS NULL
  AND status = 'failed'
  AND (
    result = '⚠️ The task could not be completed (' || error || ') and no explanation was provided.'
    OR result ~ '^⚠️ The task could not be completed \(.*\) and no explanation was provided\.$'
  );
--> statement-breakpoint
-- 3. La ligne d'un livrable déclaré non vérifié (finalize.ts,
--    deliverableNotVerifiedLine, depuis c0c79857), ajoutée au texte du run :
--      `${texte}\n\n[stopped: declared deliverable not verified — ${faits}]`, ou la ligne seule.
--    `faits` embarque tel quel la fin du stderr d'un vérificateur : MULTILIGNE,
--    et il peut contenir `]`. Le motif traverse donc les sauts de ligne jusqu'au
--    `]` final, et la ligne capturée est la DERNIÈRE qui commence par l'en-tête
--    après une ligne vide : un texte de l'agent qui en cite une plus haut reste
--    à l'agent (prouvé par thread-history-runner-notes.pg.test.ts). Seuls les
--    jobs échoués à cette porte portent cette ligne : `error` le borne.
UPDATE agent_jobs
SET runner_notes = ARRAY[substring(result FROM '^(?:.*\n\n)?(\[stopped: declared deliverable not verified — .*\])$')]
WHERE runner_notes IS NULL
  AND status = 'failed'
  AND error = 'deliverable_not_verified'
  AND result ~ '^(?:.*\n\n)?\[stopped: declared deliverable not verified — .*\]$';
