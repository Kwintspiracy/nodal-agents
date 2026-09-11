# Demande de review — PR #51, 5e passe (HEAD `a2d6b60f`)

Sandbox lecture seule. Deux verdicts : **le constat tient** (fichier, ligne,
ce qui casse, comment le déclencher) ou **le constat est faux**.

Cette passe relit UNIQUEMENT `daf9421c` et `a2d6b60f`, qui répondent aux trois
constats de la 4e passe (`docs/validation/rapport-review-pr51-passe4.md`).

## Ce que ces deux commits affirment

1. `apps/qa/lib.mjs` `titresDeTest` : un bloc `/* … */` n'est retiré que s'il
   COMMENCE une ligne (`^[ \t]*/\*`), pour qu'un glob dans une chaîne n'ouvre
   pas un commentaire.
2. `apps/qa/lib.mjs` `fusionnerEtats(ouverts, fermes)` : `null` si l'une des
   deux listes est `null`, sinon une seule entrée par `number`, le fermé
   écrasant l'ouvert. `collect.mjs` `chantiers` l'utilise pour issues et PR.
3. La limite des clés `#n` est documentée au-dessus de `fusionnerEssais`.

## Questions

1. `titresDeTest` : avec le retrait limité aux blocs en tête de ligne, un test
   commenté de cette forme est-il encore lu comme vivant ?
   ```
   it('x', () => { /* … */ });  /* it('mort @cap:x', () => {}) */
   ```
   (bloc en fin de ligne — est-ce un cas réel dans le dépôt ?
   `grep -rn "[^ ]\s*/\*.*it('" --include='*.test.*'`)
2. `titresDeTest` : un bloc en tête de ligne dont le `*/` manque (fichier
   tronqué, ou `/*` dans une chaîne multi-ligne qui commence une ligne, par
   exemple un template literal contenant du shell) avale-t-il la fin du
   fichier ? Y a-t-il un tel cas parmi les fichiers de test SUIVIS ?
3. `fusionnerEtats` : `number` est-il toujours présent et unique dans ce que
   `gh issue list --json number` et `gh pr list --json number` rendent ? Une
   PR et une issue partagent la numérotation GitHub — sont-elles bien fusionnées
   SÉPARÉMENT (une par famille) et jamais ensemble ?

## Hors périmètre

Tout ce qui n'est pas dans ces deux commits.

## Forme du rapport

Constats (fichier:ligne, déclenchement, gravité), puis les trois questions
avec « tient » / « constat » / « NON TRANCHÉ ». Terminer par UNE ligne :
« rien de neuf » ou « des constats ».
