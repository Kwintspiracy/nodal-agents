# Rapport de review - PR C, etape C1

tokens used
85,651
## Verdict

**PR à bloquer.** Le serveur permet à un client MCP de créer sans approbation un nombre illimité de tâches pour n’importe quel agent d’une entité choisie par l’appelant. La séparation `agentId` / `entityId` n’est jamais vérifiée.

## Constats

### CRITIQUE — Usurpation inter-entité par combinaison libre de `agentId` et `entityId`

Fichiers :

- [server.ts](D:/APPS/NodalAI/packages/mcp-server/src/server.ts:79)
- [task-tools.ts](D:/APPS/NodalAI/packages/orchestration/src/planner/task-tools.ts:96)
- [task-tools.ts](D:/APPS/NodalAI/packages/orchestration/src/planner/task-tools.ts:150)
- [tasks.ts](D:/APPS/NodalAI/packages/db/src/schema/tasks.ts:23)

Le serveur construit directement le contexte avec `agentId` et `entityId` fournis séparément dans les options, sans charger l’agent ni vérifier `agents.entity_id = entityId`.

`create_task` utilise ensuite :

- `ctx.entityId` pour trouver l’agent destinataire ;
- l’`agentId` capturé pour `orchestratorId` et `createdByAgentId`.

La base vérifie seulement que chaque UUID référencé existe. Elle n’impose aucune cohérence d’entité entre `agent_tasks.entity_id`, `orchestrator_id`, `created_by_agent_id` et `assigned_agent_id`.

Ce qui casse concrètement : avec l’UUID valide d’un agent de l’entité A et l’UUID de l’entité B, un client peut créer dans B une tâche attribuée à n’importe quel agent de B dont il connaît le slug. La ligne affirme pourtant que l’orchestrateur et le créateur appartiennent à A. C’est une écriture inter-workspace et une usurpation d’auteur.

Le cron reprend ensuite l’`entityId` et l’`assignedAgentId` de cette ligne pour créer un vrai job dans B : [execute-ready.ts](D:/APPS/NodalAI/apps/runner/src/cron/execute-ready.ts:199).

### CRITIQUE — `create_task` contourne complètement la hiérarchie des agents

Fichiers :

- [tools.ts](D:/APPS/NodalAI/packages/mcp-server/src/tools.ts:36)
- [task-tools.ts](D:/APPS/NodalAI/packages/orchestration/src/planner/task-tools.ts:103)
- [task-tools.ts](D:/APPS/NodalAI/packages/orchestration/src/planner/task-tools.ts:107)

`create_task` et `list_tasks` sont exposés inconditionnellement, quel que soit le rôle de l’agent et même s’il n’a aucune équipe.

Pour résoudre `assigned_to`, le code cherche tout agent ayant ce slug dans `ctx.entityId`. Il ne consulte jamais `agent_assignments` et ne vérifie pas que la cible est un sous-agent autorisé.

Ce qui casse concrètement : un agent ordinaire ou sans équipe peut lancer un job sous n’importe quel autre agent de l’entité. Le filtrage correct appliqué à `assign_*` ne protège donc pas la capacité réelle de délégation : `create_task` fournit une voie parallèle qui l’annule.

### ÉLEVÉ — Aucun contrôle d’approbation, aucune règle `block`, aucun audit

Fichiers :

- [server.ts](D:/APPS/NodalAI/packages/mcp-server/src/server.ts:89)
- [execute.ts](D:/APPS/NodalAI/packages/tools/src/execute.ts:50)
- [execute.ts](D:/APPS/NodalAI/packages/tools/src/execute.ts:85)
- [execute.ts](D:/APPS/NodalAI/packages/tools/src/execute.ts:264)
- [execute.ts](D:/APPS/NodalAI/packages/tools/src/execute.ts:326)
- [execute.ts](D:/APPS/NodalAI/packages/tools/src/execute.ts:351)

Le serveur valide l’entrée puis appelle directement `tool.execute()`. Cela saute réellement :

- les règles d’approbation agent/entité, y compris `block` ;
- `defaultApproval` et `computeApproval` ;
- les hardlines de sécurité ;
- la création d’`approval_requests` ;
- l’audit systématique dans `tool_calls` ;
- les preflights ;
- les checkpoints des outils modifiant un workspace.

Ce qui casse concrètement : même si le propriétaire a une règle `block` sur `create_task` ou une règle générique `*`, l’appel MCP crée quand même la tâche. Aucune ligne `tool_calls` ne permet ensuite d’attribuer ou d’investiguer cette création.

Pour les deux outils actuellement exécutables, les checkpoints ne changeraient pas le résultat parce qu’ils ne déclarent pas `mutatesWorkspace`. Le contournement demeure structurel pour tout nouvel outil exposé.

