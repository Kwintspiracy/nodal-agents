## Section 1 — Suivi Q1-Q11

| Constat | Verdict | Preuve |
|---|---|---|
| Q1 | PARTIEL | Le plan introduit bien `prepared → attempted → confirmed \| rejected \| outcome_unknown` et la clé d’idempotence persistée avant l’appel (`docs/plans/verifier-corriger.md:164-178`). Il ne désigne toutefois ni l’écrivain de `attempted`, ni celui de `confirmed`, ni leurs moments transactionnels exacts. |
| Q2 | FERMÉ | « `(job_id, deliverable_type, canonical_key)`, UNIQUE ensemble », canonicaliseur par type et refus des types non pris en charge (`docs/plans/verifier-corriger.md:152-162`). |
| Q3 | PARTIEL | Le flux unique est défini : étape de la primitive terminale, suspension en `review_pending`, puis `requestReview` ; la délégation directe est refusée (`docs/plans/verifier-corriger.md:233-246`). Mais `review_pending` manque dans l’union de retour conservée (`docs/plans/verifier-corriger.md:407-410`) et la reprise du cron n’est pas spécifiée. |
| Q4 | FERMÉ | `deliverable_snapshots`, copie immuable, SHA-256 par type et même `snapshot_id` pour les N relecteurs (`docs/plans/verifier-corriger.md:247-254`). |
| Q5 | PARTIEL | Le nouveau contrat ferme le constat : clôture unique du cycle et incrément unique par agrégat (`docs/plans/verifier-corriger.md:259-266`). Mais PR④ conserve la règle contradictoire « incrémenté depuis le verdict persisté `request_changes` » (`docs/plans/verifier-corriger.md:531-534`). |
| Q6 | FERMÉ | Attente fail-closed, relance unique, puis `review_incomplete`, `REVIEW_INCOMPLETE` et escalade humaine sans consommation d’un cycle (`docs/plans/verifier-corriger.md:272-278`). |
| Q7 | PARTIEL | Le manifeste unique et l’approbation atomique sont définis (`docs/plans/verifier-corriger.md:189-194`), mais PR① conserve un hash limité aux cinq champs `{commands, projectKey, cwd, shellPolicyVersion, envAllowlistVersion}`, sans `invariants` (`docs/plans/verifier-corriger.md:447-452`). |
| Q8 | FERMÉ | La garde reste explicitement non branchée en PR① et le test impose qu’un projet rouge finisse encore `completed` tout en journalisant `red` (`docs/plans/verifier-corriger.md:443-446`). Les sorties réelles demeurent bien `completeJob` dans `execute.ts:2919-2926` et `run-job.ts:400`. |
| Q9 | FERMÉ | `modelFamily` indépendant du transport devient obligatoire pour les relecteurs, avec refus fail-closed des familles inconnues ou identiques (`docs/plans/verifier-corriger.md:279-289`). L’absence actuelle est correctement ancrée dans `packages/shared/src/model-catalog.ts:116-119` et `packages/shared/src/model-catalog.ts:1279`. |
| Q10 | PARTIEL | Les constats de code sont correctement repris : `delegate.ts:78-110` est désormais présenté comme point futur d’insertion (`docs/plans/verifier-corriger.md:244-246`), conformément à `packages/orchestration/src/router/delegate.ts:78-112`; le registre de lectures est spécifié (`docs/plans/verifier-corriger.md:198-205`), le schéma réel de `review_verdict` est correctement décrit (`docs/plans/verifier-corriger.md:295-304`; code réel `packages/tools/src/builtin/review-verdict.ts:18-100`) et l’absence actuelle de `finally` est correctement dite (`docs/plans/verifier-corriger.md:502-506`; code réel `apps/runner/src/cli-runtime/run-job.ts:302-332`). Mais PR④ réintroduit ensuite l’ancien calcul de whitelist dans `handleDelegation` et l’ancien `content_id` (`docs/plans/verifier-corriger.md:524-540`). |
| Q11 | FERMÉ | Le schéma actuel est correctement décrit, puis la migration précise backfill, fusion, survivance de `project_path`, traitement du manifeste et nouvel UNIQUE (`docs/plans/verifier-corriger.md:453-470`). Les ancrages sont exacts : `packages/db/src/schema/code-projects.ts:28-46` et `apps/runner/src/job/code-projects.ts:122-125`. |

## Section 2 — Cohérence résiduelle

1. Le contrat de manifeste de PR① contredit v6-A.

   Citation v6-A : « Un **manifeste unique versionné** par livrable-cible : `{verifierConfig (= verify_commands pour le code), invariants, canonicalKey, cwd, shellPolicyVersion, envAllowlistVersion}` » (`docs/plans/verifier-corriger.md:189-192`).

   Citation contradictoire : « des cinq champs `{commands, projectKey, cwd, shellPolicyVersion, envAllowlistVersion}` » (`docs/plans/verifier-corriger.md:447-450`).

   La note de lecture de la table d’état ne peut pas résoudre cette différence de contenu et de hash.

