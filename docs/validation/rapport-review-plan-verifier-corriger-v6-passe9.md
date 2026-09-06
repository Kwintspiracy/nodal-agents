## Section 1 — Suivi des constats de la passe 8

| Constat | Verdict | Preuve |
|---|---|---|
| Q1 | FERMÉ | Les écrivains et moments transactionnels de `prepared`, `attempted`, `confirmed`, `rejected` et `outcome_unknown` sont désormais explicitement désignés ; le reaper ne modifie ni ne rejoue une ligne `attempted` (`docs/plans/verifier-corriger.md:173-189`). |
| Q3 | FERMÉ | `review_pending` figure dans l’union typée (`docs/plans/verifier-corriger.md:423-427`) et la reprise du cron est spécifiée (`docs/plans/verifier-corriger.md:467-479`). |
| Q5 | FERMÉ | PR④ impose un incrément unique de `review_rounds` par cycle exigeant correction, jamais par verdict (`docs/plans/verifier-corriger.md:594-599`). |
| Q7 | FERMÉ | PR① reprend le manifeste normatif comprenant `invariants`, avec un hash et une approbation uniques (`docs/plans/verifier-corriger.md:496-505`). |
| Q10 | FERMÉ | PR④ repose désormais uniquement sur `requestReview`, sans whitelist recalculée, avec `snapshot_id` et incrément par cycle (`docs/plans/verifier-corriger.md:580-605`). |
| Bloquant — deux contrats de hash | FERMÉ | Le contrat PR① est aligné sur v6-A : `{verifierConfig, invariants, canonicalKey, cwd, shellPolicyVersion, envAllowlistVersion}`, `invariants` étant toujours présent (`docs/plans/verifier-corriger.md:496-505`). |

## Section 2 — Cohérence résiduelle

Une contradiction demeure dans la section explicitement dite « conservée » :

> « prédicat par projet […] lignée structurée + `content_id` […] manifeste 5 champs » (`docs/plans/verifier-corriger.md:699-706`).

Cette phrase contredit simultanément les prédicats par livrable (`docs/plans/verifier-corriger.md:429-444`), le remplacement de `content_id` par `snapshot_id` (`docs/plans/verifier-corriger.md:263-270`) et le manifeste normatif à six champs (`docs/plans/verifier-corriger.md:496-502`).

Aucune autre contradiction résiduelle relevée dans le modèle central, le protocole transactionnel, PR①, PR③, PR④, la matrice des écrivains ou le contrat par surface.

## Section 3 — Cron

Scénario de root jamais livré :

1. Le cron appelle la primitive.
2. La primitive rend `completed` ou `completed_unverified` et écrit immédiatement le statut terminal ainsi que `completedAt` (`docs/plans/verifier-corriger.md:471-472`).
3. Le processus tombe avant l’appel de livraison du cron.
4. Au tick suivant, la garde de réclamation exige `completedAt IS NULL AND status NOT IN terminal` (`docs/plans/verifier-corriger.md:467-470`) : ce root devenu terminal n’est donc jamais réclamé de nouveau.

Le plan ne prévoit ni outbox de livraison ni marqueur distinct attestant que la livraison canal a effectivement réussi. Le test nommé ne couvre que `review_pending` et la reprise après clôture (`docs/plans/verifier-corriger.md:478-479`), pas cette fenêtre entre commit terminal et livraison.

## Section 4 — Constats neufs bloquants pour PR①

1. **La livraison terminale du cron n’est pas reprise après crash.** L’écriture de `completedAt` précède la livraison, tandis que cette même valeur exclut le root des réclamations futures (`docs/plans/verifier-corriger.md:467-472`). PR① doit rendre atomique ou idempotente la séquence décision terminale/livraison, par exemple au moyen d’un état ou d’un outbox de livraison distinct.

Passe 9 : 1 constats neufs bloquants
