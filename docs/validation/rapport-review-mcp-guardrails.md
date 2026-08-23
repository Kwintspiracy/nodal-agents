# Rapport de review - gardes MCP

tokens used
68,311
J’ai trouvé trois failles concrètes. Les deux premières permettent de contourner directement les gardes annoncées.

## Constats

### 1. Critique — la limite de cinq parents permet de récupérer les meta-tools

Dans [execute.ts](D:/APPS/NodalAI/apps/runner/src/job/execute.ts:1247), la provenance MCP n’est recherchée que sur cinq ancêtres :

```ts
for (let hop = 0; ancestorId && hop < 5; hop++)
```

Or cette profondeur n’est pas garantie par la structure `parentJobId`. La route générique autorise un appelant à fournir librement un parent de la même entité dans [agent.ts](D:/APPS/NodalAI/apps/runner/src/routes/agent.ts:130), puis crée le job sans propager ni vérifier `delegationDepth` dans [agent.ts](D:/APPS/NodalAI/apps/runner/src/routes/agent.ts:149).

Ce qui casse concrètement :

1. `run_task` crée le job MCP `M`.
2. Le client récupère son `jobId`.
3. Via `/api/agent`, il crée `A1(parent=M)`, puis `A2(parent=A1)`… jusqu’à `A6`.
4. `A6`, affecté à l’agent racine, ne voit que `A5…A1`.
5. `M` est au sixième saut, donc `isMcpChannel` reste faux.
6. `A6` reçoit les meta-tools à [execute.ts](D:/APPS/NodalAI/apps/runner/src/job/execute.ts:1262).

Le commentaire affirme que le parcours est borné par `maxDelegationDepth`, mais cette propriété ne s’applique qu’aux chemins de délégation contrôlés. Elle ne borne pas les chaînes créées par `/api/agent`.

Les cycles ne provoquent pas de boucle infinie grâce à la limite fixe, mais un cycle ou une chaîne corrompue de plus de cinq lignes produit le même comportement fail-open.

### 2. Élevé — un agent sans entité contourne entièrement l’interrupteur

`agents.entity_id` est nullable dans [agents.ts](D:/APPS/NodalAI/packages/db/src/schema/agents.ts:25).

Le serveur ne vérifie l’interrupteur que si cet identifiant est présent :

- au démarrage : [server.ts](D:/APPS/NodalAI/packages/mcp-server/src/server.ts:123)
- à chaque appel : [server.ts](D:/APPS/NodalAI/packages/mcp-server/src/server.ts:188)

Mais un agent actif avec `entityId = null` est accepté par la validation suivante, qui ne contrôle que son existence et `active`, dans [server.ts](D:/APPS/NodalAI/packages/mcp-server/src/server.ts:125).

Ce qui casse concrètement :

1. Le serveur est lancé avec l’ID explicite d’un agent actif sans entité.
2. Aucun appel à `assertMcpEnabled` n’a lieu.
3. `run_task` insère un job MCP avec `entityId: null` dans [server.ts](D:/APPS/NodalAI/packages/mcp-server/src/server.ts:197).
4. Ce serveur peut donc créer des jobs alors qu’aucun workspace n’a activé `mcp_server_enabled`.

L’absence d’entité devrait être un refus fort, pas une raison de sauter la garde.

### 3. Moyen — la coupure et la création du job ne sont pas atomiques

À chaque appel, l’interrupteur est lu à [server.ts](D:/APPS/NodalAI/packages/mcp-server/src/server.ts:188), puis le job est inséré après validation des arguments à [server.ts](D:/APPS/NodalAI/packages/mcp-server/src/server.ts:195).

Ce qui casse concrètement :

1. L’appel lit `enabled = true`.
2. Le propriétaire coupe l’interrupteur.
3. L’appel déjà engagé poursuit et insère malgré tout un nouveau job MCP.

Le test ajouté ne couvre qu’un appel entièrement postérieur à la coupure ; il ne couvre pas cette course. La promesse « couper coupe les clients déjà connectés » n’est donc pas stricte au niveau de la création.

## Parents supprimés et cycles

`parentJobId` n’a pas de clé étrangère dans [jobs.ts](D:/APPS/NodalAI/packages/db/src/schema/jobs.ts:134). Si une ligne parent manque, la marche s’arrête silencieusement avec `break` dans [execute.ts](D:/APPS/NodalAI/apps/runner/src/job/execute.ts:1255), donc la décision est fail-open.

La rétention supprime effectivement des jobs terminaux dans [retention.ts](D:/APPS/NodalAI/packages/db/src/repos/retention.ts:104), sans contrainte DB préservant leurs descendants. Un descendant orphelin qui serait ensuite exécuté ne conserverait plus sa provenance MCP.

La possibilité qu’un tel descendant encore exécutable survive réellement au calendrier normal de rétention est **NON VÉRIFIÉE**. En revanche, le comportement fail-open sur parent absent et sur chaîne trop longue est certain par lecture du code.

## Couverture

Aucun test n’a été ajouté autour de `execute.ts` pour prouver :

- le retrait des meta-tools sur le job MCP direct ;
- un descendant `task-board` ;
- une chaîne à la profondeur maximale ;
- une chaîne de plus de cinq parents ;
- un parent manquant ;
- un cycle.

Les tests n’ont pas été exécutés dans cet environnement : résultat runtime global **NON VÉRIFIÉ**.
