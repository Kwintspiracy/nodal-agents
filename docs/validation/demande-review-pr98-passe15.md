# Demande de review — PR #98, passe 15

Passe 14 : **un** constat, mineur, de formulation seule — et tu as dit
explicitement qu'aucun contournement n'était en jeu. Corrigé dans `e4c64e35`.

Cette passe relit `e4c64e35`.

Sandbox lecture seule. Deux verdicts : **le constat tient** ou **le constat est
faux**.

Lire `git show e4c64e35`, le rapport de la passe 14
(`docs/validation/rapport-review-pr98-passe14.md`), puis
`apps/cli/src/lib/orphans.ts`, `apps/cli/src/lib/postgres.ts`,
`apps/cli/src/commands/up.ts` et les deux fichiers de tests.

## Ce que la passe 14 a changé

`isPidRunning` est documentée comme ce qu'elle établit — « pas connu comme
disparu », pas « vivant » — avec la note qu'elle n'autorise rien à elle seule.
Le résumé de `unconfirmedReading` distingue les deux preuves qui refusent quand
elles ne savent pas, de la sonde de vivacité qui penche dans l'autre sens. La
ligne d'écran dit « has not been seen to exit ».

## Questions, par priorité

### P0

1. Le correctif existe-t-il dans `e4c64e35` ? Cite la ligne.
2. Reste-t-il un chemin par lequel `up` signale un processus non confirmé par
   une lecture fraîche ?
3. Reste-t-il un comportement jugé dangereux par l'une des quatorze passes qui
   repasserait sans faire rougir un test ?

### P1

4. Reste-t-il un commentaire, un message d'écran ou un message de commit qui
   énonce ce que le code ne fait pas ? Douzième demande ; j'en ai corrigé onze.

### P2

5. Si tu ne trouves **rien de neuf**, dis-le à la dernière ligne. Quinze passes,
   et les trois dernières n'ont rendu que des formulations : c'est la condition
   de merge que j'attends.

## Hors périmètre

`down.ts`, `sweepRecordedChildren`, la boucle non-postgres et `taskkill /T` —
**issue #100** ; la revérification par pid de `runUp` sans test (acté passes 6
à 8) ; le reste de `up.ts` ; style, nommage.

## Ce dont je doute moi-même

Que la boucle s'arrête d'elle-même. Quatorze passes ont chacune trouvé quelque
chose de vrai, et une quinzième trouvera probablement une formulation de plus.
La question utile n'est plus « reste-t-il un défaut » mais « reste-t-il un
défaut qui change ce que le programme FAIT ». Si la réponse est non, dis-le
dans ces termes.

## Forme du rapport

Les constats d'abord (fichier:ligne, déclenchement, gravité), puis les cinq
questions avec « tient » / « constat » / « NON TRANCHÉ ». Terminer par UNE
ligne : « rien de neuf », « des constats », ou « la forme est en cause ».
