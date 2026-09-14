# Demande de review — PR #98, passe 7

Passe 6 : quatre constats (2 majeurs, 2 modérés), **aucun bloquant** — la
première passe sans. Tous vrais, tous corrigés dans `58505554`.

Cette passe relit `58505554`.

Sandbox lecture seule. Deux verdicts : **le constat tient** ou **le constat est
faux**.

Lire `git show 58505554`, le rapport de la passe 6
(`docs/validation/rapport-review-pr98-passe6.md`), puis
`apps/cli/src/lib/orphans.ts`, `apps/cli/src/lib/postgres.ts`,
`apps/cli/src/commands/up.ts` et les deux fichiers de tests.

## Ce que la passe 6 a changé

| Constat | Correctif |
|---|---|
| R1 | La date d'un pid vient de `/proc/uptime` + l'horloge COURANTE, plus de `btime` (que Linux décale quand on règle l'horloge). Un saut d'horloge éloigne donc l'estimation ⇒ refus. Même raisonnement écrit pour `USER_HZ` figé à 100. |
| R2 | Tout pid confirmé rejoint la liste des orphelins, plus seulement quand les deux autres sondes n'ont rien trouvé. |
| R3 | Le message de refus ne prétend plus avoir comparé deux dates ; il donne les deux raisons possibles et dit quoi regarder. |
| R4 | Le test Linux se compare à `process.uptime()` à 2 s près ; le repli a trois tests, une moitié par plateforme. |

**Reconnu non couvert** : la revérification par pid dans `runUp`. Rien
n'exerce `runUp` dans ce paquet.

## Questions, par priorité

### P0 — le calcul de date, dernière fois

1. `Date.now() - (uptime - starttime/100) * 1000`. Vérifie l'arithmétique et
   les unités sur un exemple. `/proc/uptime` est-il bien en secondes depuis le
   démarrage, et est-il CLOCK_BOOTTIME (donc insensible à `settimeofday`,
   mais incluant la veille) ou CLOCK_MONOTONIC ? Si la machine a été SUSPENDUE
   entre le démarrage du postmaster et maintenant, l'estimation dérive-t-elle,
   et de quel côté ?
2. Reste-t-il un chemin où deux dates sans rapport se rapprochent à moins de
   2 s par accident ? Donne-le, ou dis qu'il n'y en a pas.
3. L'ajout systématique des pids confirmés (R2) peut-il faire ENTRER dans la
   liste un pid qui n'y était pas avant et qui ne devrait pas être tué ? Trace
   d'où vient `ownedPgPids` et ce qui le peuple.

### P1 — ce qui reste ouvert

4. La revérification par pid de `runUp` n'a pas de test, et je le dis. Est-ce
   que quelque chose de plus léger qu'un harnais complet la verrouillerait —
   extraire la décision dans une fonction pure, par exemple ? Si oui, dis
   laquelle ; si non, dis que c'est le bon aveu.
5. Reste-t-il, dans les trois fichiers du périmètre, un COMMENTAIRE qui énonce
   une règle que le code ne tient pas ? Cette PR en a corrigé trois
   (`stop()` qui ne stoppe rien, « un disque lent », « its start time does not
   match »). C'est un motif : cherche-le une fois de plus.
6. Les tests : lequel passerait encore si l'on remettait un comportement que
   les six passes ont jugé dangereux ? Nomme le comportement ET le test.

## Hors périmètre

`down.ts`, `sweepRecordedChildren`, la boucle non-postgres et `taskkill /T`
(acté passe 5, partira en issue) ; le reste de `up.ts` ; style, nommage.

## Ce dont je doute moi-même

La suspension de la machine (question 1). `/proc/uptime` inclut le temps de
veille sous Linux ; si ce n'était pas le cas, toute machine ayant dormi
refuserait son propre postmaster.

## Forme du rapport

Les constats d'abord (fichier:ligne, déclenchement, gravité), puis les six
questions avec « tient » / « constat » / « NON TRANCHÉ ». Terminer par UNE
ligne : « rien de neuf », « des constats », ou « la forme est en cause ».
