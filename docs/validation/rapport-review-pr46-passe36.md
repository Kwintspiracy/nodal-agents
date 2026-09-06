## 1. Preuve de la course

Oui. Le test est désormais indépendant du temps calendaire.

**Conclusion déduite sans exécution** — l’environnement en lecture seule a refusé le lancement de Vitest.

- [`intent-cli-runtime.test.ts:609`](D:/APPS/NodalAI/apps/runner/src/tests/cli-runtime/intent-cli-runtime.test.ts:609) signale toute lecture de `tool_calls` effectuée avant la libération de l’insertion.
- [`intent-cli-runtime.test.ts:636`](D:/APPS/NodalAI/apps/runner/src/tests/cli-runtime/intent-cli-runtime.test.ts:636) détecte que la promesse conservée par `onEvent` est effectivement attendue.
- [`intent-cli-runtime.test.ts:658`](D:/APPS/NodalAI/apps/runner/src/tests/cli-runtime/intent-cli-runtime.test.ts:658) attend l’un de ces deux événements logiques, sans délai ni assertion de durée.
- [`intent-cli-runtime.test.ts:666`](D:/APPS/NodalAI/apps/runner/src/tests/cli-runtime/intent-cli-runtime.test.ts:666) exige ensuite que la lecture anticipée n’ait pas eu lieu.

Avec [`run-job.ts:592`](D:/APPS/NodalAI/apps/runner/src/cli-runtime/run-job.ts:592), `Promise.allSettled` assimile le thenable du double, ce qui positionne `gate.awaited`; le test libère alors l’insertion, puis `harnessEdits` lit la ligne.

Si l’appel à `settleAuditWrites` est retiré, l’exécution atteint [`run-job.ts:593`](D:/APPS/NodalAI/apps/runner/src/cli-runtime/run-job.ts:593). L’appel synchrone à `.from(toolCalls)` positionne `readBeforeWrite` avant la libération ; l’assertion de la ligne 666 échoue. La mutation rougit donc bien, par causalité et sans horloge.

## 2. Portée du P0

Oui, la lecture comme problème générique et préexistant de robustesse du client tient.

[`run-job.ts:365`](D:/APPS/NodalAI/apps/runner/src/cli-runtime/run-job.ts:365) conserve une insertion déjà démarrée : son attente ultérieure ne crée ni la requête ni la connexion occupée. Avant P5b, le chemin lançait déjà cette insertion sans l’attendre, puis exécutait une lecture `tool_calls` via l’ancien `harnessWrote`. Un pool saturé par dix insertions réseau figées pouvait donc déjà bloquer cette lecture.

Le client limite toujours le pool à dix connexions dans [`client.ts:33`](D:/APPS/NodalAI/packages/db/src/client.ts:33) et exclut explicitement `statement_timeout` dans [`client.ts:48`](D:/APPS/NodalAI/packages/db/src/client.ts:48). Les délais des lignes [`client.ts:55`](D:/APPS/NodalAI/packages/db/src/client.ts:55) et [`client.ts:56`](D:/APPS/NodalAI/packages/db/src/client.ts:56) ne bornent pas une requête immobilisée par une partition réseau silencieuse. C’est donc bien une propriété transversale du client, pas une régression propre à P5b.

P5b ajoute une attente locale maximale avant la lecture à [`run-job.ts:592`](D:/APPS/NodalAI/apps/runner/src/cli-runtime/run-job.ts:592). Avec neuf connexions figées, cela peut ajouter cinq secondes de latence avant que `harnessEdits` utilise la dixième ; avec dix connexions figées, la lecture pouvait déjà bloquer avant P5b. Je ne trouve donc aucun chemin P5b qui introduise ou aggrave le blocage indéfini décrit par le P0.

## Constats bloquants

aucun constat bloquant