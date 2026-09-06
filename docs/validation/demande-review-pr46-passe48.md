# Demande de review — PR #46, passe 48 (P12 : correctif de la passe 47)

Périmètre : **un commit**, le dernier de la branche (`git log -1`, titre « fix(p12): passe Codex 47 —
une cellule couverte par une fusion reste vide dans l'aperçu »), 2 fichiers. Il traite le seul
constat neuf de la passe 47 (`docs/validation/rapport-review-pr46-passe47.md`). Les correctifs de
la passe 46 (`f790a051`) sont inchangés. L'arbre de travail est propre.

## Ce que le commit affirme

- `previewCellValue(cell)` (`packages/tools/src/builtin/office-ops/xlsx.ts`) rend `null` pour une
  cellule dont `cell.type === ExcelJS.ValueType.Merge` — une cellule COUVERTE par une fusion, pas
  le maître, qui garde son propre type et sa valeur. « Q1 » fusionné sur A1:C2 paraît une fois, en
  A1 ; B1, C1, A2, B2, C2 sont vides.
- Test `xlsx-preview.test.ts` : classeur avec la fusion, écriture en D1 par `xlsx_set_cell`, la
  charge relue montre `['Q1', null, null, 'x']`, `[null, null, null]`, `['sous']`, et « Q1 » UNE
  fois dans le JSON. Mutation rouge : la branche retirée.

## Questions, par priorité

### P0

1. **Le maître d'une fusion** : `cell.type` du maître est celui de sa valeur (String, Number,
   Formula…), jamais `Merge` — confirmer sur `lib/doc/cell.js` (`isMerged` = `_mergeCount > 0 ||
   type === Merge` ; `master` ne délègue que si `type === Merge`). Un maître dont la valeur est une
   formule passe-t-il toujours par la branche `Formula` ?
2. **Une fusion dont le maître est HORS des 20 premières colonnes ou des 50 premières lignes** :
   les cellules couvertes visibles rendent `null` et le maître n'est pas montré — l'aperçu montre
   du vide là où le tableur montre une valeur. Dégradation acceptée (le plafond est dit par
   « showing 20 of N columns ») ou constat ?

### P1

3. **Après `saveWorkbook` puis relecture par un AUTRE outil** (le classeur est rechargé depuis le
   disque) : exceljs recrée-t-il les `MergeValue` à la lecture des `<mergeCell ref>` ? Le test le
   prouve pour un classeur écrit par exceljs ; un classeur écrit par Excel porte la même balise.
4. **`xlsx_merge_cells` / `xlsx_unmerge_cells`** (deux des 14 outils) : leur aperçu, pris juste
   après la fusion en mémoire, reflète-t-il la fusion (cellules couvertes vides) ? Un chemin où
   `mergeCells` laisse les esclaves avec leur ancienne valeur ?

## Ce qui n'est PAS attendu

Le style, le nommage. Un constat désigne un fichier, une ligne, et ce qui casse. Un constat déjà
traité n'est pas à redire — une passe sans constat NEUF clôt P12 et le lot 3.
