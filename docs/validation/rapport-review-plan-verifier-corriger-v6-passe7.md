## Q1 — Modèle dirty/verified pour tous les livrables

**Verdict : TROU**

**Preuve :** le plan généralise l’état à `(job, livrable)` et inclut `outbound_action` ([plan:142-145](D:/APPS/NodalAI/docs/plans/verifier-corriger.md:142)), mais le modèle central reste fondé sur une intention de mutation suivie d’une preuve verte : `dirty_generation`, `verified_generation` et `verified <= dirty` ([plan:236-248](D:/APPS/NodalAI/docs/plans/verifier-corriger.md:236)). Pour une action sortante atomique, la transition « intention écrite → action exécutée → constatée » n’est pas représentée. En particulier, `verified_generation` suppose qu’une génération mutable peut être validée, tandis que l’action peut avoir été exécutée sans que sa lecture symétrique soit possible ou concluante.

Le plan reconnaît seulement que l’action sera « constatée dans le monde » ([plan:153-160](D:/APPS/NodalAI/docs/plans/verifier-corriger.md:153)), sans définir les états distinguant :

- intention persistée mais appel non commencé ;
- appel tenté, issue inconnue ;
- action confirmée ;
- action absente ;
- action exécutée mais impossible à relire.

**Spécification minimale :** définir pour `outbound_action` une machine d’état explicite, par exemple `prepared → attempted → confirmed | rejected | outcome_unknown`, avec un identifiant d’idempotence persisté avant l’appel. Dire comment ces états se projettent dans le résultat terminal sans employer abusivement `dirty_generation`/`verified_generation`.

## Q2 — Identité canonique d’un livrable non-code

**Verdict : TROU**

**Preuve :** le plan donne des types (`code_project`, `office_file`, `outbound_action`, `document`) mais aucune construction de leur identité canonique ([plan:142-145](D:/APPS/NodalAI/docs/plans/verifier-corriger.md:142)). Le seul schéma détaillé demeure `job_id + project_key` ([plan:234-245](D:/APPS/NodalAI/docs/plans/verifier-corriger.md:234)), et l’ordre transactionnel continue à verrouiller `code_projects` par `project_key` ([plan:271-278](D:/APPS/NodalAI/docs/plans/verifier-corriger.md:271)).

Dans le code, `projectKey()` ne couvre que les chemins, avec normalisation de casse Windows ([code-projects.ts:122-125](D:/APPS/NodalAI/apps/runner/src/job/code-projects.ts:122)). Rien ne définit :

- la racine et la normalisation d’un `office_file` ;
- l’identité pré-exécution d’une `outbound_action` ;
- l’identité/version d’un `document` ;
- une clé commune permettant l’UNIQUE et l’ordre des verrous.

PR① ne peut pas honnêtement annoncer un « schéma exact par livrable » tout en ne spécifiant que le code ([plan:37](D:/APPS/NodalAI/docs/plans/verifier-corriger.md:37)).

**Spécification minimale :** PR① peut se limiter à `code_project` si elle crée dès maintenant une identité générique, par exemple `(job_id, deliverable_type, canonical_key)`, où `canonical_key` est opaque pour le cœur et produite par un canonicaliseur propre au type. Définir seulement le canonicaliseur `code_project` en PR① ; réserver les autres sans leur inventer de clé provisoire.

## Q3 — Déclenchement et placement de la revue

**Verdict : TROU**

**Preuve :** deux flux coexistent :

- v4 : une délégation ordinaire devient une revue lorsque la whitelist du child contient `review_verdict` ([plan:412-415](D:/APPS/NodalAI/docs/plans/verifier-corriger.md:412)) ;
- v6-C : « le harnais crée N jobs de revue » à la demande de revue, selon la politique d’espace ([plan:178-190](D:/APPS/NodalAI/docs/plans/verifier-corriger.md:178)).

