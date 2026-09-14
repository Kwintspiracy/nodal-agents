# Demande de review — dette de la PR #66, passe 5

Passe 4 : cinq constats. Quatre en périmètre, tous vrais, tous corrigés dans
`bec62175`. Le cinquième (R2, bloquant, l'epoch d'un projet de code) est
**préexistant** et part en **issue #101**, avec les constats R4/R5 de ta passe 2
sur `intent.ts` et la dérivation de l'écran Code.

Cette passe relit `bec62175`.

Sandbox lecture seule. Deux verdicts : **le constat tient** ou **le constat est
faux**.

Lire `git show bec62175`, le rapport de la passe 4
(`docs/validation/rapport-review-pr66-passe4.md`), puis
`apps/runner/src/verification/document.ts` et son test.

## Ce que la passe 4 a changé

| Constat | Correctif |
|---|---|
| R1 | UNE lecture, et tous les constats en découlent — `exists` et `not-empty` prenaient un `stat` antérieur. |
| R3 | Le préfixe de conteneur (citation, liste) est retiré avant de lire la ligne ; la fin d'une clôture n'accepte plus que espaces et tabulations. |
| R4 | Casse sensible pour le nom d'entité ; commentaires et CDATA retirés avant de chercher la déclaration. |

## Questions, par priorité

### P0

1. Les quatre correctifs existent-ils dans `bec62175` ? Cite la ligne de chacun.
2. **Le retrait du préfixe de conteneur.** C'est une approximation. Sonde-la :
   une ligne de prose commençant par `- ` (un tiret suivi d'un espace n'est pas
   toujours une liste), un `>` dans du texte ordinaire, une liste ordonnée
   `1.` en début de phrase, une ligne `--- ` qui est un filet. Le retrait
   peut-il faire DISPARAÎTRE un vrai titre, ou en fabriquer un ?
3. **La lecture unique.** Reste-t-il, dans `runProof`, une lecture du disque
   autre que celle-là ? Et dans `loadConfig` — `fileStamp` lit aussi : les deux
   valeurs peuvent-elles diverger d'une façon qui compte ?

### P1

4. Reste-t-il, dans les treize correctifs de cette branche, un comportement que
   la passe 1 avait jugé cassé et qui repasserait sans faire rougir un test ?
5. Reste-t-il un commentaire qui énonce ce que le code ne fait pas ?

### P2

6. Si tu ne trouves **rien de neuf**, dis-le à la dernière ligne.

## Hors périmètre

Les six autres PR de la dette (#75, #73, #74, #91, #87, #77) ; **l'issue #101**
(epoch d'un projet de code, dérivation de l'écran Code) ; `apps/qa` ; style,
nommage.

## Ce dont je doute moi-même

La question 2. Retirer un préfixe de conteneur par expression régulière est une
approximation de plus, posée pour réparer une approximation. Si elle peut faire
disparaître un vrai titre, j'ai échangé un faux vert contre un faux rouge.

## Forme du rapport

Les constats d'abord (fichier:ligne, déclenchement, gravité), puis les six
questions avec « tient » / « constat » / « NON TRANCHÉ ». Terminer par UNE
ligne : « rien de neuf », « des constats », ou « la forme est en cause ».
