# Demande de review — PR #46, passe 36 (réponse à la passe 35 sur P5b)

Périmètre : **un commit**, `268f68ef` (un fichier de test), qui répond à la passe 35
(`docs/validation/rapport-review-pr46-passe35.md`). L'arbre de travail contient le chantier
P10a NON committé d'un autre agent : relire l'état COMMITTÉ, pas l'arbre.

## Réponses aux deux constats bloquants de la passe 35

### P1 — le test de la course était temporel : TRAITÉ, sans horloge

`apps/runner/src/tests/cli-runtime/intent-cli-runtime.test.ts`, `dbWithHeldAudit()` : un
double de base qui RETIENT l'insertion `tool_calls` jusqu'à `gate.release()` et observe deux
choses — (1) quelqu'un a-t-il ATTENDU cette écriture : `onEvent` garde
`db.insert(...).values(...).catch(...)` ; le double rend, pour `values()`, un objet dont
`.catch()` rend un thenable dont le `then` pose `gate.awaited = true` (c'est ce que
`Promise.allSettled` appelle) ; (2) un `select(...).from(toolCalls)` est-il parti AVANT la
libération : `gate.readBeforeWrite = true`. Le test fait tourner `runCliRuntimeJob`, cède la
boucle d'événements (`setImmediate`) jusqu'à ce que l'un des deux drapeaux soit levé, libère
l'insertion dans les deux cas, attend la fin du tour, et exige `readBeforeWrite === false`,
`awaited === true`, `alpha` déclaré. Aucune durée. Mutation (`await settleAuditWrites`
retiré) : rouge — `readBeforeWrite` vrai.

### P0 — la borne n'annule pas l'insertion figée : PAS PATCHÉ ICI, et voici pourquoi

Vérifié à la source : `packages/db/src/client.ts` exclut `statement_timeout` À DESSEIN (« a
global cap would also apply to legitimate long-running operations ») et pose `lock_timeout`
30 s + `idle_in_transaction_session_timeout` 60 s ; postgres.js (3.4.9, `src/index.js`
défauts) pose `keep_alive: 60` → `socket.setKeepAlive(true, 60000)` sur chaque connexion : une
connexion dont le pair est mort est fermée par l'OS après ses sondes keepalive, et le pool se
reconstitue. Drizzle n'expose pas `cancel()` de la requête postgres.js.

Le scénario (dix connexions figées par une partition réseau silencieuse) touche TOUTE requête
du runner — `finalizeJobSuccess`, `touchJob`, l'audit du chemin chat (`run-chat.ts`, même
`void db.insert`), le heartbeat — et existait avant P5b sous la même forme (les insertions
d'audit étaient déjà lancées sans attente et occupaient déjà leur connexion). P5b n'ouvre pas
cette voie ; la borne empêche seulement qu'un tour terminé reste suspendu sur elle. La réponse
de fond est au niveau du client (un `statement_timeout` par session sauf pour les backfills,
ou un délai de lecture socket) : c'est un ARBITRAGE de Quentin, consigné au plan, pas un
patch de P5b.

Si tu contestes cette lecture, dis QUEL chemin de P5b aggrave la situation par rapport à
l'état d'avant (`void db.insert` non attendu), avec le scénario.

## Ce qui n'est PAS attendu

Le style. Un constat désigne un fichier, une ligne, et ce qui casse.