Le code actuel confirme que `handleDelegation` ne crée qu’un child déterminé par le slug demandé : construction du contenu aux lignes 78-93, puis insertion unique aux lignes 95-112 ([delegate.ts:78](D:/APPS/NodalAI/packages/orchestration/src/router/delegate.ts:78)). Il n’y a actuellement ni calcul de whitelist dans ce fichier, ni expansion en N relecteurs.

Le plan ne dit pas si :

1. la délégation LLM vers un relecteur déclenche l’expansion en N ;
2. la primitive terminale déclenche automatiquement la revue ;
3. un événement distinct `request_review` la déclenche ;
4. la preuve machine doit être verte avant la création du panel.

**Spécification minimale :** définir un flux unique : après preuve machine terminalement admissible, une primitive harnais `requestReview(deliverableSnapshot)` sélectionne la politique, crée exactement N jobs et suspend la finalisation jusqu’à l’agrégation. Dire si une délégation LLM appelle cette primitive ou si elle est interdite pour initier directement un reviewer isolé.

## Q4 — `content_id` et snapshot non-git

**Verdict : TROU**

**Preuve :** v6-C exige que les N relecteurs reçoivent « le même snapshot gelé » identifié par `content_id` ([plan:184-190](D:/APPS/NodalAI/docs/plans/verifier-corriger.md:184)). Mais la définition conservée dit que `content_id` est HEAD + hash du diff pour git et « sinon absent » ([plan:423-427](D:/APPS/NodalAI/docs/plans/verifier-corriger.md:423)).

Aucun mécanisme ne gèle donc les octets d’un fichier Office, une version de document ou l’objet constaté d’une action sortante. « Absent et dit tel quel » ne garantit pas que deux reviewers lisent le même contenu.

**Spécification minimale :** définir un snapshot immuable par type et son digest : blob copié + SHA-256 pour les fichiers, version/révision exportée et hashée pour les documents, reçu normalisé immuable pour les actions. Les jobs de revue doivent référencer le même `snapshot_id`, et non relire la ressource mutable par son adresse courante.

## Q5 — Sémantique de `review_rounds`

**Verdict : TROU**

**Preuve :** v6-C affirme qu’une correction produit N revues fraîches et que `review_rounds` « compte ces cycles » ([plan:189-191](D:/APPS/NodalAI/docs/plans/verifier-corriger.md:189)). La section PR④ conservée l’incrémente cependant « depuis le verdict persisté `request_changes` » ([plan:419-422](D:/APPS/NodalAI/docs/plans/verifier-corriger.md:419)). Avec N reviewers, cette seconde règle incrémente potentiellement N fois un même cycle.

Le traitement de deux `request_changes` sur trois n’est pas défini : D5 indique qu’un seul bloquant fondé suffit à bloquer, mais ne précise ni quand le cycle est clos, ni qui effectue l’unique incrément.

**Spécification minimale :** matérialiser une `review_cycle` identifiée par `(deliverable_state, snapshot_id, round_number)`. Agréger tous les verdicts requis, clore le cycle une seule fois, puis incrémenter `review_rounds` une seule fois si l’agrégat exige une correction, quel que soit le nombre de reviewers en désaccord.

## Q6 — Échec d’un reviewer

**Verdict : TROU**

**Preuve :** D5 exige que tous les reviewers requis aient rendu leur verdict avant approbation ([plan:210-213](D:/APPS/NodalAI/docs/plans/verifier-corriger.md:210)), mais aucun état ni délai ne traite un reviewer `failed`, expiré, sans budget ou indisponible. Le principe fail-closed ([plan:51-53](D:/APPS/NodalAI/docs/plans/verifier-corriger.md:51)) ne suffit pas à distinguer attente, relance et blocage terminal.

**Spécification minimale :** déclarer la politique fail-closed : un reviewer requis sans verdict empêche l’approbation. Définir un état d’agrégat `review_pending` puis, après politique de retry bornée, `review_incomplete` avec code typé et escalade humaine. Un échec technique ne doit ni compter comme `request_changes`, ni consommer un cycle de correction.

