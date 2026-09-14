# Demande de review — dette de la PR #66, passe 6

Passe 5 : deux constats, dont une **régression que j'avais introduite** en
passe 4.

La réponse n'est pas une sixième approximation. `markdownHasTitle` est
**supprimée** et remplacée par `remark-parse` 11.0.0, déjà épinglé dans ce dépôt
pour le même travail côté écran, désormais dépendance de `apps/runner`
(`ec549645`). Un titre = le premier nœud `heading` de profondeur 1 dans l'arbre.
`blankFencedBlocks` et la règle « colonne zéro » disparaissent avec.

Cette passe relit `ec549645`.

Sandbox lecture seule. Deux verdicts : **le constat tient** ou **le constat est
faux**.

Lire `git show ec549645`, le rapport de la passe 5
(`docs/validation/rapport-review-pr66-passe5.md`), puis
`apps/runner/src/verification/document.ts`, son test, et
`apps/runner/package.json`.

## Ce que la passe 5 a changé

Dix-neuf cas passent sans exception : les treize figés au fil des passes 2 à 5,
le titre indenté de trois espaces (désormais vert, c'est voulu), le
front-matter en LF et en CRLF, une liste suivie d'un filet, un bloc de code
seul, et un document qui commence en profondeur 2.

## Questions, par priorité

### P0

1. Le correctif existe-t-il dans `ec549645` ? Cite la ligne.
2. **Cherche un FAUX VERT.** C'est le seul sens qui compte : un document sans
   titre déclaré vert. Sonde `remark-parse` sur ce que je n'ai pas essayé — un
   `#` dans un bloc HTML brut, un titre à l'intérieur d'un commentaire HTML,
   une entité `&#35;` en début de ligne, un fichier vide de titre mais avec un
   `heading` de profondeur 1 produit par une extension GFM que je n'ai pas
   activée, un `#` précédé d'un BOM.
3. **La dépendance.** `remark-parse` et `unified` sont ajoutés à
   `apps/runner/package.json` et au lockfile. Est-ce que ça casse quelque chose
   que je n'ai pas regardé — le `pack` publié, le bundle, une règle
   d'architecture, `deps:check` ?

### P1

4. Reste-t-il, dans les quinze correctifs de cette branche, un comportement que
   la passe 1 avait jugé cassé et qui repasserait sans faire rougir un test ?
5. Reste-t-il un commentaire qui énonce ce que le code ne fait pas ?

### P2

6. Si tu ne trouves **rien de neuf**, dis-le à la dernière ligne.

## Hors périmètre

Les six autres PR de la dette ; **l'issue #101** ; `apps/qa` ; style, nommage.

## Ce dont je doute moi-même

La question 3. J'ai ajouté une dépendance à un paquet publié sur npm sans
pouvoir lancer un `pnpm install` complet ici — le lockfile est à jour, les liens
sont posés à la main comme pnpm les pose, mais je n'ai pas vu une installation
propre repartir de zéro.

## Forme du rapport

Les constats d'abord (fichier:ligne, déclenchement, gravité, ET le SENS de
l'erreur : faux vert ou faux rouge), puis les six questions avec « tient » /
« constat » / « NON TRANCHÉ ». Terminer par UNE ligne : « rien de neuf », « des
constats », ou « la forme est en cause ».
