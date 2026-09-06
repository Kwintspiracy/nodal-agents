## 1. Q3 — collision de `cliTurn`

Non, ce scénario n’est pas atteignable par le chemin worker de production.

- [worker.ts:58](D:/APPS/NodalAI/apps/runner/src/routes/worker.ts:58) appelle `executeJob`.
- [execute.ts:768](D:/APPS/NodalAI/apps/runner/src/job/execute.ts:768) réclame atomiquement le job avant d’entrer dans le runtime.
- [state.ts:91](D:/APPS/NodalAI/apps/runner/src/job/state.ts:91) effectue un `UPDATE ... WHERE id = jobId AND status = 'pending' RETURNING id`. Un seul appel peut faire passer la ligne de `pending` à `processing`; l’autre obtient `false` et retourne `already_handled`.
- Le récupérateur de jobs orphelins les marque `failed`, il ne les remet pas à `pending` ([reset-orphans.ts:132](D:/APPS/NodalAI/apps/runner/src/cron/reset-orphans.ts:132)). Il n’ouvre donc pas une seconde réclamation pendant que la première exécution continue.

À l’intérieur de `runCliRuntimeJob`, la course décrite serait bien réelle si la fonction était appelée directement et simultanément :

- calcul avant verrou : [run-job.ts:404](D:/APPS/NodalAI/apps/runner/src/cli-runtime/run-job.ts:404) ;
- acquisition du verrou : [run-job.ts:459](D:/APPS/NodalAI/apps/runner/src/cli-runtime/run-job.ts:459) ;
- `binding.run` : [run-job.ts:577](D:/APPS/NodalAI/apps/runner/src/cli-runtime/run-job.ts:577) ;
- insertion de `cli_runs` : [run-job.ts:605](D:/APPS/NodalAI/apps/runner/src/cli-runtime/run-job.ts:605).

Mais l’exclusivité de `claimJob` rend cette concurrence inaccessible dans le flux examiné. Il n’est donc pas nécessaire de déplacer `resolveCliTurn` après les verrous pour corriger la PR.

Si ce déplacement était néanmoins retenu comme durcissement, `onEvent` pourrait lire une variable assignée après l’acquisition du verrou mais avant `binding.run` : le callback n’est invoqué que par `binding.run`.

Réponse déduite sans exécution.

## 2. `close` après `kill()` sous Windows

Après un `child.kill()` réussi, oui : sous Windows, `SIGTERM` provoque une terminaison forcée du processus, puis Node émet `close` après la fin du processus et la fermeture de ses flux stdio. La documentation garantit que `close` suit `exit`, ou `error` lorsque le processus n’a pas pu être lancé. Le fait que Git ait déjà fini d’écrire ne supprime pas cet événement. [Documentation officielle Node.js](https://nodejs.org/api/child_process.html#event-close)

Je ne vois donc pas de chemin normal où le `kill()` réussit mais où la promesse reste indéfiniment pendante. En cas d’échec de `kill()`, Node émet `error`; le gestionnaire de [checkpoints.ts:222](D:/APPS/NodalAI/packages/checkpoints/src/checkpoints.ts:222) rejette alors la promesse et annule le timer.

Réponse déduite sans exécution, appuyée sur le contrat officiel de Node.js.

## Vérification des constats de la passe 43

| Constat de la passe 43 | État |
|---|---|
| Bloquant — résolution avant `close`, index orphelin sous Windows | Traité sur les chemins normaux de troncature et de délai : [checkpoints.ts:216](D:/APPS/NodalAI/packages/checkpoints/src/checkpoints.ts:216) et [checkpoints.ts:206](D:/APPS/NodalAI/packages/checkpoints/src/checkpoints.ts:206) ne règlent plus la promesse; seul `close` le fait à [checkpoints.ts:228](D:/APPS/NodalAI/packages/checkpoints/src/checkpoints.ts:228). Réserve exceptionnelle ci-dessous. |
| P2 — U+FFFD pouvant dépasser la borne | Traité : [checkpoints.ts:167](D:/APPS/NodalAI/packages/checkpoints/src/checkpoints.ts:167) recule jusqu’à la frontière UTF-8, puis [checkpoints.ts:241](D:/APPS/NodalAI/packages/checkpoints/src/checkpoints.ts:241) applique cette coupe avant décodage. Le test ajouté vérifie la borne et l’absence de U+FFFD. |
| Q1 — `read-tree` inutile | Traité : l’index reste vide, seul le chemin demandé est ajouté à [checkpoints.ts:415](D:/APPS/NodalAI/packages/checkpoints/src/checkpoints.ts:415), interrogé à [checkpoints.ts:417](D:/APPS/NodalAI/packages/checkpoints/src/checkpoints.ts:417), puis diffusé avec un pathspec à [checkpoints.ts:425](D:/APPS/NodalAI/packages/checkpoints/src/checkpoints.ts:425). Le test de suppression couvre `-un`, `-deux` et l’absence d’ajout. |
| Q3 — tour calculé avant les verrous | Inchangé, mais non atteignable dans le chemin worker grâce à la réclamation atomique décrite en réponse 1. Aucun défaut de production constaté. |

Les tests n’ont pas été exécutés : l’environnement de review est en lecture seule et refuse leur lancement. Le code et les fichiers concernés sont propres par rapport à `HEAD`; aucune modification non commitée de l’autre chantier n’a été relue.

## Constats supplémentaires non demandés

- **[P2, déduit sans exécution] [checkpoints.ts:222](D:/APPS/NodalAI/packages/checkpoints/src/checkpoints.ts:222) — un échec de `child.kill()` peut encore régler la promesse avant `close`.**  
  Node documente l’émission de `error` lorsqu’un processus ne peut pas être tué. Le gestionnaire `error` rejette immédiatement et annule le timer; le `finally` de [checkpoints.ts:447](D:/APPS/NodalAI/packages/checkpoints/src/checkpoints.ts:447) peut alors tenter de supprimer l’index tandis que Git est encore actif. Cela réintroduit exceptionnellement la course Windows que le commit corrige sur les chemins ordinaires. Il faudrait distinguer l’échec initial de `spawn` d’une erreur postérieure à la demande d’arrêt, et attendre `close` dans ce second cas — avec éventuellement un ultime garde-fou borné.

## Constats bloquants

Aucun constat bloquant.