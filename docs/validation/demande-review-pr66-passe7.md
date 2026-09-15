# Demande de review — dette de la PR #66, passe 7

Passe 6 : trois constats. **R1 était une régression de ma main** — le passage à
`remark-parse` avait emporté le retrait du front-matter, rouvrant exactement le
constat C5 de la passe 1. Corrigé dans `5583d9c0`, avec trois cas figés.

R2 (entité à nom pointé) n'est **pas** corrigé, et c'est délibéré : le parseur
rend le MÊME message qu'elle soit déclarée ou non — mesuré — donc les séparer
est impossible, et faire taire ce message laisserait passer un `&foo` sans
point-virgule. Le rouge est le côté sûr. Les deux limites du contrôle XML sont
écrites dans le code.

Cette passe relit `5583d9c0`.

Sandbox lecture seule. Deux verdicts : **le constat tient** ou **le constat est
faux**.

Lire `git show 5583d9c0`, le rapport de la passe 6
(`docs/validation/rapport-review-pr66-passe6.md`), puis
`apps/runner/src/verification/document.ts` et son test.

## Questions, par priorité

### P0

1. Le correctif existe-t-il dans `5583d9c0` ? Cite la ligne.
2. **Cherche encore un FAUX VERT.** C'est le seul sens qui compte. Le retrait du
   front-matter est une expression régulière, donc une approximation de plus —
   sonde-la : un front-matter qui n'est pas en tête de fichier, un `---` seul,
   un front-matter TOML `+++`, un front-matter dont la fermeture est `...`
   (permis en YAML), un front-matter contenant une ligne `---`.
3. Le refus de corriger R2 tient-il ? Confirme que les deux messages sont
   identiques, et dis si tu vois une façon de distinguer que je n'ai pas vue.

### P1

4. Reste-t-il, dans les seize correctifs de cette branche, un comportement que
   la passe 1 avait jugé cassé et qui repasserait sans faire rougir un test ?
5. Reste-t-il un commentaire qui énonce ce que le code ne fait pas ?

### P2

6. Si tu ne trouves **rien de neuf**, dis-le à la dernière ligne.

## Hors périmètre

Les six autres PR de la dette ; **l'issue #101** ; `apps/qa` ; style, nommage.

## Ce dont je doute moi-même

La question 2. Je viens de remettre une expression régulière devant un vrai
parseur, pour lui cacher quelque chose qu'il ne sait pas lire. C'est la même
forme d'erreur que les cinq précédentes ; la seule différence est qu'elle porte
sur trois lignes de YAML au lieu de tout CommonMark.

## Forme du rapport

Les constats d'abord (fichier:ligne, déclenchement, gravité, ET le SENS de
l'erreur : faux vert ou faux rouge), puis les six questions avec « tient » /
« constat » / « NON TRANCHÉ ». Terminer par UNE ligne : « rien de neuf », « des
constats », ou « la forme est en cause ».
