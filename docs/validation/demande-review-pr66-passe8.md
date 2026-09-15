# Demande de review — dette de la PR #66, passe 8

Passe 7 : trois constats, tous fondés, tous corrigés.

- **R1 et R2** — la même ligne portait un faux vert ET un faux rouge. Le retrait
  du front-matter ne connaissait qu'`---` fermé par `---`, et sa recherche
  paresseuse manquait l'en-tête vide. Remplacé par une boucle de lignes sur les
  trois clôtures réelles (`---`, `...`, `+++`), cinq cas figés, deux mutations.
- **R3** — quatre commentaires décrivaient du code qui avait bougé. Réécrits.

Cette passe relit `c9695181` et `cd99f286`.

Sandbox lecture seule. Deux verdicts : **le constat tient** ou **le constat est
faux**.

## Questions, par priorité

### P0

1. Les correctifs existent-ils ? Cite les lignes.
2. **Cherche encore un FAUX VERT.** `stripFrontMatter` est une boucle, pas une
   grammaire YAML : sonde-la. Un en-tête dont l'ouverture porte des espaces en
   tête (`  ---`), un `---` en tête suivi d'un `+++` fermant, un document qui
   n'est QUE `---\n---\n`, un CRLF isolé, un fichier vide, un en-tête dont la
   clôture est dans un bloc de code.
3. Reste-t-il, dans les dix-sept correctifs de cette branche, un comportement
   que la passe 1 avait jugé cassé et qui repasserait sans faire rougir un test ?

### P1

4. Reste-t-il un commentaire qui énonce ce que le code ne fait pas ?

### P2

5. Si tu ne trouves **rien de neuf**, dis-le à la dernière ligne.

## Hors périmètre

Les six autres PR de la dette ; **l'issue #101** ; la limite XML des entités à
nom pointé, tranchée en passe 7 et écrite dans le code ; `apps/qa` ; le style.

## Forme du rapport

Les constats d'abord (fichier:ligne, déclenchement, gravité, ET le SENS de
l'erreur : faux vert ou faux rouge), puis les cinq questions avec « tient » /
« constat » / « NON TRANCHÉ ». Terminer par UNE ligne : « rien de neuf », « des
constats », ou « la forme est en cause ».
