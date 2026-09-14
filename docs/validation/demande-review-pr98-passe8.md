# Demande de review — PR #98, passe 8

Passe 7 : quatre constats (1 majeur persistant, 1 majeur partiel, 2 modérés),
**aucun bloquant**. Tous vrais, tous corrigés dans `b99c59cf`.

Cette passe relit `b99c59cf`.

Sandbox lecture seule. Deux verdicts : **le constat tient** ou **le constat est
faux**.

Lire `git show b99c59cf`, le rapport de la passe 7
(`docs/validation/rapport-review-pr98-passe7.md`), puis
`apps/cli/src/lib/orphans.ts`, `apps/cli/src/lib/postgres.ts`,
`apps/cli/src/commands/up.ts` et les deux fichiers de tests.

## Ce que la passe 7 a changé

| Constat | Correctif |
|---|---|
| R1 | Ton contre-exemple tenait : aucun ancrage d'horloge ne survit au recul de l'horloge. Une DEUXIÈME preuve est ajoutée, sans horloge : `postmasterHoldsDataDir` compare `/proc/<pid>/cwd` (lien maintenu par le NOYAU) au dossier de données. Les deux preuves doivent tenir ; l'une indisponible = refus. |
| R2 | « Orphans cleaned up » ne s'affiche plus au-dessus de ce qu'on a refusé de toucher : les pids laissés vivants sont nommés et comptés. |
| R3 | Les tests du repli assertent la CONCORDANCE, plus la seule disponibilité d'une date ; le cas sans horloge a son propre test. |
| R4 | Quatre commentaires qui contredisaient le code, corrigés. |

## Questions, par priorité

### P0 — la preuve sans horloge

1. **`postmasterHoldsDataDir`.** Le postmaster de PostgreSQL 18 `chdir()`-t-il
   bien dans son dossier de données et y reste-t-il ? Vérifie dans les sources
   (`ChangeToDataDir`, et ce qui se passe ensuite). Un worker hérite-t-il de ce
   `cwd` ? Existe-t-il une configuration où le postmaster a un AUTRE `cwd` —
   `data_directory` pointant ailleurs que le dossier du fichier de
   configuration, un démarrage par systemd avec `WorkingDirectory=`, un chroot ?
2. **Le sens de l'erreur.** Si `cwd` diffère pour une raison légitime, on
   refuse et rien n'est nettoyé. Est-ce le bon côté ? Y a-t-il une lecture de
   `/proc` qui donnerait la même preuve de façon plus large — par exemple le
   fichier `postmaster.pid` lui-même OUVERT par ce pid (`/proc/<pid>/fd`) ?
3. **Le trou restant, nommé.** Sous Windows, la sonde WMI donne une
   `CreationDate` STOCKÉE par le noyau, qui ne bouge pas quand on règle
   l'horloge — donc le contre-exemple de recul ne s'y reproduit pas. Le
   confirmes-tu ? Si oui, le chemin Windows n'a pas besoin de la preuve `cwd`,
   et il faut le DIRE dans le code ; si non, Windows a le même trou et rien ne
   le bouche.

### P1 — le reste

4. Le message final (`leftAlone`) est-il juste dans tous les cas — y compris
   quand `stillHeld` ET `leftAlone` sont non vides (la branche `stillHeld`
   gagne et ne dit rien des refusés) ?
5. Reste-t-il un commentaire qui énonce une règle que le code ne tient pas ?
   C'est la cinquième fois que j'en corrige ; cherche une fois de plus.
6. Les tests : lequel passerait encore si l'on remettait un comportement jugé
   dangereux par l'une des sept passes ? Nomme le comportement ET le test.

## Hors périmètre

`down.ts`, `sweepRecordedChildren`, la boucle non-postgres et `taskkill /T`
(acté passe 5) ; la revérification par pid de `runUp` sans test (acté passes 6
et 7) ; le reste de `up.ts` ; style, nommage.

## Ce dont je doute moi-même

La question 1. J'affirme que le postmaster vit dans son dossier de données.
C'est vrai de mémoire, pas d'une lecture des sources — exactement le genre
d'affirmation qui a déjà menti quatre fois dans cette PR.

## Forme du rapport

Les constats d'abord (fichier:ligne, déclenchement, gravité), puis les six
questions avec « tient » / « constat » / « NON TRANCHÉ ». Terminer par UNE
ligne : « rien de neuf », « des constats », ou « la forme est en cause ».
