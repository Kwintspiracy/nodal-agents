# P0 — exactitude de ce qui est montré

## 1. Clé du livrable

### P0 — le statut disparaît sous une jonction ou un lien symbolique — déduit sans exécution

- Fichier : `packages/tools/src/builtin/office-ops/xlsx.ts:292`
- L’intention rebascule préalablement les chemins réels vers les racines lexicales dans `packages/tools/src/verification/intent.ts:237`, via `rebaseOntoLexicalRoots`.
- La présentation calcule au contraire `projectKey(p.abs_path)` directement sur le `realpath`.

Scénario concret : `D:\workspace` est une jonction vers `E:\data`. L’intention enregistre le document sous `projectKey("D:/workspace/report.xlsx")`, tandis que la carte demande `projectKey("E:/data/report.xlsx")`. La recherche de `ConversationFeedView.tsx:409` échoue.

Le comportement d’affichage reste sûr : `FilePreview` reçoit `undefined` et `ConversationFeedView.tsx:360-377` ne rend aucune ligne de vérification. Il n’affiche donc ni « Verified » ni un autre faux état.

`present()` devrait utiliser la même identité lexicale. Comme le présentateur n’a pas le contexte des workspaces, la clé devrait idéalement être calculée pendant `execute()`, à partir de `rebaseOntoLexicalRoots(..., ctx.workspaces.map(...))`, puis transportée dans la sortie.

## 2. Parcours des grandes feuilles

### P1 — chaque écriture reparcourt toutes les lignes utilisées — déduit sans exécution

- Fichier : `packages/tools/src/builtin/office-ops/xlsx.ts:258-266`
- Après les 50 premières lignes, la callback retourne immédiatement, mais `ws.eachRow` continue d’être appelée pour toutes les autres lignes afin d’incrémenter `total`.

Scénario concret : `xlsx_set_cell` modifie une cellule d’une feuille de 100 000 lignes. L’écriture et la sauvegarde sont suivies d’un parcours supplémentaire de 100 000 lignes, alors que seules 50 sont affichées.

Ce coût reste linéaire et probablement secondaire par rapport à la sérialisation du classeur, mais il s’applique à chacun des 14 outils. Il n’existe pas d’arrêt anticipé compatible avec un `total` exact via `eachRow`. Il faudrait soit accepter explicitement ce coût, soit changer le contrat pour autoriser un total borné/inconnu. Utiliser simplement `rowCount` risquerait de compter les lignes seulement formatées ou les trous différemment de `eachRow`.

## 3. `previewCellValue`

### P0 — le texte riche devient `[object Object]` — déduit sans exécution

- Fichier : `packages/tools/src/builtin/office-ops/xlsx.ts:245-251`
- Une valeur ExcelJS de texte riche a la forme `{ richText: [{ text: ... }] }`. Elle ne possède pas de propriété racine `text` et tombe donc dans `String(val)`.

Scénario concret : une cellule contenant deux segments riches « Total » et «  TTC » apparaît comme `[object Object]` dans l’aperçu, au lieu de `Total TTC`. Cela contredit aussi le contrat annoncé à `xlsx.ts:220-221`.

Comportement des autres valeurs :

- Hyperlien `{ text, hyperlink }` : rendu lisible via la branche `text`, avec le libellé uniquement.
- Date : rendue en jour ISO par `toISOString().slice(0, 10)`. Attention, c’est le jour UTC ; une date ExcelJS construite à minuit dans un fuseau positif peut apparaître au jour précédent.
- Formule normale fraîche : rendue comme `=FORMULE`.
- Formule normale avec cache : nombre et date correctement traités, erreur rendue par son code.
- `sharedFormula` : la propriété `formula` est absente. La branche générique `result` rend un résultat scalaire, mais un résultat erreur devient `[object Object]`, une date utilise la représentation locale de `Date`, et une formule sans résultat devient une cellule vide. Ces cas ne suivent donc pas le traitement des formules normales.

### P0 — le pied nie les formules que l’aperçu affiche — déduit sans exécution

- Fichiers : `packages/tools/src/builtin/office-ops/xlsx.ts:237` et `apps/web/src/app/(dashboard)/spaces/ConversationFeedView.tsx:372`
- Le code affiche volontairement une formule fraîche sous la forme `=SUM(...)`, mais le pied affirme systématiquement « values only: no formulas ».

Scénario concret : après l’écriture de `=SUM(A1:A2)`, la grille affiche cette formule tandis que la ligne immédiatement dessous affirme qu’aucune formule n’est montrée.

