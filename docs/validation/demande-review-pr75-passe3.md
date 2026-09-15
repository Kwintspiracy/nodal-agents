# Demande de review — dette de la PR #75, passe 3

Passe 2 : trois constats, tous fondés, tous corrigés.

- **1** — il restait DEUX calculs de clé, et ce sont les deux que des humains et
  des agents lisent : le contexte injecté aux agents (`apps/runner`) et l'écran
  Code (`apps/web`). Les six calculs partagent maintenant la même règle. Un test
  de chaque côté, mutation de chaque côté.
- **2** — un trou ouvert par MON correctif de la passe 1 : une lecture refusée
  tombait dans le même `catch` que « le fichier n'existe pas », donc un refus de
  lecture passait pour une écriture. L'empreinte a trois états ; l'illisible
  n'est pas crédité et se DIT.
- **3** — deux commentaires réécrits.

Cette passe relit `97f195a9`, `8b44782b` et le commit de commentaires.

Sandbox lecture seule. Deux verdicts : **le constat tient** ou **le constat est
faux**.

## Questions, par priorité

### P0

1. Les correctifs existent-ils ? Cite les lignes.
2. **Reste-t-il un SEPTIÈME calcul de clé de projet**, ou un endroit qui compare
   deux clés venues de deux calculs différents ? La question a rendu un constat
   à chacune des deux passes ; je veux savoir si elle est close.
3. Le troisième état de l'empreinte ouvre-t-il un trou à son tour ? Cas à
   sonder : illisible des deux côtés avec une taille qui ne bouge pas, taille
   lisible mais contenu illisible d'un seul côté, fichier absent puis illisible.
4. Le passage des racines déclarées dans `apps/web` change-t-il le sort d'un cas
   déjà tranché — un dossier masqué, un lien, deux racines qui s'emboîtent ?

### P1

5. Reste-t-il un commentaire qui énonce ce que le code ne fait pas ?

### P2

6. Si tu ne trouves **rien de neuf**, dis-le à la dernière ligne.

## Hors périmètre

L'issue #102 ; les cinq autres PR de la dette ; `apps/qa` ;
`apps/web/tests/e2e` ; le style.

## Forme du rapport

Les constats d'abord (fichier:ligne, déclenchement, gravité, ET le SENS de
l'erreur : faux vert ou faux rouge), puis les six questions avec « tient » /
« constat » / « NON TRANCHÉ ». Terminer par UNE ligne : « rien de neuf », « des
constats », ou « la forme est en cause ».
