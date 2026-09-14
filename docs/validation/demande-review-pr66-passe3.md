# Demande de review — dette de la PR #66, passe 3

Passe 2 : trois constats sur MES correctifs (1 bloquant, 2 importants), tous
vrais, tous corrigés dans `e3e7735b`.

Cette passe relit `e3e7735b`.

Sandbox lecture seule. Deux verdicts : **le constat tient** ou **le constat est
faux**.

Lire `git show e3e7735b`, le rapport de la passe 2
(`docs/validation/rapport-review-pr66-passe2.md`), puis
`apps/runner/src/verification/document.ts` et son test.

## Ce que la passe 2 a changé

| Constat | Correctif |
|---|---|
| R1 | Le manifeste d'un document hache le **CONTENU** (sha256), plus taille+mtime. Le résidu annoncé est fermé, pas documenté. |
| R2 | La regex des blocs clôturés : fin d'INPUT au lieu de `$` multiligne, et clôture plus longue que l'ouverture acceptée (CommonMark). |
| R3 | Un DOCTYPE à sous-ensemble interne fait retomber sur `fatalError` seul — `@xmldom/xmldom` ne lit pas les entités déclarées et rapportait `error` sur du XML valide. |

## Questions, par priorité

### P0

1. Les trois correctifs existent-ils dans `e3e7735b` ? Cite la ligne de chacun.
2. **La regex des blocs clôturés, encore.** Elle a été fausse deux fois. Sonde-la
   sur : un bloc indenté de quatre espaces (bloc de code NON clôturé), une
   clôture indentée de trois espaces, un `~~~` fermé par ```` ``` ````, un bloc
   dont la ligne d'info contient des backticks, deux blocs successifs, un titre
   entre deux blocs, un bloc à l'intérieur d'une citation `>`.
3. **Le hachage du contenu.** `fileStamp` lit le fichier entier à chaque
   `loadConfig`, donc DEUX fois par finalisation (transaction 1 et 2), plus une
   fois pour la preuve. Sur quel ordre de grandeur cela devient-il un problème,
   et un document peut-il être gros au point que ça compte ?
4. **Le sous-ensemble interne.** `/<!DOCTYPE[^>[]*\[/i` — quels DOCTYPE
   valides cette détection rate-t-elle, et quels textes non-DOCTYPE
   attrape-t-elle à tort (une chaîne dans un attribut, un commentaire) ? Une
   fausse détection fait retomber sur `fatalError` seul : quel trou cela rouvre-t-il ?

### P1

5. Reste-t-il, dans les neuf correctifs de la passe 1 ET les trois de la passe 2,
   un comportement que la passe 1 avait jugé cassé et qui repasserait sans faire
   rougir un test ?
6. Reste-t-il un commentaire qui énonce ce que le code ne fait pas ?

### P2

7. Si tu ne trouves **rien de neuf**, dis-le à la dernière ligne.

## Hors périmètre

Les six autres PR de la dette (#75, #73, #74, #91, #87, #77) — relues ensuite,
séparément ; `apps/qa` ; style, nommage.

## Ce dont je doute moi-même

La question 2. Cette regex s'est trompée deux fois, et chaque fois mes propres
tests passaient à côté parce que je choisissais les exemples après avoir écrit
la règle. Sonde-la avec des cas que je n'aurais pas pensé à écrire.

## Forme du rapport

Les constats d'abord (fichier:ligne, déclenchement, gravité), puis les sept
questions avec « tient » / « constat » / « NON TRANCHÉ ». Terminer par UNE
ligne : « rien de neuf », « des constats », ou « la forme est en cause ».