## Q7 — Manifeste des commandes et des invariants

**Verdict : TROU**

**Preuve :** le manifeste des commandes est précisément défini comme le hash de cinq champs `{commands, projectKey, cwd, shellPolicyVersion, envAllowlistVersion}` ([plan:344-349](D:/APPS/NodalAI/docs/plans/verifier-corriger.md:344)). Les invariants sont seulement dits « manifeste, hashé et approuvé comme les commandes » ([plan:148-152](D:/APPS/NodalAI/docs/plans/verifier-corriger.md:148)), et D7 répète que D1 s’applique ([plan:219-220](D:/APPS/NodalAI/docs/plans/verifier-corriger.md:219)).

Il est impossible de savoir si les invariants étendent ce même manifeste, possèdent un hash séparé, ou nécessitent une approbation indépendante.

**Spécification minimale :** choisir explicitement un contrat. Le plus simple est un manifeste unique versionné contenant `verifierConfig` et `invariants`, avec une seule approbation atomique ; toute modification de l’un ou de l’autre invalide celle-ci. Sinon, nommer deux hashes et définir leurs deux transitions d’approbation.

## Q8 — Observation PR① et primitive typée

**Verdict : TIENT**

**Preuve :** le plan choisit explicitement le second comportement : le résultat typé est calculé et journalisé, mais ignoré par la garde de finalisation durant PR① ([plan:340-343](D:/APPS/NodalAI/docs/plans/verifier-corriger.md:340)). Le test nommé impose qu’un projet rouge finisse quand même `completed` tandis que `verification_runs` conserve `red` ([plan:340-343](D:/APPS/NodalAI/docs/plans/verifier-corriger.md:340)). La primitive ne doit donc pas mentir en retournant `completed` : elle peut calculer `verification_due`, puis le mode d’observation laisse le mécanisme terminal actuel décider.

Le code actuel possède bien plusieurs sorties à basculer : chemin texte sans tool call vers `completeJob` ([execute.ts:2919-2926](D:/APPS/NodalAI/apps/runner/src/job/execute.ts:2919)), et runtime CLI vers `completeJob` ([run-job.ts:400](D:/APPS/NodalAI/apps/runner/src/cli-runtime/run-job.ts:400)).

## Q9 — Famille de modèle

**Verdict : TROU**

**Preuve :** `ModelCatalogEntry` ne contient que `modelId`, `label`, capacités, contexte, prix, route et ordre de providers ; aucun champ de famille canonique ([model-catalog.ts:116-143](D:/APPS/NodalAI/packages/shared/src/model-catalog.ts:116)). `modelGroupLabel()` dérive seulement un vendeur d’affichage du préfixe du `modelId` et retourne `null` pour les identifiants natifs sans slash ([model-catalog.ts:1275-1283](D:/APPS/NodalAI/packages/shared/src/model-catalog.ts:1275)). Cela ne permet pas de reconnaître qu’un Claude natif et le même Claude via OpenRouter appartiennent à la même famille.

Le schéma d’agent ne conserve qu’un modèle et des liens de fallback `(keyId, model)` ([agents.ts:29-45](D:/APPS/NodalAI/packages/db/src/schema/agents.ts:29)).

**Spécification minimale :** ajouter au catalogue un identifiant stable indépendant du transport, par exemple `modelFamily: 'anthropic:claude'`, obligatoire pour les modèles sélectionnables comme reviewers. Résoudre chaque configuration `(provider, modelId)` vers cette famille et refuser fail-closed une famille inconnue lorsqu’une politique exige la diversité.

## Q10 — Vérification des ancrages de code

**Verdict : FAUX en partie**

**Preuve :**

