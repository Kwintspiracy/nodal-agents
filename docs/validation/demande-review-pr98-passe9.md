# Demande de review — PR #98, passe 9

Passe 8 : quatre constats (2 majeurs, 2 modérés), aucun bloquant. Tous vrais,
tous corrigés dans `2b205cb8`.

Cette passe relit `2b205cb8`.

Sandbox lecture seule. Deux verdicts : **le constat tient** ou **le constat est
faux**.

Lire `git show 2b205cb8`, le rapport de la passe 8
(`docs/validation/rapport-review-pr98-passe8.md`), puis
`apps/cli/src/lib/orphans.ts`, `apps/cli/src/lib/postgres.ts`,
`apps/cli/src/commands/up.ts` et les deux fichiers de tests.

## Ce que la passe 8 a changé

| Constat | Correctif |
|---|---|
| R1 | `sameDirectory` ne replie la casse que sous Windows. |
| R2 | Le commentaire ne promet plus ce que la date ne tient pas : le résidu (horloge reculée AVANT la naissance de l'étranger, sous Windows) est nommé avec ses trois conditions. |
| R3 | `leftAlone` ne compte que les pids VIVANTS ; la branche « ports encore tenus » liste aussi les refusés. |
| R4 | Le test de concordance temporelle du repli se place dans le dossier (`process.chdir`) pour que la date soit la seule barrière ; un cas miroir fixe le côté acceptant ; l'âge minimum du test Linux passe à 3 s. |

## Questions, par priorité

### P0 — la dernière ligne droite

1. **Reste-t-il un chemin, quelconque, par lequel `up` signale un processus
   qui n'a pas été confirmé par une lecture FRAÎCHE ?** Reprends le trajet une
   dernière fois, en incluant `leftAlone`, la branche `stillHeld`, et le
   `stopOrphanPostgres` initial. Si la réponse est non, dis-le clairement.
2. **`process.chdir` dans un test.** Vitest peut exécuter des fichiers en
   parallèle dans le même processus. Ce `chdir`, même rendu dans un `finally`,
   peut-il perturber un autre test du paquet ? Si oui, comment l'écrire
   autrement sans perdre ce qu'il prouve ?
3. **Le résidu Windows.** Est-il correctement borné dans le commentaire — ni
   sous-estimé, ni dramatisé ? Manque-t-il une condition ?

### P1 — la forme finale

4. Reste-t-il un commentaire qui énonce une règle que le code ne tient pas ?
   Sixième demande ; j'en ai corrigé cinq.
5. Reste-t-il du code mort, une fonction exportée que plus personne n'appelle,
   ou un export élargi uniquement pour les tests et qui devrait redevenir
   privé ?
6. Les tests : lequel passerait encore si l'on remettait un comportement jugé
   dangereux par l'une des huit passes ? Nomme le comportement ET le test. Si
   tu n'en trouves plus, dis-le.

## Hors périmètre

`down.ts`, `sweepRecordedChildren`, la boucle non-postgres et `taskkill /T`
(acté passe 5) ; la revérification par pid de `runUp` sans test (acté passes 6,
7 et 8) ; le reste de `up.ts` ; style, nommage.

## Ce dont je doute moi-même

La question 2 : j'ai mis un `process.chdir` dans un test, ce qui est un état
global. Si le paquet exécute plusieurs fichiers dans le même processus, c'est
un piège que je viens de poser pour quelqu'un d'autre.

## Forme du rapport

Les constats d'abord (fichier:ligne, déclenchement, gravité), puis les six
questions avec « tient » / « constat » / « NON TRANCHÉ ». Terminer par UNE
ligne : « rien de neuf », « des constats », ou « la forme est en cause ».