2. PR④ conserve l’ancien déclencheur fondé sur la whitelist.

   Citation : « whitelist effective calculée dans `handleDelegation` ; si elle contient `review_verdict` ⇒ `job_protocol='review'` » (`docs/plans/verifier-corriger.md:524-527`).

   Cela contredit le flux unique où `requestReview` crée exactement N jobs et où toute délégation directe vers un porteur de `review_verdict` est refusée (`docs/plans/verifier-corriger.md:233-246`). Dans le code actuel, `handleDelegation` construit un seul child sans calcul de whitelist (`packages/orchestration/src/router/delegate.ts:78-112`).

3. PR④ conserve l’ancienne sémantique de cycle.

   Citation : « `review_rounds` […] incrémenté depuis le verdict persisté `request_changes` » (`docs/plans/verifier-corriger.md:531-532`).

   Elle contredit l’incrément unique « jamais par verdict » de `review_cycles` (`docs/plans/verifier-corriger.md:259-264`).

4. PR④ conserve l’ancien identifiant de contenu non généralisé.

   Citation : « `{verification_run_id, job_id, project_key, generation, command_hash, content_id}` (`content_id` = git HEAD + hash du diff sale quand dépôt, sinon absent […]`) » (`docs/plans/verifier-corriger.md:535-540`).

   Cela contredit explicitement « `content_id` de la v4 devient `snapshot_id` » et les snapshots obligatoires par type (`docs/plans/verifier-corriger.md:247-254`).

5. La primitive terminale reste formulée exclusivement par projet.

   Citations : « chaque projet sale » (`docs/plans/verifier-corriger.md:412-419`) et « au moins un projet sale » (`docs/plans/verifier-corriger.md:419-420`).

   La note des lignes 334-337 suffit pour interpréter `project_key` dans la table, mais elle ne redéfinit pas les prédicats de retour de la primitive pour les livrables atomiques et leurs états `confirmed`, `rejected` ou `outcome_unknown`.

## Section 3 — Flux unique de revue

Le flux n’est pas compatible en l’état avec l’union typée conservée.

La v6-C dit que la primitive « suspend la finalisation (`review_pending`) » (`docs/plans/verifier-corriger.md:233-238`), tandis que l’union reste :

> « `completed | completed_unverified | already_terminal | verification_due | verification_persistence_failed` » (`docs/plans/verifier-corriger.md:407-410`).

Il faut donc ajouter `review_pending` à l’union, ou définir un autre type de retour explicitement imbriqué. Le plan ne le dit pas.

Le cron est également sous-spécifié. Le plan exige qu’il passe par la primitive (`docs/plans/verifier-corriger.md:425-430`), mais le code actuel calcule `rootStatus`, écrit immédiatement le statut terminal et pose `completedAt` dans la même réclamation (`apps/runner/src/cron/deliver-results.ts:184-211`). Aucun contrat ne précise comment le cron :

- conserve le résultat agrégé sans livrer ;
- crée une seule fois le cycle de revue ;
- reprend après l’agrégation ;
- réclame et livre ensuite le root sans recréer les reviewers.

En l’absence de cette reprise idempotente, un root `review_pending` peut rester non livré ou provoquer une recréation de cycle.

## Section 4 — Modèle atomique

Le plan ne désigne pas suffisamment les écrivains.

Il dit seulement :

> « clé d’idempotence persistée AVANT l’appel (`prepared`), de sorte qu’un runner qui tombe entre l’appel et l’écriture ne rejoue pas l’action et sache qu’il est en `attempted` » (`docs/plans/verifier-corriger.md:172-175`).

Cette phrase ne précise pas :

- que le tool ou le harnais écrit et commit `attempted` immédiatement avant l’appel réseau ;
- que le composant chargé du constat écrit `confirmed` seulement après relecture symétrique ou validation de l’accusé structuré ;
- que `rejected` signifie une absence établie, distincte d’une erreur de constat ;
- que le reaper laisse une ligne `attempted` intacte et ne rejoue jamais l’action ;
- que seule la finalisation transforme un `attempted` résiduel en `outcome_unknown`.

Q1 reste donc partiellement fermé.

## Section 5 — Constats neufs bloquants pour PR①

1. **Deux contrats de hash incompatibles sont assignés à PR①.** Le manifeste v6-A contient `verifierConfig`, `invariants` et `canonicalKey` (`docs/plans/verifier-corriger.md:189-194`), tandis que la section PR① impose encore exactement cinq champs sans `invariants` (`docs/plans/verifier-corriger.md:447-452`). Impossible d’implémenter le schéma, le hash partagé et la migration de fusion de PR① sans choisir lequel est normatif.

Passe 8 : 1 constats neufs bloquants
