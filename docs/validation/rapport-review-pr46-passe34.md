## P0

### 1. Attente des insertions d’audit

Le verrou PostgreSQL est borné à 30 secondes par `lock_timeout`. Une insertion réellement bloquée sur un verrou finit donc par échouer, puis son `.catch()` la transforme en promesse résolue. `idle_in_transaction_session_timeout` n’intervient pas ici : l’insertion n’est pas inactive dans une transaction.

En revanche, aucun `statement_timeout` ni délai applicatif ne borne l’insertion elle-même.

**Constat P0 — déduit sans exécution.**  
[`apps/runner/src/cli-runtime/run-job.ts:553`](D:/APPS/NodalAI/apps/runner/src/cli-runtime/run-job.ts:553) attend sans limite `Promise.allSettled(auditWrites)`. [`packages/db/src/client.ts:48`](D:/APPS/NodalAI/packages/db/src/client.ts:48) exclut explicitement tout `statement_timeout`.

Scénario concret : la CLI termine correctement, puis la connexion PostgreSQL utilisée par une insertion `tool_calls` reste établie mais ne reçoit plus de réponse — partition réseau silencieuse, proxy figé ou instruction bloquée ailleurs que sur un verrou. La promesse ne se règle jamais ; le heartbeat a déjà été arrêté et le job ne passe jamais par `harnessEdits` ni par sa finalisation. Une écriture d’audit facultative peut ainsi geler un travail déjà terminé.

`lock_timeout = 30 s` suffit pour le scénario précis du verrou, mais ne garantit donc pas la propriété générale annoncée « jamais bloquante ». Il faut borner l’attente applicative, indépendamment de la promesse d’insertion.

### 2. Le test prouve-t-il la course ?

Pas de manière déterministe.

**Constat P1 — déduit sans exécution.**  
[`apps/runner/src/tests/cli-runtime/intent-cli-runtime.test.ts:544`](D:/APPS/NodalAI/apps/runner/src/tests/cli-runtime/intent-cli-runtime.test.ts:544) utilise un délai calendaire fixe de 80 ms. Le test suppose que, sans `allSettled`, tout ce que `runCliRuntimeJob` exécute entre le retour du binding et `harnessEdits` prendra moins de 80 ms.

Scénario concret : sur une CI chargée, une opération de finalisation intermédiaire ou l’ordonnancement de PGlite prend plus de 80 ms. L’insertion retardée termine avant le `SELECT` même après suppression de `Promise.allSettled`; la mutation fautive reste verte et le test ne protège plus la course.

Un signal contrôlé par le test est préférable : retenir explicitement l’insertion et détecter si la lecture de `tool_calls` commence avant sa libération. À défaut, un délai nettement supérieur réduit seulement la probabilité de faux vert sans supprimer le caractère temporel du test.

## P1

### 3. Casse Windows de la partie rappendue

Je ne trouve pas de panne avec une racine encore existante. `realpathSync.native` résout chaque segment existant avec la graphie du disque ; seuls les segments réellement absents conservent la casse de l’appelant. La comparaison de rattachement passe ensuite par `isWithinRoot`, et l’identité persistée par `projectKey`, qui replient la casse Windows.

Même dans `rebaseOntoLexicalRoots`, qui compare directement les chemins réels, le préfixe correspondant à la racine existante provient de `realpathSync.native` des deux côtés. La casse libre n’apparaît normalement qu’après ce préfixe.

Limite résiduelle : si la racine elle-même a disparu, ses graphies peuvent diverger, mais aucun manifeste ne peut alors être découvert et déclaré dans ce tour. Je n’en fais pas un constat supplémentaire.

### 4. Lecteur seul et chemins UNC

Le traitement de `C:` est correct : [`packages/tools/src/projects/markers.ts:56`](D:/APPS/NodalAI/packages/tools/src/projects/markers.ts:56) sonde bien `C:/`, évitant la sémantique « dossier courant du lecteur ».

Pour un UNC dont le partage existe, la remontée peut résoudre `//serveur/partage` puis rappender les segments absents.

**Constat P1 — déduit sans exécution.**  
[`packages/tools/src/projects/markers.ts:50`](D:/APPS/NodalAI/packages/tools/src/projects/markers.ts:50) n’identifie pas la frontière d’une racine UNC. Après l’échec de `//serveur/partage`, la boucle sonde aussi `//serveur` à la ligne 58 ; `idx <= 0` ne l’arrête qu’au tour suivant.

Scénario concret : `realPathOf('//nas-indisponible/projets/app/src/x.ts')` est appelé pendant le rattachement. Après les ancêtres ordinaires, `realpathSync.native('//nas-indisponible')` déclenche une résolution UNC synchrone vers un serveur absent. Sous Windows, cette opération peut attendre le réseau et bloquer le thread principal du runner, alors que `//serveur` n’est pas une racine UNC valide à sonder.

La remontée ne sonde pas `/`, mais elle doit s’arrêter avant le composant serveur seul, idéalement après avoir tenté au plus la racine `//serveur/partage`.

### 5. Proxy du test

Le proxy conserve le vrai constructeur Drizzle pour toutes les tables sauf `toolCalls`; pour celle-ci, il remplace effectivement le résultat de `values()` par une simple promesse.

C’est acceptable pour prouver le comportement actuel, qui attend directement ce thenable. Si l’insertion ajoutait `.returning()`, le test casserait, mais ce serait une incompatibilité visible du double de test, pas un faux succès silencieux. La faiblesse importante du test reste son délai de 80 ms, relevée en P0.2.

## Vérification de chaque constat de la passe 33

- **Course audit CLI / `harnessEdits` : fonctionnellement traitée**, sous réserve du nouveau blocage sans limite relevé en P0. Les promesses sont enregistrées à [`run-job.ts:326`](D:/APPS/NodalAI/apps/runner/src/cli-runtime/run-job.ts:326) et attendues avant la lecture.
- **Alias et cible disparue : traité pour un ancêtre local ou un partage UNC joignable.** [`markers.ts:45`](D:/APPS/NodalAI/packages/tools/src/projects/markers.ts:45) remonte jusqu’à l’ancêtre existant puis reconstitue la cible.
- **Chemin relatif vers un dossier secondaire sous forme `../app-b/...` : traité.** L’ancêtre existant permet à `realpathSync.native` de résoudre `..`.
- **Chemin relatif ambigu comme `src/index.ts` dans un dossier secondaire : inchangé et toujours indécidable avec l’événement actuel.** Il reste attribué au premier workspace ; ce risque P1 de la passe 33 n’est donc pas corrigé, seulement explicitement accepté par la demande.
- **Fenêtre du backfill : documentée.** L’en-tête de [`backfill-registered-projects.ts:18`](D:/APPS/NodalAI/apps/runner/src/bootstrap/backfill-registered-projects.ts:18) indique clairement la limite du scan et l’absence d’historique complet.
- **Double journalisation de `markJob` : inchangée**, conformément à la réponse annoncée ; toujours non bloquante.

## Constats hors questions

Je n’ai pas trouvé d’autre régression dans les fichiers touchés du commit.

Les tests n’ont pas été exécutés : la session dispose d’un accès filesystem en lecture seule. L’analyse porte exclusivement sur `934091d4` et les versions committées de `HEAD`, sans utiliser les modifications non committées.

## Constats bloquants

- **P0 — [`apps/runner/src/cli-runtime/run-job.ts:553`](D:/APPS/NodalAI/apps/runner/src/cli-runtime/run-job.ts:553) : attente sans limite d’une écriture d’audit, pouvant empêcher définitivement la finalisation d’un tour CLI déjà terminé.**