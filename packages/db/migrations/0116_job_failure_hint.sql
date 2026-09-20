-- LE GESTE QU'UN ÉCHEC APPELLE, ÉCRIT PAR LE RUNNER (issue #193).
--
-- Le runner décidait déjà ce geste et le nommait en champ typé
-- (`hint: 'switch_model'`, #119). Le champ voyageait en mémoire jusqu'au
-- parent, et mourait là : `agent_jobs` n'avait pas de colonne pour lui. L'écran
-- le re-DÉDUISAIT du code d'erreur, si bien que la correspondance « ce code
-- appelle ce geste » était écrite deux fois — au site du refus dans le runner,
-- et dans `apps/web/src/lib/failure-hint.ts`. Les deux ne pouvaient pas se
-- contredire, mais un geste ajouté d'un côté restait muet de l'autre.
--
-- Pas de CHECK sur les valeurs : un runner plus récent que l'écran peut nommer
-- un geste que l'écran ne connaît pas, et l'écran se tait alors. Contraindre
-- ici ferait échouer l'écriture de l'échec lui-même.
ALTER TABLE "agent_jobs" ADD COLUMN IF NOT EXISTS "failure_hint" text;
--> statement-breakpoint

-- LE RATTRAPAGE, UNE FOIS, ICI ET NULLE PART AILLEURS.
--
-- Les jobs échoués avant cette migration n'ont pas de geste écrit : l'écran
-- les rendrait muets alors qu'il disait quelque chose hier (#184). La
-- déduction disparaît donc du code, mais elle passe une dernière fois sur les
-- lignes déjà là — le seul fait persisté de ce refus est son code d'erreur, et
-- `providerRejectionCode` en est le seul auteur.
--
-- `LIKE 'provider_rejected_request:%'` porte ses DEUX-POINTS : un futur
-- `provider_rejected_request_autre_chose` n'est pas ce refus-là. Borné à
-- `status = 'failed'` — le code n'a de sens que sur un job mort.
UPDATE "agent_jobs"
  SET "failure_hint" = 'switch_model'
  WHERE "status" = 'failed'
    AND "error" LIKE 'provider_rejected_request:%'
    AND "failure_hint" IS NULL;