- `execute.ts:2919` : **vrai**. Le chemin sans tool call appelle directement `completeJob` aux lignes 2919-2926 ([execute.ts:2919](D:/APPS/NodalAI/apps/runner/src/job/execute.ts:2919)).
- `run-job.ts:400` : **vrai**. Le runtime CLI appelle directement `completeJob` à la ligne 400 ([run-job.ts:400](D:/APPS/NodalAI/apps/runner/src/cli-runtime/run-job.ts:400)).
- `run-job.ts:302-332` : **vrai**, mais ce n’est pas encore un `finally`. Le heartbeat commence ligne 302, `binding.run` ligne 308, puis heartbeat et verrous sont libérés sur les branches lignes 326-332 ([run-job.ts:302](D:/APPS/NodalAI/apps/runner/src/cli-runtime/run-job.ts:302)).
- `deliver-results.ts:195-211` : **vrai**. L’UPDATE direct commence ligne 196 et écrit `status: rootStatus` ligne 198, où `rootStatus` peut être `completed` d’après les lignes 184-185 ([deliver-results.ts:184](D:/APPS/NodalAI/apps/runner/src/cron/deliver-results.ts:184), [deliver-results.ts:196](D:/APPS/NodalAI/apps/runner/src/cron/deliver-results.ts:196)).
- `delegate.ts:78-110` : **vrai comme zone de construction du child**, mais **faux si présenté comme calcul actuel de whitelist**. Les lignes 78-93 construisent le prompt et les lignes 95-110 insèrent un seul child ([delegate.ts:78](D:/APPS/NodalAI/packages/orchestration/src/router/delegate.ts:78)). Aucun calcul de whitelist ou snapshot de protocole n’y existe.
- `runInShell` non exporté à `run-command.ts:141` : **vrai**. La fonction est déclarée sans `export` ([run-command.ts:141](D:/APPS/NodalAI/packages/tools/src/builtin/run-command.ts:141)).
- `review_verdict` : **vrai quant à son existence**, schéma actuel insuffisant pour v6-D. `findingSchema` est défini ligne 18, avec fichier, ligne, issue et `severity` ([review-verdict.ts:18](D:/APPS/NodalAI/packages/tools/src/builtin/review-verdict.ts:18)). Le verdict accepte `approve | request_changes` et une liste de findings ([review-verdict.ts:43-66](D:/APPS/NodalAI/packages/tools/src/builtin/review-verdict.ts:43)). Il n’existe actuellement ni `kind`, ni citation générique, ni `evidence | concern`; la sévérité actuelle est `blocker | major | minor`, non `blocking | major | minor` ([review-verdict.ts:95-100](D:/APPS/NodalAI/packages/tools/src/builtin/review-verdict.ts:95)).
- `task-ledger.ts` comme ancrage des sources ouvertes : **faux**. Une entrée ne conserve que titre, statut, noms d’outils et résultat ([task-ledger.ts:46-50](D:/APPS/NodalAI/apps/runner/src/job/task-ledger.ts:46)); la requête ne lit que `toolsUsed` et `result` ([task-ledger.ts:73-80](D:/APPS/NodalAI/apps/runner/src/job/task-ledger.ts:73)). Elle ne prouve ni quelle source fut ouverte, ni quelle affirmation en dépend.
- `STATE_CHANGING_TOOLS` comme ancrage des sources : **faux**. C’est une liste d’outils mutants de la plateforme ([thread-history.ts:126-151](D:/APPS/NodalAI/apps/runner/src/job/thread-history.ts:126)); son usage ajoute seulement une ligne récapitulant les noms d’outils ([thread-history.ts:283-289](D:/APPS/NodalAI/apps/runner/src/job/thread-history.ts:283)). Elle ne trace pas les lectures ni leurs résultats.

