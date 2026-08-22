# Rapport de review - PR C, passe 3

tokens used
39,875
## Verdict

**Un seul constat neuf. PR à bloquer** tant que le plafond accepte des valeurs non finies.

### ÉLEVÉ — `NaN` ou `Infinity` désactive silencieusement le plafond

Fichiers :

- [server.ts](D:/APPS/NodalAI/packages/mcp-server/src/server.ts:46)
- [server.ts](D:/APPS/NodalAI/packages/mcp-server/src/server.ts:78)
- [server.ts](D:/APPS/NodalAI/packages/mcp-server/src/server.ts:97)

`maxJobsPerProcess` est accepté comme `number` sans validation. Avec `NaN`, la condition `jobsCreated >= maxJobs` est toujours fausse. Avec `Infinity`, elle ne devient jamais vraie.

Ce qui casse concrètement : un appelant qui construit la valeur depuis une configuration invalide — par exemple `Number(process.env.MAX_JOBS)` lorsque la variable contient une chaîne incorrecte — lance un serveur qui accepte un nombre illimité de jobs payants. Aucun échec explicite ne signale que la protection anti-boucle a disparu.

Une valeur fractionnaire produit également un plafond différent de celui annoncé : `2.5` autorise trois jobs.

Les deux constats de la passe 2 sont sinon fermés statiquement :

- la réservation synchrone avant le premier `await` ferme bien la course concurrente ;
- `mcp` est désormais aligné dans la contrainte DB, `JOB_CHANNELS`, `JobChannelSchema` et le test de couverture.

Tests dynamiques : **NON VÉRIFIÉS**, leur exécution ayant été refusée par l’environnement en lecture seule. `git diff --check main...HEAD` passe. Aucun fichier modifié.