### ÉLEVÉ — `jobId: null` crée effectivement des tâches orphelines exécutables

Fichiers :

- [server.ts](D:/APPS/NodalAI/packages/mcp-server/src/server.ts:83)
- [task-tools.ts](D:/APPS/NodalAI/packages/orchestration/src/planner/task-tools.ts:163)
- [tasks.ts](D:/APPS/NodalAI/packages/db/src/schema/tasks.ts:48)
- [execute-ready.ts](D:/APPS/NodalAI/apps/runner/src/cron/execute-ready.ts:165)
- [execute-ready.ts](D:/APPS/NodalAI/apps/runner/src/cron/execute-ready.ts:199)

`create_task` lit bien `ctx.jobId`, mais ne vérifie pas qu’il est non nul. Il écrit directement cette valeur dans `root_job_id`, colonne nullable sans clé étrangère.

Ce qui casse concrètement : l’appel MCP insère une tâche avec `root_job_id = NULL`. Si `assigned_to` désigne un agent existant, le cron la sélectionne, considère sa profondeur comme zéro, puis crée un vrai `agent_jobs` sans parent. Le commentaire promettant que les outils échoueront fort est donc faux.

`list_tasks`, lui, filtre sur `root_job_id = ctx.jobId` à [task-tools.ts](D:/APPS/NodalAI/packages/orchestration/src/planner/task-tools.ts:193). Avec `null`, il ne constitue pas un moyen fiable de retrouver les tâches MCP créées. Le comportement SQL exact produit par Drizzle pour `eq(column, null)` est **NON VÉRIFIÉ** dynamiquement, mais ce filtre n’utilise pas `isNull()`.

### ÉLEVÉ — Contournement global des compteurs anti-boucle

Fichiers :

- [server.ts](D:/APPS/NodalAI/packages/mcp-server/src/server.ts:59)
- [chain-counters.ts](D:/APPS/NodalAI/packages/orchestration/src/chain-counters.ts:44)
- [chain-counters.ts](D:/APPS/NodalAI/packages/orchestration/src/chain-counters.ts:339)
- [execute-ready.ts](D:/APPS/NodalAI/apps/runner/src/cron/execute-ready.ts:195)

Le serveur ne possède ni job, ni tour, ni compteur. Chaque requête MCP est donc extérieure aux limites de 50 outils par tour et 15 reprises.

Pire boucle atteignable : un client appelle `create_task` indéfiniment. Chaque appel crée une nouvelle racine indépendante avec `root_job_id = NULL`; le cron en consomme jusqu’à sa limite par tick et crée autant de jobs payants.

Les jobs ainsi créés repassent ensuite dans le runner et récupèrent leurs propres limites de tours, outils, tokens et profondeur. Cela borne chaque job individuellement, mais ne borne ni le nombre de tâches racines injectées ni leur coût cumulé.

La profondeur est initialisée à zéro pour chaque tâche MCP orpheline. Toute nouvelle tâche racine repart donc avec un budget de délégation neuf. Les descendants créés depuis ces jobs voient ensuite leur profondeur propagée.

`failed_delegations_count` n’existe plus dans le schéma courant : la migration [0012_agent_jobs_last_failed_delegation_slug.sql](D:/APPS/NodalAI/packages/db/migrations/0012_agent_jobs_last_failed_delegation_slug.sql:1) le supprime. La protection courante est notamment `lastFailedDelegationSlug`, appliquée dans le runner aux `assign_*` à [execute.ts](D:/APPS/NodalAI/apps/runner/src/job/execute.ts:3278). Elle ne limite pas les appels MCP répétés à `create_task`.

### ÉLEVÉ — Un `agentId` inconnu reçoit quand même les outils de création

Fichiers :

- [tools.ts](D:/APPS/NodalAI/packages/mcp-server/src/tools.ts:36)
- [tools.ts](D:/APPS/NodalAI/packages/mcp-server/src/tools.ts:46)
- [server.ts](D:/APPS/NodalAI/packages/mcp-server/src/server.ts:48)

`listExposableTools` ne vérifie jamais l’existence de l’agent. Les outils de tâches sont créés avant toute requête sur ses affectations.

Comportements :

- UUID valide mais inexistant : `create_task` et `list_tasks` sont exposés. L’insertion échoue ensuite sur la FK `orchestrator_id`, donc ce seul cas ne crée pas de job.
- Chaîne vide ou UUID mal formé : résultat exact PostgreSQL/Drizzle **NON VÉRIFIÉ**, probablement erreur lors de la requête des affectations.
- `null` injecté à l’exécution malgré le type TypeScript : outils de tâches toujours construits ; l’insertion de `create_task` échoue sur `orchestrator_id NOT NULL`.
- UUID d’un agent valide associé à un autre `entityId` : insertion réussissable, vulnérabilité critique décrite plus haut.

