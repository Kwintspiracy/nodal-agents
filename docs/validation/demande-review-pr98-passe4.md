# Demande de review — PR #98, passe 4 (la FORME renversée)

La passe 3 a conclu « la forme est en cause ». Elle avait raison, et la forme a
changé (`81f342d9`). Ce n'est plus la même règle patchée une quatrième fois :
c'est la question posée à l'envers.

**Avant** : la table des processus attribuait (chemin du binaire, puis dossier
en sous-chaîne, puis en chemin, puis argument `-D`, puis `-c data_directory`).
**Maintenant** : `<dataDir>/postmaster.pid` attribue — il est écrit PAR le
postmaster qui tient ce dossier, donc c'est vrai par construction — et la table
ne fait que CONFIRMER.

Plus rien ne lit une ligne de commande pour décider d'une appartenance.
`dataDirArgument` et son tokeniseur sont supprimés.

Sandbox lecture seule. Deux verdicts : **le constat tient** ou **le constat est
faux**.

Lire `git show 81f342d9`, le rapport de la passe 3
(`docs/validation/rapport-review-pr98-passe3.md`), puis le code d'aujourd'hui :
`apps/cli/src/lib/orphans.ts` (surtout `ownedPostgresPids`),
`apps/cli/src/lib/postgres.ts` (`readPostmasterClaim`, `stopOrphanPostgres`),
`apps/cli/src/commands/up.ts`, et les deux fichiers de tests.

## Ce que la nouvelle forme affirme

1. `readPostmasterClaim` rend le pid (ligne 1) et l'heure de démarrage (ligne 3,
   epoch **secondes**), et refuse un fichier dont la ligne 2 nomme un autre
   dossier.
2. `ownedPostgresPids` : sans réclamation, **rien** n'est possédé. Avec une
   réclamation et une table lue, le pid doit être DANS la table (donc vivant et
   `postgres.exe`) et sa `CreationDate` doit correspondre à l'heure réclamée à
   60 s près. Sinon, **rien** n'est possédé.
3. Les workers sont atteints par ASCENDANCE vers ce seul pid confirmé, avec le
   garde « un parent ne démarre pas après son enfant ».
4. Table non lue (hors Windows, ou sonde en échec) : le fichier seul décide, et
   aucun worker n'est réclamé.
5. `stopOrphanPostgres(decidedPid)` refuse d'appeler `pg_ctl` si le fichier
   qu'il relirait ne nomme pas exactement `decidedPid`, et refuse en root.
6. **Perte assumée** : lockfile absent + postmaster vivant (incident du
   20/08/2026) ⇒ plus rien n'est nettoyé. Un test tient cette perte.

## Questions, par priorité

### P0 — la nouvelle forme peut-elle encore tuer un processus étranger ?

1. **Le chemin complet jusqu'au `SIGKILL`.** Pars de `up.ts` et trace : quelles
   valeurs peuvent arriver dans `orphans` avec `name === 'postgres'`, et par
   quelles sondes ? Existe-t-il ENCORE un chemin où un pid qui n'est pas dans
   `ownedPostgresPids(...).owned` est tué ? Regarde en particulier
   `isOurPostmasterPid` et le second appel à `livePostmasterPid()`.
2. **La tolérance de 60 secondes.** Un pid recyclé dans la minute qui suit la
   mort du postmaster passe. Est-ce atteignable ? Et à l'inverse : un système
   dont l'horloge recule (NTP, changement d'heure, VM suspendue) peut-il faire
   échouer la correspondance pour NOTRE propre postmaster, et donc empêcher
   tout nettoyage ? Lequel des deux risques est le plus cher ?
3. **`startedAtSeconds` absent, `startedAt` absent.** `startMatchesClaim` rend
   `true` quand l'un des deux manque — donc la garde s'éteint. Quand cela
   arrive-t-il réellement ? Une ligne WMI sans `CreationDate` redonne-t-elle le
   trou du pid recyclé, et faut-il plutôt REFUSER dans ce cas ?
4. **La ligne 3 du lockfile.** Est-ce bien l'heure de démarrage en epoch
   secondes dans PostgreSQL 18, et est-ce l'heure du POSTMASTER ou celle de
   l'écriture du fichier ? Vérifie dans les sources, ne le suppose pas.

### P1 — la perte assumée

5. Le cas « lockfile absent, postmaster vivant » ne nettoie plus rien. Que voit
   l'utilisateur exactement ? `up` échoue-t-il sur le FATAL opaque que toute
   cette zone existe pour éviter, ou dit-il quelque chose d'utile ? Si c'est le
   FATAL, quel message minimal faudrait-il, et où ?
6. Y a-t-il une preuve NON fondée sur la ressemblance qui récupérerait ce cas —
   un handle ouvert sur le dossier, la section de mémoire partagée, un verrou de
   fichier ? Si oui, dis laquelle et ce qu'elle coûte. Si non, dis-le : ce sera
   la réponse à garder.

### P2 — le reste

7. `up.ts` : `postmasterPid = pgOrphans[0]?.pid` — le premier de la liste
   est-il bien le postmaster, ou peut-ce être un worker ? Si c'est un worker,
   `stopOrphanPostgres` refuse (le lockfile nomme autre chose) et on passe au
   `SIGKILL` direct. Est-ce acceptable ou faut-il trier ?
8. `readPostmasterPid` est conservé comme façade de `readPostmasterClaim`.
   Reste-t-il un appelant pour qui la façade cache maintenant quelque chose
   d'important ?
9. Les tests : chacun rougit-il VRAIMENT sans son correctif ? En particulier
   celui qui tient la perte assumée (« owns NOTHING when no lockfile ») — un
   test qui fige une absence est facile à écrire et facile à rendre vide.

## Hors périmètre

Le reste de `up.ts` ; style, nommage.

## Ce dont je doute moi-même

La question 3. J'ai fait taire la garde quand une date manque, pour ne pas
refuser notre propre serveur sur une ligne WMI incomplète. C'est peut-être le
mauvais côté : un trou qui s'ouvre tout seul, exactement comme les précédents.

## Forme du rapport

Les constats d'abord (fichier:ligne, déclenchement, gravité), puis les neuf
questions avec « tient » / « constat » / « NON TRANCHÉ ». Terminer par UNE
ligne : « rien de neuf », « des constats », ou « la forme est en cause ».
