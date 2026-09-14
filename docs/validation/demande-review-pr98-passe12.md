# Demande de review — PR #98, passe 12

Passe 11 : trois constats, aucun bloquant — deux de documentation, un de
couverture. Tous vrais, tous corrigés dans `d24ab568`.

Cette passe relit `d24ab568`.

Sandbox lecture seule. Deux verdicts : **le constat tient** ou **le constat est
faux**.

Lire `git show d24ab568`, le rapport de la passe 11
(`docs/validation/rapport-review-pr98-passe11.md`), puis
`apps/cli/src/lib/orphans.ts`, `apps/cli/src/lib/postgres.ts`,
`apps/cli/src/commands/up.ts` et les deux fichiers de tests.

## Ce que la passe 11 a changé

| Constat | Correctif |
|---|---|
| R1 | Un test Linux oppose deux dossiers ne différant QUE par la casse et exerce `postmasterHoldsDataDir` lui-même, avec une assertion miroir depuis le dossier où le processus tourne vraiment. |
| R2 | Le résumé de `unconfirmedReading` ne s'arrête plus à la vivacité (trois conditions, pas une) ; la note sur les deux preuves ne réduit plus le trou de l'horloge au seul recul. |
| R3 | Le message d'écran nomme les TROIS causes de refus, dont le répertoire courant. |

## Questions, par priorité

### P0

1. Les trois correctifs existent-ils dans `d24ab568` ? Cite la ligne de
   chacun.
2. Reste-t-il un chemin par lequel `up` signale un processus non confirmé par
   une lecture fraîche ?
3. Reste-t-il un comportement jugé dangereux par l'une des onze passes qui
   repasserait sans faire rougir un test ? Nomme le comportement ET le test.
   C'est la question qui a rendu trois constats de suite ; si elle est vide
   cette fois, dis-le explicitement.

### P1

4. Reste-t-il un commentaire, un message d'écran ou un message de commit qui
   énonce ce que le code ne fait pas ? Neuvième demande ; j'en ai corrigé huit.
5. Le nouveau test Linux : `process.chdir` puis deux `unconfirmedReading` —
   prouve-t-il ce qu'il prétend, et seulement cela ? Peut-il échouer pour une
   raison sans rapport (un `/tmp` monté en insensible à la casse, par exemple) ?

### P2

6. Si tu ne trouves **rien de neuf**, dis-le à la dernière ligne. C'est la
   condition de merge.

## Hors périmètre

`down.ts`, `sweepRecordedChildren`, la boucle non-postgres et `taskkill /T` —
désormais **l'issue #100**, ouverte avec tes pointeurs ; la revérification par
pid de `runUp` sans test (acté passes 6 à 8) ; le reste de `up.ts` ; style,
nommage.

## Ce dont je doute moi-même

La question 5. Mon test neuf suppose que `/tmp` est sensible à la casse sous
Linux. C'est vrai partout où j'ai regardé, mais je ne l'ai pas vérifié sur le
runner de CI, et un test qui échoue pour la mauvaise raison est pire qu'un test
absent.

## Forme du rapport

Les constats d'abord (fichier:ligne, déclenchement, gravité), puis les six
questions avec « tient » / « constat » / « NON TRANCHÉ ». Terminer par UNE
ligne : « rien de neuf », « des constats », ou « la forme est en cause ».
