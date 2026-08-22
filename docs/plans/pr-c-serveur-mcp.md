<!-- artifact: https://claude.ai/code/artifact/60b8369d-be53-4e5c-91ac-4fefd2d8b682 -->

# PR C — Nodal comme serveur MCP · C1 LIVRÉE (#12)

**État : sortie de la boucle de review après 4 passes, CI en cours, merge à
suivre.**

## Ce qui est livré (C1)

Un paquet `@nodal-agents/mcp-server` : Nodal exposé en serveur MCP **stdio**,
au nom d'**un** agent, avec **un** outil — `run_task`.

```
claude mcp add nodal   -e DATABASE_URL=<l'URL que le runner utilise>   -- pnpm --filter @nodal-agents/mcp-server serve

→ run_task("lance trois reviews sur cette branche", caller: "quentin-terminal")
→ un job `pending`, canal `mcp`, ramassé par le worker, exécuté par la boucle
  normale — approbations, audit, compteurs, hiérarchie.
```

L'identité par défaut est **l'agent racine du workspace** (`entities.root_agent_id`,
une donnée par installation — jamais un nom d'agent dans une config).
`NODAL_MCP_AGENT_ID` la remplace au besoin.

## L'histoire qui compte : la v1 était à bloquer

La v1 exposait `create_task` / `list_tasks` / `assign_*` directement. La review
l'a démontée en **six constats à racine unique** : ces outils tirent leur
autorité du **job** qui les appelle.

| Constat v1 | Fermé par |
|---|---|
| Usurpation inter-entité (`agentId` de A + `entityId` de B) | `entityId` **lu depuis la ligne agent** |
| `create_task` contournait la hiérarchie (résolution par slug dans toute l'entité) | la délégation passe par la boucle du job |
| `tool.execute()` direct sautait approbations, audit, preflights | plus d'exécution ici : un job `pending`, c'est tout |
| `jobId: null` créait des tâches orphelines que le cron ramassait | le job **est** l'ancre |
| Aucun compteur : racines payantes sans limite | plafond **par processus**, réarmé par redémarrage (geste humain) |
| Un `agentId` inventé recevait les outils | le serveur **refuse de démarrer** |

Le modèle qui a tout réglé existait déjà : **la surface chat**. Un tour de chat
n'est pas un job → un seul outil, `run_task`, qui crée un vrai job.

## Les passes suivantes

| Passe | Constat | Correctif |
|---|---|---|
| 2 | le plafond cédait sous **10 appels concurrents** | siège réservé par incrément synchrone avant le premier `await` ; mutation : « 10 jobs créés sous un plafond de 2 », rouge |
| 2 | canal `mcp` absent de `JOB_CHANNELS` — une ligne DB légitime imparsable | enum + schéma + test alignés (le test recopiait la liste à la main : il validait sa copie, pas la contrainte) |
| 3 | `NaN` **désactivait le plafond en silence** (`x >= NaN` toujours faux) | le serveur refuse de démarrer ; NaN, Infinity, 2.5, 0, −1 testés |
| 4 | **aucun** | condition d'arrêt |

## Ce que C1 ne livre pas

| Reporté | Où |
|---|---|
| `assign_*` exécutable (attendre le résultat d'un délégué) | **C2** — par la reprise de session de la #7, pas par une attente synchrone |
| Écoute réseau, authentification multi-client | non prévu tant que stdio suffit |

## La leçon, écrite pour la prochaine fois

La v1 avait des tests verts, des mutations rouges au bon endroit, des portes
propres — et elle était à bloquer. **Des tests qui prouvent les bonnes
propriétés du mauvais contrat ne protègent de rien.** Et j'avais écrit mes
doutes (exécution sans `executeTool`, `jobId: null`) dans mon propre plan de
review avant de livrer quand même : signaler un doute ne le résout pas.
