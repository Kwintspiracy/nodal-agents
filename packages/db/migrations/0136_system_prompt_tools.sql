-- Le prompt stocké d'un job porte la liste d'outils pour laquelle il a été
-- écrit (#559, revue Codex passe 1, P1 2).
--
-- `executeJob` réutilise `system_prompt` à chaque reprise (approbation,
-- délégation, redémarrage) pour garder le cache de préfixe. Or ce prompt ne
-- nomme que les outils du job AU MOMENT où il a été écrit : une skill ou un
-- connecteur retiré pendant l'attente, et la reprise ordonnait un outil que la
-- liste recalculée refuse. La liste triée des noms, posée ici avec le prompt,
-- permet de le réécrire quand elle a changé, et seulement dans ce cas.
--
-- NULL : prompt écrit avant cette colonne. On ne sait pas pour quels outils,
-- donc la reprise le réécrit (côté sûr ; une seule fois par job).
--
-- 0134 et 0135 sont prises par des branches ouvertes (#444, #566).
ALTER TABLE agent_jobs
  ADD COLUMN IF NOT EXISTS system_prompt_tools text[];
