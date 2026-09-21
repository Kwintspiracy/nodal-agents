-- COMBIEN DE TOURS DE RÉPARATION UN RUN REÇOIT (issue #377).
--
-- #375 a donné au runner UN tour de réparation après une preuve rouge : le job
-- ne finit pas, l'agent reçoit la commande qui a échoué et sa sortie, il
-- corrige et relivre. La borne était écrite en dur dans `finalize.ts`.
--
-- Quentin, 21/09 : « il faut exposer ces réglages quelque part ». La borne
-- devient donc un réglage de l'espace, à côté du frein d'auto-exécution et des
-- surfaces sous vérification.
--
-- LE DÉFAUT EST 1, c'est-à-dire exactement ce que #375 fait aujourd'hui : une
-- migration ne change le comportement de personne. `0` rend le comportement
-- d'avant #375 (le run finit rouge tout de suite), et c'est une valeur
-- légitime : un espace qui préfère voir l'échec plutôt que de payer un tour de
-- modèle de plus la choisit.
--
-- LE CHECK EST ICI, pas seulement dans le formulaire. Cette colonne borne une
-- boucle du runner (invariant #8, anti-loop) : une valeur de 9 999 écrite par
-- un script ou une main sur `psql` ferait tourner un agent toute la nuit sur
-- une preuve qui ne passera jamais. Trois est le plafond : au-delà, ce n'est
-- plus une réparation, c'est un agent qui devine.
ALTER TABLE "entities"
  ADD COLUMN IF NOT EXISTS "proof_repair_attempts" integer NOT NULL DEFAULT 1;

DO $$
BEGIN
  ALTER TABLE "entities"
    ADD CONSTRAINT "entities_proof_repair_attempts_check"
    CHECK ("proof_repair_attempts" >= 0 AND "proof_repair_attempts" <= 3);
EXCEPTION
  WHEN duplicate_object THEN NULL;
END $$;
