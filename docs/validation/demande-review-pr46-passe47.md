# Demande de review — PR #46, passe 47 (P12 : correctifs de la passe 46)

Périmètre : **un commit**, `f790a051` (15 fichiers), qui traite les cinq constats de la passe 46
(`docs/validation/rapport-review-pr46-passe46.md`). Chaque constat a été vérifié à la source
avant correction ; chaque correctif est fermé par un test qui rougit sous mutation (7 mutations
rouges, listées dans le message de commit). L'arbre de travail est propre.

## Ce que le commit affirme

1. **Clé du livrable** (P0) — nouveau module `packages/tools/src/verification/office-file-key.ts`
   : `officeFileDeliverables` = `rebaseOntoLexicalRoots` puis `resolveFileDeliverables` ;
   `officeFileDeliverableKey(absPath, roots)` pour un fichier. L'intention (`intent.ts`, case
   `office_file`) ET `sheetPreview` (xlsx.ts) l'appellent. `XlsxSheetPreview` porte
   `deliverable_key: string | null` à la place d'`abs_path` ; `null` ⇒ carte sans clé + warn
   `XLSX_PREVIEW_KEY_UNRESOLVED`. Test : racine attachée par jonction/symlink, la clé de la
   carte `toEqual` la seule ligne `job_deliverable_verification_state` du job.
2. **`previewCellValue(cell)`** (P0) — lit `cell.type === Formula` → `cell.formula`
   (traduite pour une formule partagée) / `cell.result` ; `previewScalar` traite `richText`
   (jointure), `{ text, hyperlink }` (récursif, le texte peut être riche), `{ error }`, Date →
   jour ISO UTC, repli `JSON.stringify`. Test : classeur avec texte riche, hyperlien simple et
   riche, `fillFormula` avec et sans résultats, erreur en cache, erreur nue, date — chaque
   cellule lue, et `JSON.stringify(card)` ne contient pas `[object Object]`.
3. **Pied** (P0) — `'no formatting or merged cells; uncomputed formulas shown as written'`.
4. **Largeur** (P1) — `CARD_COLS_MAX = 20` : `.max()` sur `columns` et sur chaque ligne du
   `TableEntrySchema` ; `tableEntry` coupe et mesure `columnsTotal` sur TOUTES les lignes
   passées ; `sheetPreview` ne construit que 20 cellules par ligne (`row.findCell`, jamais
   `getCell` qui créerait la cellule) et passe `columns_total` = `max(row.cellCount)` ;
   l'écran dit « showing W of N columns » quand `columnsTotal > largeur montrée`, se tait
   sans `columnsTotal` (lignes antérieures).
5. **État par (job, clé)** (P1) — `DeliverableStatusView { jobId, canonicalKey, status }`,
   `deliverableStatusKey(jobId, key)` utilisé pour ranger ET retrouver ; la carte lit
   `deliverables.get(deliverableStatusKey(step.jobId, f.deliverableKey))`. Plus aucune
   comparaison de `updated_at` (la P2 « égalité de timestamps » disparaît avec). Les deux
   requêtes (`conversation-actions.ts`, `actions.ts`) chargent `jobId` et ne chargent plus
   `updatedAt`.
6. **Parcours complet de `eachRow`** (P1) — accepté et dit en commentaire : `total` exact,
   `rowCount` compterait les lignes formatées vides, coût linéaire du même ordre que la
   sauvegarde qui précède.

## Questions, par priorité

### P0

1. **Une seule clé, vraiment ?** L'intention rebase `targets` en tête de `resolveDeliverables`
   (ligne 237) puis le case `office_file` rebase à nouveau via `officeFileDeliverables`. Le
   rebasage est-il idempotent dans TOUS les cas de `rebaseOntoLexicalRoots` (deux racines qui
   se recouvrent, lien vers un conteneur + projet attaché à part) ? Un cas où le second passage
   changerait la clé serait un P0.
2. **`officeFileDeliverableKey` reçoit `ctx.workspaces[].path` BRUTS** ; l'intention passe des
   racines `normalizePath`-ées (`writeMutationIntent`). `rebaseOntoLexicalRoots` compare des
   chemins réels (`realPathOf`), mais la clé finale est `projectKey(root.lexical + reste)` :
   une racine configurée avec antislashs ou slash final donne-t-elle la même clé des deux côtés ?
3. **`row.findCell(col)` sur une ligne dont `_cells` est creux** (cellule jamais définie au
   milieu) rend `undefined` → `null` dans l'aperçu. Une cellule FUSIONNÉE (esclave d'une fusion)
   : `cell.type === Merge`, `cell.value` renvoie la valeur du maître — l'aperçu répète-t-il la
   valeur sur toute la plage fusionnée, et est-ce dit ?

### P1

4. **Formule partagée** : `cell.formula` appelle `_getTranslatedFormula` qui cherche le maître
   via `worksheet.findCell(sharedFormula)`. Après `saveWorkbook` (le classeur est encore en
   mémoire), le maître est-il toujours trouvable ? Un maître hors des 50 premières lignes ou
   au-delà de la 20e colonne n'a pas d'incidence (la traduction lit le maître, pas l'aperçu) —
   confirmer.
5. **Le résultat `0` d'une formule** : exceljs `_copyModel` ne copie que les valeurs truthy,
   mais `cell.result` lit `this.model.result` directement — un résultat `0` en cache se
   montre-t-il `0` (attendu) ou `=FORMULE` ?
6. **L'état par job dans une conversation continue (P6)** : chaque tour est un job ; la carte du
   tour N lit la ligne du job N. Un job qui écrit DEUX fois le même fichier a deux cartes sur
   une ligne (l'état de la dernière génération) — dit dans le commentaire de
   `verification-runs-view.ts`. Y a-t-il un chemin où `step.jobId` n'est PAS le job dont
   l'intention a écrit la ligne (enfant délégué ? tour CLI ?) — auquel cas la carte se tait, ce
   qui est le comportement voulu, mais à confirmer.
7. **Compatibilité des lignes ANCIENNES** : un `table` déjà persisté avec plus de 20 colonnes
   échoue désormais à `safeParse` côté écran (`presented: null` → nom + sortie brute). Accepté
   comme dégradation lisible ; contredire si l'écran fait autre chose que montrer la sortie brute.

### P2

8. Le nom `columnsTotal` à côté de `total` (lignes) : ambigu ? Pas un blocage, une remarque.

## Ce qui n'est PAS attendu

Le style, le nommage (hors question 8). Un constat désigne un fichier, une ligne, et ce qui
casse. Un constat déjà traité par ce commit n'est pas à redire — une passe qui ne trouve rien
de NEUF clôt P12.