L’absence de création avec un UUID inexistant ne rend pas le comportement sûr : le serveur devrait refuser sa construction, pas annoncer des capacités à une identité inexistante.

### MOYEN — Le schéma MCP repose sur une hypothèse non contrôlée

Fichiers :

- [server.ts](D:/APPS/NodalAI/packages/mcp-server/src/server.ts:55)
- [task-tools.ts](D:/APPS/NodalAI/packages/orchestration/src/planner/task-tools.ts:15)
- [task-tools.ts](D:/APPS/NodalAI/packages/orchestration/src/planner/task-tools.ts:40)

Les outils exposés aujourd’hui utilisent tous des `z.object` directs :

- `create_task` ;
- `list_tasks` ;
- les `assign_*`.

Je n’ai trouvé ni union, ni union discriminée, ni schéma raffiné parmi eux. Le défaut n’est donc pas actuellement déclenché.

Rien n’empêche cependant d’ajouter un outil avec `z.union`, `z.discriminatedUnion`, `z.effect`/`.refine()` ou toute autre forme sans `.shape`. Le cast transforme alors silencieusement son schéma MCP en `{}`. Aucun type, garde d’exécution ou test ne le signale.

Ce qui casse concrètement à la prochaine extension concernée : le client voit un outil sans paramètres déclarés, alors que le serveur applique ensuite un schéma différent. L’intégration devient incohérente et échoue uniquement à l’appel.

### MOYEN — Les tests ne traversent jamais le point d’entrée dangereux

Fichier : [tools.test.ts](D:/APPS/NodalAI/packages/mcp-server/src/tools.test.ts:60)

Les tests vérifient seulement :

- la présence d’un `assign_*` rattaché ;
- son absence pour un autre agent ;
- la présence constante de `create_task` et `list_tasks` ;
- le prédicat `isDeferredToC2`.

Ils ne construisent pas le serveur, n’invoquent aucun handler MCP et ne vérifient aucune ligne DB résultante.

Les mutations non couvertes demandées sont donc bien des trous :

- retrait du refus de `assign_*` : aucun test d’exécution ne rougit ;
- `entityId` d’une autre entité : aucun test ;
- `agentId` inexistant/null/vide : aucun test ;
- appel direct contournant une règle `block` : aucun test ;
- absence de `tool_calls` : aucun test ;
- `rootJobId = null` puis création par le cron : aucun test ;
- schéma sans `.shape` : aucun test.

Les trois tests rouges annoncés pour le retrait du filtrage nominal ne suffisent pas pour ce point d’entrée.

## Points qui tiennent

- Les `assign_*` listés proviennent bien d’une requête filtrée exactement sur `orchestratorId` : [assign-tools.ts](D:/APPS/NodalAI/packages/orchestration/src/router/assign-tools.ts:95).
- Un nom d’outil forgé ne correspond pas à un handler enregistré par cette boucle. Le comportement exact du SDK MCP sur la casse et les noms non enregistrés est **NON VÉRIFIÉ** dynamiquement.
- Le refus C1 utilise `startsWith('assign_')` et bloque donc les vrais outils générés. Il est sensible à la casse, mais les noms générés sont en minuscules. Aucun bypass concret par casse n’est établi.
- Les entrées sont encore validées par le vrai schéma Zod juste avant `execute`, à [server.ts](D:/APPS/NodalAI/packages/mcp-server/src/server.ts:90). Le défaut `.shape ?? {}` affecte principalement le contrat annoncé au client, pas cette validation serveur.

## `ToolContext` incomplet

Référence : [types.ts](D:/APPS/NodalAI/packages/tools/src/types.ts:20).

Le contexte possède 20 champs au total :

- 4 sont fournis ;
- 1 champ obligatoire est absent : `jobChatId` ;
- 15 champs optionnels sont absents ;
- deux champs fournis violent néanmoins leur type : `jobId` et `entityId` reçoivent `null` alors que leur type est `string`.

Les outils actuellement exécutables lisent :

- `create_task` : `entityId` et `jobId` ;
- `list_tasks` : `jobId` ;
- `db` et l’ID d’orchestrateur proviennent surtout des fermetures générées.

L’absence de `jobChatId` ne casse pas ces deux outils. Les valeurs nulles de `entityId`/`jobId`, elles, sont directement pertinentes et masquées par le double cast.

## Conclusion

Le filtrage des seuls `assign_*` est nominalement correct, mais il protège la mauvaise frontière. La capacité dangereuse est `create_task`, exposée universellement, exécutée sans `executeTool`, sans validation de l’identité, sans cohérence agent–entité, sans restriction à l’équipe et sans compteur global. Cette combinaison permet la création inter-entité de jobs non audités et non approuvés.
