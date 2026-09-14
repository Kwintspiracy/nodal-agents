# Demande de review — PR #87 « main est rouge : l'attente d'un test de #75 datait d'avant #66 », post-merge

Commit `cfdf6631`, mergé le 13/09 **sans passe Codex** (dette de revue,
issue #88). Il est dans `main`. Diff minuscule : 4 lignes de
`packages/tools/src/tests/intent.test.ts`.

Sandbox lecture seule. Deux verdicts valent : **le constat tient** ou **le
constat est faux**.

Lire `git show cfdf6631`, puis `packages/tools/src/tests/intent.test.ts`
autour du test modifié, `packages/tools/src/verification/written-file-type.ts`
et `packages/tools/src/verification/observed.ts`.

## Ce que la PR affirme

1. Le test « une écriture RÉELLE est constatée, et produit » attendait
   `code_project` et obtenait `document` : l'attente datait d'avant #66.
2. `document` est le comportement VOULU — un fichier hors de toute racine à
   manifeste et hors de tout projet déclaré est un document.
3. Ce que #75 prouve (`produced = true`) ne dépend pas du type du livrable.
4. Le test voisin, qui pose un `package.json`, reste `code_project`.

## Questions, par priorité

### P0 — une attente changée est-elle une preuve perdue ?

1. **Le risque de forme.** Changer l'ATTENTE d'un test rouge est le geste qui
   masque un vrai bug. Vérifier à la source, dans
   `written-file-type.ts`, que `notes/journal.md` dans un workspace sans
   manifeste et sans projet déclaré DOIT bien rendre `document` — et non que
   le typage de #66 a un trou que ce test signalait.
2. **La preuve de #75 est-elle intacte ?** Après le changement, le test
   assert-il encore `produced === true` ET le fait que l'écriture a été
   CONSTATÉE (pas seulement déclarée) ? Autrement dit : ce test rougirait-il
   encore si l'on retirait l'observation du seam (`observed.ts`) ? Si non, la
   « correction » a neutralisé la preuve.
3. **Le test voisin.** Celui qui pose un `package.json` et attend
   `code_project` : couvre-t-il bien le chemin `code_project` de
   l'observation (`observedDeliverableKeys` branche `code_project` via
   `resolveProjectRoots`), là où le test modifié couvre désormais la branche
   `officeFileDeliverables` ? Les deux branches sont-elles encore prouvées ?

### P1 — la CI

4. Pourquoi la CI n'a-t-elle pas rougi AVANT le merge de #75 ou de #66 ?
   Les deux PR étaient ouvertes en même temps ; la porte teste-t-elle la
   branche seule, ou la fusion avec `main` ? Si c'est la branche seule, le
   même incident se reproduira — y a-t-il une garde possible ?
5. `pnpm test` sur `packages/tools` passe-t-il aujourd'hui ? Reste-t-il, dans
   `intent.test.ts` ou ailleurs, une autre attente périmée par #66 (un test
   qui attend `code_project` pour un fichier hors manifeste) ?

## Hors périmètre

Le typage lui-même (relu avec #66) ; l'observation (relue avec #75).

## Ce dont je doute moi-même

Q2 : que la preuve de #75 survive intacte au changement d'attente.

## Forme du rapport

Les constats d'abord (fichier:ligne, déclenchement, gravité), puis les cinq
questions avec « tient » / « constat » / « NON TRANCHÉ ». Terminer par UNE
ligne : « rien de neuf » ou « des constats ».
