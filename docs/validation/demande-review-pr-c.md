# Demande de review — PR C, étape C1 (#12) : Nodal serveur MCP

Branche `feat/mcp-server` → `main`. Nouveau paquet `@nodal-agents/mcp-server`.

**Ton rôle : essayer de me démonter, pas de me confirmer.** Un point que tu ne
peux pas vérifier se rapporte **NON VÉRIFIÉ**. Ne corrige rien, rends un rapport.

C'est la seule des PR de ce lot qui **ajoute un point d'entrée**. Un serveur qui
crée des jobs et fait tourner des outils mérite d'être attaqué, pas relu.

---

## Priorité 1 — l'autorisation tient-elle vraiment ?

C'est la seule chose qui compte ici. Un serveur MCP est appelable par n'importe
quel client capable de le lancer.

1. **Un agent peut-il atteindre un outil qui n'est pas le sien ?** `tools.ts`
   filtre par `agentId`. Cherche un chemin qui contourne ça : un nom d'outil
   forgé, un appel à un outil listé pour un autre agent, une casse différente.
2. **Que se passe-t-il si `agentId` ne correspond à AUCUN agent** ? Un uuid
   inventé, une chaîne vide, `null`. Le serveur expose-t-il alors les outils de
   tâches — donc la capacité de créer des jobs **sans agent** ?
3. **`entityId` est passé tel quel** depuis les options. Un `entityId` qui ne
   correspond pas à celui de l'agent crée-t-il des lignes dans la mauvaise
   entité ? C'est une fuite inter-workspace si oui.
4. Les outils exposés portent-ils leurs propres gardes (approbation, budget,
   whitelist) — ou les court-circuite-t-on en appelant `execute` directement,
   sans passer par `executeTool` ?

**Le point 4 est celui qui m'inquiète le plus.** J'appelle `tool.execute()` sans
le point de passage habituel. Dis-moi ce que ça saute : approbations, audit
`tool_calls`, compteurs anti-boucle, checkpoints.

## Priorité 2 — le `jobId: null`

Un appel MCP n'a pas de job. Je passe `null` et je compte sur les outils pour
échouer fort s'ils en ont besoin.

1. **Est-ce vrai ?** Lis `generateTaskTools` : `create_task` utilise-t-il
   `ctx.jobId` ? S'il l'utilise sans le vérifier, que crée-t-il — une tâche
   orpheline, une exception, une ligne avec `null` ?
2. Le cast `as unknown as ToolContext` masque exactement ce genre de trou.
   Combien de champs de `ToolContext` sont absents, et lesquels sont lus par les
   outils exposés ?

## Priorité 3 — les compteurs anti-boucle (invariant #8)

Un client peut appeler `create_task` en boucle. Rien dans ce serveur ne compte.

1. Les gardes existantes (`chain_count`, `maxDelegationDepth`,
   `failed_delegations_count`) s'appliquent-elles à une tâche créée par cette
   voie, ou vivent-elles dans la boucle du runner que ce chemin contourne ?
2. Si elles ne s'appliquent pas : quelle est la pire boucle atteignable depuis
   un client ?

## Priorité 4 — mes tests prouvent-ils quelque chose ?

| Mutation | Attendu |
|---|---|
| Retirer le filtrage par agent | rougit — **exécuté, 3 rouges** |
| Retirer le refus de `assign_*` | ? |
| Passer un `entityId` d'une autre entité | ? — **aucun test** |
| Appeler avec un `agentId` inexistant | ? — **aucun test** |

Les trois dernières lignes sont un aveu : je n'ai testé que le cas nominal du
filtrage. Dis si c'est suffisant pour un point d'entrée.

## Priorité 5 — le schéma exposé

`inputSchema: (tool.inputSchema as { shape?: ... }).shape ?? {}`

Ce cast suppose que tout schéma Nodal est un `z.object` avec un `.shape`. Un
outil dont le schéma serait un `z.union`, un `z.discriminatedUnion` ou un
`.refine()` tomberait sur `{}` — **donc un outil sans aucun paramètre déclaré**,
appelable avec n'importe quoi.

Y a-t-il un tel outil aujourd'hui ? Et si non, qu'est-ce qui empêche d'en
ajouter un demain sans que rien ne le signale ?

## Hors périmètre

L'étape C2 (`assign_*` par reprise de session), l'écoute réseau et
l'authentification multi-utilisateur — annoncés comme non livrés.

## Ce que je n'attends pas

Un avis sur le style. Pour cette PR, un constat de sécurité vaut dix constats de
lisibilité.
