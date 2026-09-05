# Demande de review — PR #46, passe 14 (P1 élargi : la carte ET sa charge utile)

Périmètre : **HEAD, le commit qui suit `75cbc755`**. Toujours P1 du plan « De
la maquette au produit », mais la pierre a changé de taille : la passe 13 a
montré qu'une étiquette sans forme oblige quand même l'écran à dispatcher par
nom (`xlsx_read` rend `{ sheets }`, `query_memory` un tableau nu, même carte
`table`). Ce commit y répond en entier plutôt que de redescendre `xlsx_read` en
`text`.

## Ce que le commit affirme

1. **Une forme par carte** — `packages/shared/src/tool-cards.ts` : un schéma zod
   par carte (`text`, `read`, `search`, `files`, `table`, `terminal`, `sent`,
   `checks`, `delegation`, `question`, `generic`), union discriminée
   `ToolCardPayloadSchema`, plafonds (`CARD_ROWS_MAX` 50, `CARD_ITEMS_MAX` 50,
   `CARD_TEXT_MAX` 4000, `CARD_EXCERPT_MAX` 2000, `CARD_CELL_MAX` 200).
   `CARDS_NEEDING_PRESENTER` = toutes sauf `text`, `generic`, `question`.
2. **Un présentateur par outil à carte structurée** — `ToolDefinition.present?()`
   (méthode, pour rester bivariante), posé sur 46 outils. Les briques
   (`readCard`, `searchCard`, `filesCard`, `writtenFile`, `tableCard`,
   `recordsTable`, `terminalCard`, `sentCard`, `checksCard`, `delegationCard`,
   `failureText`, `detailOf`) sont dans `packages/tools/src/presenters.ts` et
   appliquent les plafonds. `assign_<agent>` (orchestration) en a un aussi.
3. **Refus au démarrage** — `assertToolCard` lève sur une carte inventée ET sur
   une carte structurée sans `present()` ; `registry.register()` l'appelle.
4. **Validation à la présentation** — `presentToolResult(tool, input, output)`
   valide la charge contre le schéma de l'union ; une charge d'une AUTRE carte
   que la déclarée est refusée, SAUF `text` (un échec `{ ok: false, reason }`
   se présente en `text` sous la carte déclarée — `failureText`).
5. **Persistance** — `tool_calls.card` et `tool_calls.presented` (migration
   `0092_tool_calls_card.sql`, journal idx 92, schéma drizzle, schéma inline de
   test `packages/db/src/tests/helpers.ts`). `executeTool` écrit la carte
   déclarée sur TOUTE ligne d'audit, et la charge utile seulement sur une
   exécution réussie ; un présentateur qui viole son contrat est loggé
   `console.error` et la ligne garde `card` + `presented = NULL` — l'outil ne
   échoue pas.
6. **L'enregistreur vivant du CLI** (`live-events.ts`) pose `card` d'après le
   nom d'outil du CLI (`Read → read`, `Bash → terminal`, `apply_patch → files`…,
   inconnu → `generic`), `presented` reste `NULL`.

Mesuré, pas déduit : `tools` 5 fichiers ciblés 167 verts puis suite complète
(voir sortie CI), `shared` 4, `orchestration` assign 10, `tsc` propre sur
shared/tools/db/orchestration/adapters-mcp. Trois mutations : `present` retiré
de `run_command` → le registre refuse au démarrage en nommant l'outil ;
`xlsx_read` décale ses lignes (`rows.slice(1)`) → rouge ; `executeTool`
n'écrit plus `presented` → 2 rouges.

## Ce dont je doute moi-même — à attaquer en priorité

### P0 — le présentateur qui échoue est LOGGÉ, pas levé

`_writeToolCall` attrape `ToolPresentationError`, écrit `console.error`, et la
ligne garde `card` + `presented = NULL`. Argument : un bug de présentation ne
doit pas faire échouer le travail de l'agent, et l'écran dit « brut » sur une
charge nulle. Contre-argument (invariant #4) : c'est un repli, et un log n'est
pas une alerte. Est-ce acceptable parce que la garde (`cards.test.ts` +
présentateurs testés sur vraies sorties) attrape le bug AVANT la livraison ? Ou
faut-il une trace plus dure (une colonne `presentation_error`, une ligne
`llm_calls`-like) ?

### P1 — `text` sous une carte déclarée : l'échec, et rien d'autre ?

`presentToolResult` accepte une charge `text` pour n'importe quelle carte
déclarée. Prévu pour `failureText`. Mais rien n'empêche un présentateur de
rendre `text` sur un SUCCÈS — et l'écran ne saurait pas distinguer « échec dit
en texte » de « présentateur paresseux ». Faut-il un champ `ok: false` sur la
charge `text`, ou une carte `failure` à part ?

### P1 — `xlsx_read` : `columns: []`

Le présentateur ne suppose PAS que la première ligne est un en-tête
(`columns: []`, les lignes telles quelles). C'est honnête, mais la maquette
montre un tableau AVEC en-têtes. La décision appartient-elle à P8 (le tableur
rendu), ou faut-il un indice dès la charge utile (`headerRow?: boolean`) ?

### P1 — les plafonds tronquent sans dire OÙ

`clip()` coupe et pose « … » ; `tail()` garde la fin. Les charges portent
`truncated`/`total` pour les listes, mais un `excerpt` coupé ne dit pas combien
il manque (on a `chars` pour `read`, rien pour `text`). Suffisant pour P2 ?

### P2 — les noms du CLI en dur dans `live-events.ts`

`CLI_TOOL_CARDS` mappe `Read/Edit/Bash/…` (Claude Code) et
`shell/apply_patch/…` (Codex). C'est la connaissance du flux JSON de ces CLI,
au même endroit que son analyseur. Est-ce une violation de « jamais de dispatch
par nom », ou la bonne exception (la source connaît ses noms) ? Vérifier que
les noms sont ceux que `providers.ts` / `parseLiveToolEvent` voient passer.

### P2 — la table de test épingle 72 lignes

`EXPECTED_CARDS` dans `cards.test.ts` : un nouvel outil oblige à écrire sa
ligne. Voulu. Mais est-ce que la présence du présentateur est vérifiée pour
CHAQUE carte structurée, ou seulement « au moins une » ? (Réponse attendue :
chaque — le test « CHAQUE outil à carte structurée dit comment sa sortie la
remplit » filtre sur `CARDS_NEEDING_PRESENTER`.) Confirmer en lisant le test,
pas la demande.

## Hors périmètre

Le rendu (P2). Les adaptateurs de connecteurs (`generic`). L'écran des Logs,
qui lit `tool_calls` par colonnes nommées et ne voit pas les nouvelles.

## Ce qui n'est PAS attendu

« Ça a l'air bien ». Deux verdicts : tient / faux. Un constat non exécuté est
marqué NON EXÉCUTÉ.
