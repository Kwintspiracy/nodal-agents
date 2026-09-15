# Demande de review — dette de la PR #66, passe 9

Passe 8 : trois constats, tous fondés, tous corrigés — et R1 a été vérifié À LA
SOURCE avec le vrai parseur avant d'être accepté.

- **R1 et R2** — la clôture cherchée pouvait vivre dans un bloc de code, et le
  retrait emportait l'ouverture du bloc. Le retrait ne décide plus seul : le
  titre doit se voir **des deux côtés** du retrait. Deux cas figés, deux
  mutations (une par moitié de la conjonction). R2 reste rouge, à dessein : un
  titre collé au délimiteur d'ouverture est ce qu'un commentaire YAML donne à
  lire, et c'est le constat C5.
- **R3** — le commentaire du manifeste ne comptait qu'une façon pour la
  configuration de bouger ; il y en a deux depuis C1. Réécrit.

Cette passe relit `44700cae` et le commit de commentaire qui suit.

Sandbox lecture seule. Deux verdicts : **le constat tient** ou **le constat est
faux**.

## Questions, par priorité

### P0

1. Les correctifs existent-ils ? Cite les lignes.
2. **Cherche encore un FAUX VERT** dans `markdownHasTitle`. La conjonction est
   la quatrième forme de cette règle ; sonde-la pour ce qu'elle est. Existe-t-il
   un document SANS titre que les deux lectures déclarent titré ?
3. La conjonction fabrique-t-elle un FAUX ROUGE sur un document ordinaire —
   c'est-à-dire un document dont le titre est réel et hors de tout en-tête et de
   tout bloc de code ?
4. Reste-t-il, dans les dix-neuf correctifs de cette branche, un comportement que
   la passe 1 avait jugé cassé et qui repasserait sans faire rougir un test ?

### P1

5. Reste-t-il un commentaire qui énonce ce que le code ne fait pas ?

### P2

6. Si tu ne trouves **rien de neuf**, dis-le à la dernière ligne.

## Hors périmètre

Les six autres PR de la dette ; **l'issue #101** ; la limite XML des entités à
nom pointé, tranchée en passe 7 ; `apps/qa` ; le style.

## Forme du rapport

Les constats d'abord (fichier:ligne, déclenchement, gravité, ET le SENS de
l'erreur : faux vert ou faux rouge), puis les six questions avec « tient » /
« constat » / « NON TRANCHÉ ». Terminer par UNE ligne : « rien de neuf », « des
constats », ou « la forme est en cause ».
