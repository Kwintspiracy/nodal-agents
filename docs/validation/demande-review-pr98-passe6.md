# Demande de review — PR #98, passe 6

Passe 5 : 4 constats bloquants. Trois corrigés dans `236f1037` ; le quatrième
(R3, la boucle non-postgres et `taskkill /T` qui ne consultent pas
l'appartenance) est **hors périmètre** — il précède cette PR et vit avec
`down.ts`. Il partira en issue. **Ne le redis pas comme bloquant de cette PR** ;
si tu le retrouves, dis « hors périmètre, déjà noté ».

Cette passe relit `236f1037`.

Sandbox lecture seule. Deux verdicts : **le constat tient** ou **le constat est
faux**.

Lire `git show 236f1037`, le rapport de la passe 5
(`docs/validation/rapport-review-pr98-passe5.md`), puis
`apps/cli/src/lib/orphans.ts`, `apps/cli/src/lib/postgres.ts`,
`apps/cli/src/commands/up.ts` et les deux fichiers de tests.

## Ce que la passe 5 a changé

| Constat | Correctif |
|---|---|
| R1 | `unconfirmedReading` ne se fie plus à la vivacité : elle DATE le pid par l'OS (`processStartedAtMs`, `/proc/<pid>/stat` + `btime` sous Linux) et passe par la même confirmation. Sans date possible : rien. `ownedPostgresPids` ne possède plus rien quand `tableRead` est faux. |
| R2 | La revérification d'appartenance est PAR PID, juste avant chaque signal. |
| R4 | Le message de refus nomme le dossier, la raison, et dit quoi faire. |

## Questions, par priorité

### P0 — le nouveau code

1. **`processStartedAtMs`.** Le champ 22 de `/proc/<pid>/stat` est-il bien
   `starttime`, et mon découpage (tout après le DERNIER `)`, puis index 19) le
   désigne-t-il vraiment ? Compte les champs sur un vrai format. `btime` de
   `/proc/stat` est-il en secondes epoch ? Et `USER_HZ` : je l'ai figé à 100 —
   sur quelles configurations réelles est-ce faux, et que se passe-t-il alors
   (refus systématique de notre propre postmaster, ou acceptation d'un
   étranger) ?
2. **Le sens de l'erreur, encore.** Si `processStartedAtMs` se trompe d'échelle
   ou d'origine, l'écart dépasse 2 s et on REFUSE — donc on ne tue rien. Le
   confirmes-tu, ou existe-t-il un calcul faux qui rapprocherait par accident
   deux dates sans rapport ?
3. **`unconfirmedReading` sous Windows.** Quand la sonde WMI échoue, on tombe
   ici, et `processStartedAtMs` rend `null` (non-Linux) ⇒ rien n'est possédé.
   Sous Windows, existe-t-il un moyen simple et SÛR de dater un seul pid
   (`Get-Process`, `GetProcessTimes`) qui vaudrait la peine, ou vaut-il mieux
   rester sur le refus ?

### P1 — la boucle et le message

4. **La revérification par pid.** Elle relance `postgresProcessesForDataDir()`
   à chaque tour — donc un `powershell` par pid sous Windows. Combien de pids
   au pire (postmaster + workers) ? Est-ce un coût acceptable au démarrage, ou
   faut-il le borner ?
5. **Le message de refus.** Relis-le en te mettant à la place de quelqu'un qui
   le voit pour la première fois. Dit-il assez ? Dit-il quelque chose de faux ?
6. **Les workers, encore.** Passe 5, constat R4 : si le postmaster entre par le
   listener ou par le fichier, la troisième voie n'ajoute pas ses workers ;
   et si le postmaster a disparu, aucun worker n'est nettoyable. Le premier cas
   est-il réel dans le code d'aujourd'hui ? Le second est-il acceptable ?

### P2 — les tests

7. Chacun des correctifs de `236f1037` rougit-il sans lui ? Reste-t-il un
   comportement neuf sans test — notamment la revérification par pid, dont la
   passe 5 disait qu'aucun test ne l'exerçait ?
8. Quelque chose dans la suite exige-t-il encore un comportement que nous avons
   jugé dangereux ?

## Hors périmètre

`down.ts`, `sweepRecordedChildren`, la boucle non-postgres et `taskkill /T`
(R3 de la passe 5 — déjà acté, partira en issue) ; le reste de `up.ts` ; style,
nommage.

## Ce dont je doute moi-même

La question 1. J'ai écrit un parseur de `/proc` de mémoire, avec un `USER_HZ`
en dur, et je n'ai pas de Linux sous la main pour l'exécuter. Si l'index est
faux, la garde devient un refus permanent sur cette plateforme — et personne ne
le verra tant que la CI ne tourne pas dessus.

## Forme du rapport

Les constats d'abord (fichier:ligne, déclenchement, gravité), puis les huit
questions avec « tient » / « constat » / « NON TRANCHÉ ». Terminer par UNE
ligne : « rien de neuf », « des constats », ou « la forme est en cause ».
