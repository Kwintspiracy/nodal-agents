## Relecture PR #46 — passe 48

### P0

1. Le maître d’une fusion

DÉDUIT sans exécuter de scénario : aucun constat neuf.

Dans ExcelJS 4.4.0 :

- `Cell.isMerged` combine `_mergeCount > 0` et le type `Merge` dans `node_modules/.pnpm/exceljs@4.4.0/node_modules/exceljs/lib/doc/cell.js:165`.
- `Cell.master` ne délègue que lorsque le type vaut `Merge`, à `cell.js:190`.
- `Worksheet._mergeCellsInternal()` choisit la cellule en haut à gauche comme maître, puis appelle `merge(master)` uniquement sur les autres cellules, à `worksheet.js:621-626`.
- `merge(master)` remplace la valeur de la cellule couverte par un `MergeValue`, à `cell.js:169`. Il n’est jamais appliqué au maître.

Le maître conserve donc son type d’origine. Avec `{ formula: 'SUM(B1:B2)', result: 3 }` en `A1`, puis une fusion `A1:C2`, `A1.type` demeure `Formula`. Il passe bien par la branche `Formula` de `packages/tools/src/builtin/office-ops/xlsx.ts:245`; seules les cinq cellules couvertes passent par la nouvelle branche `Merge` à `xlsx.ts:244`.

2. Maître hors des plafonds de l’aperçu

DÉDUIT sans exécuter : aucun constat neuf. Le scénario proposé est impossible avec une fusion rectangulaire ExcelJS.

Le maître est nécessairement la cellule en haut à gauche de la plage (`worksheet.js:621`). Toutes les cellules couvertes ont donc un numéro de ligne supérieur ou égal et un numéro de colonne supérieur ou égal à ceux du maître.

Scénarios concrets :

- Si le maître est en `U1`, hors des 20 colonnes affichées, toutes les cellules couvertes sont également en colonne `U` ou plus loin. Aucune cellule de la fusion n’apparaît dans les colonnes `A:T`.
- Si le maître se trouve après les 50 lignes retenues, toutes les cellules couvertes se trouvent sur cette ligne ou plus bas. Elles ne peuvent pas apparaître seules dans les 50 lignes précédentes.

L’aperçu peut entièrement omettre une fusion située hors plafond, comme toute autre donnée hors plafond, mais il ne peut pas montrer ses cellules couvertes sans montrer son maître.

### P1

3. Relecture depuis le disque par un autre outil

DÉDUIT sans exécuter un second outil : aucun constat neuf.

Le parseur XLSX lit les éléments `<mergeCell ref="…">` dans `merge-cell-xform.js:13`. Les plages sont placées dans le modèle de feuille à `worksheet-xform.js:418`, puis `Worksheet._parseMergeCells()` appelle `mergeCellsWithoutStyle()` pour chacune d’elles à `worksheet.js:895-899`.

Cette reconstruction passe par la même logique que la fusion en mémoire : le maître reste inchangé et chaque autre cellule reçoit un `MergeValue`.

Scénario concret : après sauvegarde d’une fusion `A1:C2`, un autre `xlsx_set_cell` recharge le fichier. Le chargement recrée `B1`, `C1`, `A2`, `B2` et `C2` avec le type `Merge`; `previewCellValue()` rend donc `null` pour ces cellules. Un fichier produit par Excel suit le même chemin puisqu’il utilise la même balise OOXML `<mergeCell ref="A1:C2">`.

Le test ajouté à `packages/tools/src/tests/xlsx-preview.test.ts:303-324` couvre déjà une relecture depuis le disque : le classeur fusionné est écrit, puis chargé par `xlsx_set_cell`. Il ne couvre toutefois pas une seconde exécution après la sauvegarde de cet outil, ce qui n’introduit pas de chemin de parsing différent.

4. `xlsx_merge_cells` et `xlsx_unmerge_cells`

DÉDUIT sans exécuter : aucun constat neuf.

`xlsx_merge_cells` appelle `ws.mergeCells()` à `packages/tools/src/builtin/office-ops/xlsx.ts:1294`, sauvegarde, puis construit l’aperçu depuis la même feuille à `xlsx.ts:1305`. ExcelJS remplace immédiatement chaque cellule couverte par un `MergeValue` (`worksheet.js:621-626`) : la nouvelle branche les rend donc vides.

Les anciennes valeurs des cellules couvertes ne survivent pas. `Cell.merge()` libère leur valeur précédente avant d’installer le `MergeValue`, à `cell.js:169-175`.

Scénario concret : avant `mergeCells('A1:C1')`, `A1`, `B1` et `C1` contiennent respectivement `Titre`, `ancien B` et `ancien C`. Après la fusion, l’aperçu donne `['Titre', null, null]`; les deux anciennes valeurs ont été supprimées, conformément au comportement documenté de l’outil.

`xlsx_unmerge_cells` appelle `ws.unMergeCells()` à `xlsx.ts:1350`. ExcelJS remet les anciennes cellules couvertes à `Null` à `cell.js:177-183`, puis l’aperçu est construit à `xlsx.ts:1361`.

Scénario concret : après dé-fusion de `A1:C1`, `A1` conserve `Titre`, tandis que `B1` et `C1` redeviennent des cellules vides. Elles ne restent pas accidentellement de type `Merge`.

## EXÉCUTÉ

- Lecture de la demande de passe 48 et des rapports des passes 46 et 47.
- Inspection de `git show e9393c54`.
- Inspection de `xlsx.ts`, du nouveau test et du code source ExcelJS 4.4.0 installé.
- Vérification de l’état Git : seul `docs/validation/demande-review-pr46-passe48.md` est non suivi.
- Tentative d’exécution du test ciblé Vitest et d’une expérience ExcelJS en mémoire.

Ces deux exécutions ont été refusées avant démarrage par la politique de l’environnement. Aucun résultat dynamique n’est donc revendiqué.

## Constats bloquants

Aucun constat neuf.