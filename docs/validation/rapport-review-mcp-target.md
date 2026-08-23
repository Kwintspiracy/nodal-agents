# Rapport de review - ciblage d agent MCP

tokens used
104,063
## Verdict

**CHANGEMENTS DEMANDÉS.** Deux constats fonctionnels, dont un important. Aucun contournement inter-entité trouvé dans le chemin nominal.

### 1. [IMPORTANT] Le défaut n’est pas nécessairement l’agent racine

Dans [server.ts](D:/APPS/NodalAI/packages/mcp-server/src/server.ts:204), l’absence de slug initialise la cible avec `agentRow.id`. Or `agentRow` représente l’agent passé à `buildNodalMcpServer({ agentId })`, qui peut être n’importe quel agent actif de l’entité ([server.ts](D:/APPS/NodalAI/packages/mcp-server/src/server.ts:114), [server.ts](D:/APPS/NodalAI/packages/mcp-server/src/server.ts:117)).

Le contrat annoncé — « défaut = agent racine » — n’est donc vrai que lorsque le serveur a lui-même été lancé pour la racine. Le test masque cette distinction en appelant `connect(seed.agentId)` puis en qualifiant cet agent de « racine du lancement », sans établir ni vérifier `entities.rootAgentId` ([tools.test.ts](D:/APPS/NodalAI/packages/mcp-server/src/tools.test.ts:429), [tools.test.ts](D:/APPS/NodalAI/packages/mcp-server/src/tools.test.ts:439)).

Impact : un serveur lancé avec l’ID d’un worker adressera implicitement tous les appels sans `agent` à ce worker, contrairement au contrat demandé et à la description publique ([tools.ts](D:/APPS/NodalAI/packages/mcp-server/src/tools.ts:26)).

Correction attendue : conserver l’entité dérivée de l’agent serveur, mais résoudre le défaut depuis `entities.rootAgentId` de cette entité, puis vérifier que cette racine est active et appartient toujours à l’entité.

### 2. [MOYEN] La regex MCP n’est pas le contrat canonique des slugs d’agent

Le schéma MCP impose :

```text
^[a-z0-9][a-z0-9-]*$
```

et une longueur maximale de 120 ([tools.ts](D:/APPS/NodalAI/packages/mcp-server/src/tools.ts:18)).

Les deux chemins officiels de création acceptent toutefois `^[a-z0-9-]+$`, donc notamment un slug commençant par `-` ([actions.ts](D:/APPS/NodalAI/apps/web/src/lib/actions.ts:443), [create-agent.ts](D:/APPS/NodalAI/packages/tools/src/builtin/meta-ops/create-agent.ts:17)). Le dashboard limite aussi à 80 caractères, alors que le méta-outil n’a pas de maximum.

Conséquences :

- un agent valide et actif tel que `-reviewer` peut être créé mais ne peut jamais être ciblé par MCP ;
- la définition du slug dérive entre trois surfaces ;
- les doubles tirets et tirets finaux restent acceptés, donc la regex MCP n’établit pas réellement un kebab-case strict.

Ce n’est pas une injection SQL : la valeur passe par un paramètre Drizzle. C’est une incompatibilité de contrat. Il faudrait un schéma partagé et unique pour créer, stocker et cibler les agents.

## Axes attaqués sans constat bloquant

- **Résolution hors entité :** correcte. La requête combine bien `entityId`, `slug` et `active=true` ([server.ts](D:/APPS/NodalAI/packages/mcp-server/src/server.ts:206)). L’insert conserve l’entité du serveur et signe le job par la cible résolue ([server.ts](D:/APPS/NodalAI/packages/mcp-server/src/server.ts:250)). La contrainte DB rend aussi le slug unique par `(entity_id, slug)` ([agents.ts](D:/APPS/NodalAI/packages/db/src/schema/agents.ts:132)).

- **Garde de la #13 dépendant de la cible :** le master switch et le plafond restent attachés au processus/à l’entité du serveur, avant ou indépendamment de la cible ([server.ts](D:/APPS/NodalAI/packages/mcp-server/src/server.ts:178), [server.ts](D:/APPS/NodalAI/packages/mcp-server/src/server.ts:237)). Le retrait des méta-outils dépend de la provenance `mcp`, pas de la cible ([execute.ts](D:/APPS/NodalAI/apps/runner/src/job/execute.ts:1226), [execute.ts](D:/APPS/NodalAI/apps/runner/src/job/execute.ts:1243)).

- **Approbations :** le runner recharge l’agent depuis `job.agentId` ([execute.ts](D:/APPS/NodalAI/apps/runner/src/job/execute.ts:844)) et confronte les règles à cet agent ([execute.ts](D:/APPS/NodalAI/apps/runner/src/job/execute.ts:1630), [execute.ts](D:/APPS/NodalAI/apps/runner/src/job/execute.ts:3089)). Les règles de la cible ne sont donc pas remplacées par celles de la racine.

- **Budgets :** les gardes de tokens et de coût sont actuellement des plafonds globaux de déploiement, issus de l’environnement, pas des budgets propres à la racine ou à la cible ([execute.ts](D:/APPS/NodalAI/apps/runner/src/job/execute.ts:2329), [execute.ts](D:/APPS/NodalAI/apps/runner/src/job/execute.ts:2344)). Rien ne se « perd » lors du ciblage, mais la promesse « THAT agent’s … budgets » dans [tools.ts](D:/APPS/NodalAI/packages/mcp-server/src/tools.ts:28) est plus forte que l’implémentation observée.

## Vérification

- Diff inspecté : `origin/main` (`822901c`) → branche (`533b5d5`).
- `git diff --check` : propre.
- Tests non exécutés afin de respecter la demande de lecture seule : **NON VÉRIFIÉ** dynamiquement.
- Le fichier non suivi `docs/validation/rapport-review-mcp-target.md` préexistait et n’a pas été modifié.
