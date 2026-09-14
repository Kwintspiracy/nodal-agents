# Demande de review — PR #98, passe 14

Passe 13 : **un** constat, mineur, vrai, corrigé dans `ab4303f5`. Les deux
questions qui comptent — un chemin vers un signal sans confirmation fraîche, un
comportement dangereux qui reviendrait sans faire rougir un test — sont revenues
propres toutes les deux.

Cette passe relit `ab4303f5`.

Sandbox lecture seule. Deux verdicts : **le constat tient** ou **le constat est
faux**.

Lire `git show ab4303f5`, le rapport de la passe 13
(`docs/validation/rapport-review-pr98-passe13.md`), puis
`apps/cli/src/lib/orphans.ts`, `apps/cli/src/lib/postgres.ts`,
`apps/cli/src/commands/up.ts` et les deux fichiers de tests.

## Ce que la passe 13 a changé

`unconfirmedReading` lisait le lockfile, puis appelait `livePostmasterPid`, qui
le relit. Un fichier disparu ou changé entre les deux lectures faisait écrire
« ce pid n'est pas vivant » à propos d'un processus jamais sondé. La sonde de
vivacité est sortie de `livePostmasterPid` (`isPidRunning`), et l'appelant qui
tient un pid demande pour CE pid.

## Questions, par priorité

### P0

1. Le correctif existe-t-il dans `ab4303f5` ? Cite la ligne. `livePostmasterPid`
   garde-t-il exactement son sens d'avant pour ses autres appelants
   (`clearStalePostmasterPid`, `up.ts`) ?
2. Reste-t-il un chemin par lequel `up` signale un processus non confirmé par
   une lecture fraîche ?
3. Reste-t-il un comportement jugé dangereux par l'une des treize passes qui
   repasserait sans faire rougir un test ?

### P1

4. Reste-t-il un commentaire, un message d'écran ou un message de commit qui
   énonce ce que le code ne fait pas ? Onzième demande ; j'en ai corrigé dix.
5. `isPidRunning` rend `true` sur toute erreur qui n'est pas `ESRCH` — y
   compris une erreur qu'on n'a pas prévue. Est-ce le bon côté ici, sachant que
   « vivant » mène à un refus ou à un kill selon la suite ?

### P2

6. Si tu ne trouves **rien de neuf**, dis-le à la dernière ligne. C'est la
   condition de merge.

## Hors périmètre

`down.ts`, `sweepRecordedChildren`, la boucle non-postgres et `taskkill /T` —
**issue #100** ; la revérification par pid de `runUp` sans test (acté passes 6
à 8) ; le reste de `up.ts` ; style, nommage.

## Ce dont je doute moi-même

La question 5, que je n'avais pas vue avant de la formuler : `isPidRunning`
présume vivant quand elle ne sait pas, et « vivant » est la porte d'entrée de
tout le reste. C'est peut-être le bon défaut (un pid vivant mène ensuite à DEUX
preuves qui peuvent refuser), mais je ne l'ai pas raisonné.

## Forme du rapport

Les constats d'abord (fichier:ligne, déclenchement, gravité), puis les six
questions avec « tient » / « constat » / « NON TRANCHÉ ». Terminer par UNE
ligne : « rien de neuf », « des constats », ou « la forme est en cause ».
