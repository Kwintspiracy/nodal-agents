# Demande de review — dette de la PR #75, passe 2

Passe 1 : quatre constats. Les trois premiers tiennent, vérifiés à la source,
corrigés ici. Le quatrième est le résidu assumé de #60 : il est devenu
**l'issue #102**, et il est hors périmètre de cette passe.

- **1** — `expandWorkspaceRoots` était le dernier des quatre calculs de clé à ne
  connaître que `hasMarker` : une racine déclarée sans manifeste ni enfant y
  devenait une intention vide. Prédicat partagé passé, test, mutation.
- **2** — le registre déclarait `app/src` alors que l'intention nommait `app`,
  puis rattachait le job au sous-dossier. Même prédicat, cas `(k)`, mutation.
- **3** — l'empreinte d'une écriture constatée était `{ size, mtimeNs }`. Elle
  porte maintenant le sha256 du CONTENU : `mtimeNs` porte des nanosecondes mais
  ne les mesure pas, et une réécriture de même taille passait pour rien.

Cette passe relit `b82ccfa8`, `f4c361b9` et `96bb483b`.

Sandbox lecture seule. Deux verdicts : **le constat tient** ou **le constat est
faux**.

## Questions, par priorité

### P0

1. Les trois correctifs existent-ils ? Cite les lignes.
2. **Reste-t-il un CINQUIÈME calcul de clé de projet** quelque part — `tools`,
   `runner`, `web` — qui ne connaisse pas les projets déclarés ? C'est la
   question qui a rendu un constat à chacune des deux dernières passes.
3. L'empreinte par le contenu ouvre-t-elle un trou neuf ? Fichier illisible
   entre les deux lectures, fichier remplacé par un dossier, lien symbolique,
   fichier énorme, erreur de lecture avalée par le `catch`.
4. Le prédicat dans `attach.ts` change-t-il le sort d'un cas que la passe 32 de
   la revue de la PR #46 avait tranché — une racine déclarée qui n'aurait plus
   dû l'être, un rollback qui ne part plus ?

### P1

5. Reste-t-il un commentaire qui énonce ce que le code ne fait pas ?

### P2

6. Si tu ne trouves **rien de neuf**, dis-le à la dernière ligne.

## Hors périmètre

L'issue #102 (cible dossier déclarative) ; les cinq autres PR de la dette ;
`apps/qa` ; `apps/web/tests/e2e` ; le style.

## Forme du rapport

Les constats d'abord (fichier:ligne, déclenchement, gravité, ET le SENS de
l'erreur : faux vert ou faux rouge), puis les six questions avec « tient » /
« constat » / « NON TRANCHÉ ». Terminer par UNE ligne : « rien de neuf », « des
constats », ou « la forme est en cause ».
