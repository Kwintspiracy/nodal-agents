# Rapport de review - PR C, passe 2

tokens used
98,425
## Verdict

**PR toujours à bloquer.** Cinq des six constats v1 sont fermés par le nouveau contrat. Le sixième — le plafond anti-boucle — reste contournable par concurrence.

Deux constats neufs dans la v2.

## Constats neufs

### ÉLEVÉ — Le plafond par processus cède sous des appels concurrents

Fichiers :

- [server.ts](D:/APPS/NodalAI/packages/mcp-server/src/server.ts:89)
- [server.ts](D:/APPS/NodalAI/packages/mcp-server/src/server.ts:110)
- [server.ts](D:/APPS/NodalAI/packages/mcp-server/src/server.ts:121)
- [tools.test.ts](D:/APPS/NodalAI/packages/mcp-server/src/tools.test.ts:118)

Le serveur vérifie `jobsCreated >= maxJobs`, attend ensuite l’insertion SQL, puis incrémente le compteur. Plusieurs handlers concurrents peuvent donc tous observer la même valeur avant qu’aucun ne l’incrémente.

Ce qui casse concrètement : avec `maxJobsPerProcess: 2`, dix appels `run_task` lancés simultanément peuvent tous passer le contrôle et créer dix jobs payants. Le test appelle `a`, `b`, puis `c` séquentiellement ; il ne couvre pas cette course.

Le constat v1 « nombre illimité de racines externes » n’est donc pas réellement fermé par le plafond annoncé.

### MOYEN — Le nouveau canal SQL est absent de la source de vérité partagée

Fichiers :

- [0080_agent_jobs_mcp_channel.sql](D:/APPS/NodalAI/packages/db/migrations/0080_agent_jobs_mcp_channel.sql:13)
- [jobs.ts](D:/APPS/NodalAI/packages/db/src/schema/jobs.ts:212)
- [enums.ts](D:/APPS/NodalAI/packages/shared/src/enums.ts:6)
- [enum-coverage.test.ts](D:/APPS/NodalAI/packages/shared/src/tests/enum-coverage.test.ts:84)

La migration et le schéma Drizzle acceptent `mcp`, mais `JOB_CHANNELS` et `JobChannelSchema` s’arrêtent toujours à `webhook`.

Ce qui casse concrètement : `AgentJobSchema.parse()` refuse toute ligne créée par `run_task` avec une erreur Zod sur `channel: "mcp"`. Le type partagé `JobChannel` affirme également que cette valeur DB légitime est impossible.

Le test censé comparer exactement l’enum au `CHECK` SQL recopie encore manuellement les dix anciennes valeurs ; il reste donc vert tout en ne représentant plus la contrainte réelle.

## Vérification des six constats v1

- **Usurpation inter-entité : fermé.** `entityId` a disparu des options et provient de la ligne agent dans [server.ts](D:/APPS/NodalAI/packages/mcp-server/src/server.ts:112).
- **Contournement de la hiérarchie : fermé.** La surface expose exclusivement `run_task`; aucun `create_task` ou `assign_*` interne n’est directement exécutable.
- **Contournement approbations/audit : fermé.** MCP insère seulement un job `pending`; les outils éventuels seront exécutés dans la boucle normale du worker.
- **`jobId: null` et tâches orphelines : fermé.** Aucun `ToolContext` artificiel ni `agent_tasks` n’est créé. La base génère un véritable `agent_jobs.id`.
- **Compteurs/plafond externe : non fermé.** Les limites internes s’appliquent au job, mais le nouveau plafond externe est vulnérable à la course décrite ci-dessus.
- **Agent inexistant ou inactif : fermé au démarrage.** La construction échoue avant l’enregistrement de l’outil dans [server.ts](D:/APPS/NodalAI/packages/mcp-server/src/server.ts:65).

L’exécution dynamique des tests est **NON VÉRIFIÉE** : la commande `pnpm test` a été refusée par l’environnement en lecture seule. `git diff --check main...HEAD` ne signale aucune erreur.