**Spécification minimale :** corriger `delegate.ts:78-110` en disant que c’est le point futur d’insertion/snapshot, non un calcul existant. Pour les documents, définir un registre de lectures contenant au minimum ressource canonique, version ou digest, tool-call ID, résultat de lecture et liens affirmation→source ; ne pas réutiliser `task-ledger` ou `STATE_CHANGING_TOOLS` comme preuve de lecture.

## Q11 — Table `code_projects` et migration

**Verdict : FAUX**

**Preuve :** la table existe sous le nom `code_projects`, mais elle n’a pas de colonne `projectKey`. Son schéma actuel est :

- `id` ([code-projects.ts:31](D:/APPS/NodalAI/packages/db/src/schema/code-projects.ts:31)) ;
- `entity_id` ([code-projects.ts:32-34](D:/APPS/NodalAI/packages/db/src/schema/code-projects.ts:32)) ;
- `project_path` ([code-projects.ts:35-36](D:/APPS/NodalAI/packages/db/src/schema/code-projects.ts:35)) ;
- `display_name`, `hidden`, `created_at`, `updated_at` ([code-projects.ts:37-42](D:/APPS/NodalAI/packages/db/src/schema/code-projects.ts:37)) ;
- UNIQUE actuel `(entity_id, project_path)` ([code-projects.ts:44-46](D:/APPS/NodalAI/packages/db/src/schema/code-projects.ts:44)).

La migration 0086 confirme exactement cette contrainte ([0086_code_projects_rename_and_hide.sql:35-47](D:/APPS/NodalAI/packages/db/migrations/0086_code_projects_rename_and_hide.sql:35)). La clé canonique n’existe que comme fonction runtime calculée depuis un chemin ([code-projects.ts:122-125](D:/APPS/NodalAI/apps/runner/src/job/code-projects.ts:122)).

Une migration de backfill puis fusion est cohérente en principe : deux `project_path` textuellement différents peuvent converger vers le même `projectKey`, notamment par casse Windows. En revanche, la règle de fusion du plan nomme des colonnes inexistantes et contradictoires avec v5 : `verify_command` et `verify_timeout_seconds` ([plan:350-359](D:/APPS/NodalAI/docs/plans/verifier-corriger.md:350)), alors que v5 les remplace par `verify_commands` ([plan:75-82](D:/APPS/NodalAI/docs/plans/verifier-corriger.md:75)). Elle ne définit pas non plus quelle représentation de `project_path` survit.

**Spécification minimale :** décrire l’ajout réel de `project_key`, son backfill par l’algorithme partagé, la fusion avant création de `UNIQUE(entity_id, project_key)`, et la conservation déterministe d’un `project_path` d’affichage. Remplacer toute référence à `verify_command`/`verify_timeout_seconds` par la comparaison canonique de la liste complète `verify_commands` et de son manifeste.

## Constats BLOQUANTS pour PR①

1. Le schéma annoncé « par livrable » n’a ni identité canonique générique ni clés définies pour les livrables non-code (Q2).
2. Le modèle décisionnel de PR① reste effectivement `(job, projet)` malgré l’annonce `(job, livrable)` et ne peut pas représenter correctement une action irréversible (Q1).
3. La garantie de verrouillage déterministe dépend toujours de `code_projects/project_key` et n’est pas définie pour les autres types (Q2).
4. Le déclencheur unique et l’ordre preuve → revue → finalisation ne sont pas spécifiés ; délégation LLM et création de N jobs par le harnais coexistent (Q3).
5. Le snapshot gelé n’existe pas pour les livrables non-git, alors qu’il est requis par le protocole multi-reviewers (Q4).
6. Le contrat d’approbation des invariants est ambigu par rapport au manifeste des commandes (Q7).
7. La diversité de familles exigée n’est pas calculable avec le catalogue actuel et le champ à ajouter n’est pas nommé (Q9).
8. La migration PR① référence les anciennes colonnes singulières `verify_command`/`verify_timeout_seconds`, incompatibles avec `verify_commands`, et omet la représentation canonique survivante de `project_path` (Q11).
