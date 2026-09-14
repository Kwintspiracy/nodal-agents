# Demande de review — PR #98, passe 10

Passe 9 : quatre constats, aucun bloquant, tous vrais, tous corrigés dans
`3959dcb7`. L'un d'eux portait sur l'honnêteté de cette branche : un correctif
annoncé dans un message de commit n'était pas dans le code. Tu l'as attrapé.

Cette passe relit `3959dcb7`.

Sandbox lecture seule. Deux verdicts : **le constat tient** ou **le constat est
faux**.

Lire `git show 3959dcb7`, le rapport de la passe 9
(`docs/validation/rapport-review-pr98-passe9.md`), puis
`apps/cli/src/lib/orphans.ts`, `apps/cli/src/lib/postgres.ts`,
`apps/cli/src/commands/up.ts` et les deux fichiers de tests.

## Ce que la passe 9 a changé

| Constat | Correctif |
|---|---|
| R1 | L'appartenance est relue juste AVANT `stopOrphanPostgres`, en plus d'avant chaque kill. |
| R2 | Le repliement des séparateurs devient Windows-seulement, comme la casse. |
| R3 | Le filtre `isPidAlive` sur `leftAlone` — celui qui manquait vraiment — est posé. |
| R4 | Les deux tests qui faisaient échouer une implémentation correcte sous Linux sont séparés (casse / séparateurs) et déliés d'un âge de processus non garanti. |

## Questions, par priorité

### P0 — vérifier que les correctifs SONT là

1. **Avant tout : les quatre correctifs annoncés existent-ils dans
   `3959dcb7` ?** Ne te fie pas au message. Cite la ligne de chacun. C'est le
   contrôle que la passe 9 a rendu nécessaire.
2. Reste-t-il un chemin par lequel `up` signale un processus non confirmé par
   une lecture fraîche ? Trajet complet, une dernière fois.
3. La relecture ajoutée avant l'arrêt gracieux fait une troisième invocation de
   `postgresProcessesForDataDir` sur le chemin nominal. Sous Windows c'est un
   `powershell` de plus. Est-ce acceptable, ou faut-il un cache borné dans le
   temps (et lequel serait sûr) ?

### P1 — la forme finale

4. Reste-t-il un commentaire, un message d'écran ou un message de commit qui
   énonce ce que le code ne fait pas ? Septième demande.
5. Les tests : lequel passerait encore si l'on remettait un comportement jugé
   dangereux par l'une des neuf passes ? Nomme le comportement ET le test. Si
   tu n'en trouves plus, dis-le.
6. Si tu ne trouves **rien de neuf**, dis-le à la dernière ligne. C'est la
   condition de merge de cette PR, et je ne la merge pas avant de l'avoir lue.

## Hors périmètre

`down.ts`, `sweepRecordedChildren`, la boucle non-postgres et `taskkill /T`
(acté passe 5) ; la revérification par pid de `runUp` sans test (acté passes 6
à 8) ; le reste de `up.ts` ; style, nommage.

## Ce dont je doute moi-même

Que neuf passes aient suffi. Chacune a trouvé quelque chose de vrai ; je n'ai
aucune raison de croire que la dixième ne trouvera rien, sauf que la gravité a
baissé de « bloquant » à « modéré » et que les trois derniers constats
portaient sur des messages et des tests, plus sur la règle elle-même.

## Forme du rapport

Les constats d'abord (fichier:ligne, déclenchement, gravité), puis les six
questions avec « tient » / « constat » / « NON TRANCHÉ ». Terminer par UNE
ligne : « rien de neuf », « des constats », ou « la forme est en cause ».