# P1

## 4. Générations et états provenant de plusieurs jobs

### P1 — le statut n’est pas corrélé à la génération de la carte — déduit sans exécution

- Fichiers : `apps/web/src/lib/verification-runs-view.ts:74-89` et `apps/web/src/lib/conversation-actions.ts:546-568`
- La requête ne charge ni `dirtyGeneration` ni `verifiedGeneration`. `deliverableStatuses` choisit seulement la ligne ayant le plus récent `updatedAt`, indépendamment de la génération montrée par la carte ou des générations portées par les autres jobs.

Le cas séquentiel simple fonctionne : une ancienne ligne `green`, puis une réécriture qui crée ou met à jour une ligne `dirty`, donne normalement `dirty`, car cette dernière est plus récente.

En revanche, scénario concret inter-jobs :

1. le job A commence à vérifier la génération 1 ;
2. le job B réécrit le même fichier et produit la génération 2, `dirty` ;
3. le job A termine ensuite et met sa propre ligne à `green`, avec un `updatedAt` plus récent.

`deliverableStatuses` sélectionne alors `green`, bien que la version courante soit la génération 2 non vérifiée. De plus, le même statut par clé est appliqué à toutes les cartes historiques du fil, sans lien avec le job ou la mutation qui a produit chaque aperçu.

La règle `dirty_generation === verified_generation` n’est donc pas vérifiée par cette vue. Le futur vérificateur devra fournir une autorité globale par clé ou la lecture devra agréger les générations, et pas seulement les timestamps.

## 5. Taille de la carte

`CARD_CELL_MAX` est bien appliqué par `tableEntry` à chaque cellule, et `clipped` est levé comme pour une carte `table`. `CARD_ROWS_MAX` borne également les lignes.

### P1 — le nombre de colonnes/cellules n’est pas borné — déduit sans exécution

- Fichier : `packages/shared/src/tool-cards.ts:87-94`
- `rows` est borné à 50, mais ni `columns` ni chaque tableau représentant une ligne ne possède de `.max(...)`.

Scénario concret : une feuille utilisant les 16 384 colonnes Excel produit jusqu’à 819 200 cellules dans `tool_calls.presented`, même si chacune est limitée à 200 caractères. Le schéma accepte cette charge et `row.eachCell({ includeEmpty: true })` la construit.

Ce défaut existe également pour les cartes `table`, mais P12 l’étend désormais à chaque écriture XLSX persistée. Une borne de colonnes ou un budget global de cellules est nécessaire pour garantir une carte réellement bornée.

## 6. Chat/travail et `showsAlone`

Aucune régression trouvée.

- `chat-or-work.ts` continue de classer toute carte `files` réussie avec `total > 0` comme travail. `preview` et `deliverableKey` sont ignorés.
- `apps/web/src/lib/conversation-feed.ts:274-286` continue de rendre seule une carte `files` dès que `total > 0`. La présence de l’aperçu ne change pas cette décision.

# P2

## 7. Texte du pied dans le web

Conforme à l’invariant indiqué. Les phrases sont définies dans `apps/web/src/app/(dashboard)/spaces/ConversationFeedView.tsx:349-355`, et non dans le runner.

Un statut absent ou inconnu ne produit aucune phrase, conformément au comportement sûr prévu.

# Hors demande

### P2 — égalité de timestamps non déterministe — déduit sans exécution

- Fichier : `apps/web/src/lib/verification-runs-view.ts:86-87`
- En cas de deux lignes pour la même clé ayant exactement le même `updatedAt`, `>=` fait gagner la dernière ligne reçue. La requête qui les fournit n’impose aucun ordre.

Scénario concret : deux jobs mettent respectivement le même fichier à `dirty` et `green` dans la même précision temporelle de la base. Selon l’ordre de retour SQL, le pied peut changer entre les deux statuts.

# Constats bloquants

- P0 — clé de livrable réelle au lieu de lexicale sous jonction/lien symbolique.
- P0 — texte riche affiché comme `[object Object]`.
- P0 — pied « no formulas » contradictoire avec l’affichage effectif des formules fraîches.
- P1 — statut inter-jobs non corrélé aux générations.
- P1 — aperçu sans borne de colonnes ou de nombre global de cellules.

Les tests ciblés n’ont pas pu être exécutés dans cette session, l’environnement ayant refusé le lancement de `pnpm`; tous les constats ci-dessus sont donc explicitement issus de l’inspection statique.