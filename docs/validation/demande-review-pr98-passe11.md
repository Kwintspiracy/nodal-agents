# Demande de review — PR #98, passe 11

Passe 10 : trois constats, aucun bloquant, tous vrais, tous corrigés dans
`1091d64d`. Tous portaient sur la COUVERTURE (des tests qui ne pouvaient pas
échouer) et sur des commentaires qui en disaient trop — plus sur la règle
elle-même.

Cette passe relit `1091d64d`.

Sandbox lecture seule. Deux verdicts : **le constat tient** ou **le constat est
faux**.

Lire `git show 1091d64d`, le rapport de la passe 10
(`docs/validation/rapport-review-pr98-passe10.md`), puis
`apps/cli/src/lib/orphans.ts`, `apps/cli/src/lib/postgres.ts`,
`apps/cli/src/commands/up.ts` et les deux fichiers de tests.

## Ce que la passe 10 a changé

| Constat | Correctif |
|---|---|
| R1 | Le test de datation Linux ATTEND que le processus dépasse la fenêtre de 2 s au lieu de l'exiger. |
| R2 | Un vrai sous-dossier porte un fichier dont la ligne 2 s'écrit avec un antislash : même dossier sous Windows, autre dossier ailleurs. Le test des séparateurs ne traîne plus la casse avec lui. |
| R3 | « strictly after » → « no later, equal passes » ; la troisième sonde n'est plus décrite comme conditionnelle ; le résidu Windows est décrit avec ses DEUX formes (la fenêtre de 2 s suffit, sans aucune manipulation d'horloge). |

## Questions, par priorité

### P0

1. Les trois correctifs existent-ils dans `1091d64d` ? Cite la ligne de
   chacun. (Contrôle systématique depuis la passe 9.)
2. Reste-t-il un chemin par lequel `up` signale un processus non confirmé par
   une lecture fraîche ?
3. Reste-t-il un comportement jugé dangereux par l'une des dix passes qui
   repasserait sans faire rougir un test ? Nomme le comportement ET le test.

### P1

4. Reste-t-il un commentaire, un message d'écran ou un message de commit qui
   énonce ce que le code ne fait pas ? Huitième demande ; j'en ai corrigé sept.
5. Y a-t-il quelque chose dans ce lot que tu n'as PAS pu vérifier et qui
   devrait l'être avant un merge — en nommant l'environnement qu'il faudrait
   (une vraie machine Linux, un vrai recyclage de pid, un vrai cluster) ?

### P2

6. Si tu ne trouves **rien de neuf**, dis-le à la dernière ligne. C'est la
   condition de merge, et je ne merge pas avant de l'avoir lue.

## Hors périmètre

`down.ts`, `sweepRecordedChildren`, la boucle non-postgres et `taskkill /T`
(acté passe 5) ; la revérification par pid de `runUp` sans test (acté passes 6
à 8) ; le reste de `up.ts` ; style, nommage.

## Ce dont je doute moi-même

Que la gravité continue de baisser. Passes 1-3 : bloquants. Passes 4-5 :
bloquants sur les bords. Passes 6-8 : majeurs et modérés. Passes 9-10 :
modérés, sur les tests et les commentaires. Si cette passe ne trouve que des
formulations, c'est fini ; si elle retrouve un bloquant, c'est que je me
raconte une histoire sur la convergence.

## Forme du rapport

Les constats d'abord (fichier:ligne, déclenchement, gravité), puis les six
questions avec « tient » / « constat » / « NON TRANCHÉ ». Terminer par UNE
ligne : « rien de neuf », « des constats », ou « la forme est en cause ».
