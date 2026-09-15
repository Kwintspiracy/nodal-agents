# Demande de review — dette de la PR #66, passe 10

Passe 9 : deux constats, et le premier portait sur la FORME. Il avait raison.

La conjonction posée en passe 8 ne prouvait rien : deux témoins différents la
satisfaisaient. Je suis donc allé MESURER ce que la convention dit vraiment,
hors dépôt, contre `remark-frontmatter` 5.0.0 — la mise en œuvre de référence.
Elle lit l'en-tête exactement comme cette boucle de lignes, et rend le même
verdict sur les dix cas sondés, sauf deux où la règle d'ici est plus STRICTE
(elle connaît la clôture `...` et l'en-tête `+++`).

Conséquence : **le constat R1 de la passe 8 n'était pas fondé**, et je l'avais
accepté sans mesurer. Le correctif bâti dessus fabriquait un vrai faux rouge
(constat R2 de la passe 9). La conjonction est retirée ; il reste UNE lecture.

Cette passe relit `ae6324da`.

Sandbox lecture seule. Deux verdicts : **le constat tient** ou **le constat est
faux**.

## Questions, par priorité

### P0

1. Le retour à une seule lecture est-il exact ? Cite les lignes.
2. **La mesure est-elle juste ?** C'est le cœur de cette passe. Si tu peux
   installer `remark-frontmatter` 5.0.0 hors dépôt, rejoue les cas et dis si
   cette boucle s'en écarte ailleurs que sur `...` et `+++`. Si tu ne peux pas,
   dis-le : « NON TRANCHÉ » vaut mieux qu'un avis.
3. Reste-t-il un FAUX VERT — un document sans titre déclaré vert ?
4. Reste-t-il, dans les vingt correctifs de cette branche, un comportement que
   la passe 1 avait jugé cassé et qui repasserait sans faire rougir un test ?

### P1

5. Reste-t-il un commentaire qui énonce ce que le code ne fait pas ?

### P2

6. Si tu ne trouves **rien de neuf**, dis-le à la dernière ligne.

## Hors périmètre

Les six autres PR de la dette ; **l'issue #101** ; la limite XML des entités à
nom pointé, tranchée en passe 7 ; `apps/qa` ; le style.

## Ce dont je doute moi-même

Que la référence soit la bonne autorité. Elle l'est pour « qu'est-ce qu'un
en-tête », qui est une convention et rien d'autre. Elle ne l'est pas pour « ce
document mérite-t-il un vert » — et c'est pour ça que la règle d'ici reste plus
stricte sur deux points au lieu de s'aligner.

## Forme du rapport

Les constats d'abord (fichier:ligne, déclenchement, gravité, ET le SENS de
l'erreur : faux vert ou faux rouge), puis les six questions avec « tient » /
« constat » / « NON TRANCHÉ ». Terminer par UNE ligne : « rien de neuf », « des
constats », ou « la forme est en cause ».
