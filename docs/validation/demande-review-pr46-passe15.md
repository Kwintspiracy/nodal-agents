# Demande de review — PR #46, passe 15 (P1 : réponse à la passe 14)

Périmètre : **HEAD, le commit qui suit `0ecddd8b`**. P1 du plan « De la
maquette au produit », réponse aux six constats de la passe 14.

## Ce que la passe 14 a trouvé, et ce qui en a été fait

| Constat passe 14 | Vérifié | Ce qui a changé |
|---|---|---|
| **P0** — l'échec du présentateur n'était que loggé ; et si `cardForTool` levait, `card` restait NULL, contrairement à la demande | Vrai (`execute.ts:780-789`) | `tool_calls.presentation_error` (0092 amendée, schéma drizzle, SQL de test) : la ligne DIT l'erreur, `presented` NULL, l'outil ne rate pas. `card` = la valeur DÉCLARÉE telle quelle (`tool.card`, sinon `generic`), plus jamais recalculée dans le chemin d'audit. Test : présentateur cassé → `presentationError` matche `/ToolPresentationError/` et `/tables/` ; succès → NULL. |
| **P1** — `text` accepté sous toute carte, succès compris | Vrai (`cards.ts:129`) | `TextCardSchema.failure: z.literal(true).optional()` ; `failureText` le pose ; `presentToolResult` n'admet un `text` sous une autre carte QUE marqué `failure: true`. Test : `files` qui rend `{card:'text', text:'fait'}` sur `{ok:true}` → refusé, message nommant la règle. |
| **P1** — `xlsx_read` `columns: []` sans dire si la 1re ligne est un en-tête | Vrai | `table.header: 'columns' \| 'unknown'` dans la forme ; `tableCard` le déduit (`columns` non vide → `'columns'`), `recordsTable` le fixe, `xlsx_read` dit `'unknown'` explicitement. P8 lira le champ, ne devinera pas. Test xlsx : `header === 'unknown'`. |
| **P1** — troncatures muettes | Vrai (`readCard` recopiait `a.truncated`, `textCard` coupait sans le dire, cellules coupées sans métadonnée) | `readCard.truncated` inclut `text.length > CARD_EXCERPT_MAX` ; `text.truncated?` posé quand coupé ; `terminal.stdoutTruncated/stderrTruncated` requis ; `table.clipped` requis (une cellule au moins coupée). Le schéma REFUSE une table sans `header`/`clipped` et un terminal sans ses drapeaux. |
| **P2** — `CLI_TOOL_CARDS` nommait `shell`/`apply_patch`, que `codex --json` n'émet pas ; `command_execution` et `file_change` tombaient en `generic` | Vrai (`live-events.ts:53` n'admet que ces deux `item.type`) | Table corrigée : `command_execution → terminal`, `file_change → files` ; les faux noms retirés. Test : les DEUX noms passent par `parseLiveToolEvent` avant `cliToolCard` — le test traverse le parseur, il ne suppose pas les noms. `shell` → `generic`. |
| **P2** — exhaustivité de `EXPECTED_CARDS` | Tient (passe 14) | Inchangé |

Mesuré : `tsc` propre sur shared, tools, db, orchestration, web ; suites
ciblées vertes (voir CI pour la suite complète).

## Ce dont je doute moi-même

### `card` écrit tel que déclaré, sans validation dans le chemin d'audit

Avant, `cardForTool` validait (et levait) au moment d'écrire la ligne. Maintenant
la ligne reçoit `tool.card` brut. Pour un outil du registre c'est équivalent
(le registre a refusé toute carte inventée au démarrage). Pour un outil HORS
registre à carte inventée, la ligne portera cette carte inventée — l'écran la
verra hors vocabulaire et la traitera comme inconnue. Est-ce la bonne place
pour la vérité, ou faut-il refuser d'écrire ?

### `failure: true` est un champ, pas une carte

La passe 14 proposait une carte `failure` discriminée. J'ai gardé `text` +
`failure: true` : moins de surface (le vocabulaire des cartes reste celui que
les outils déclarent), et l'écran n'a qu'un test à faire. Le contre : la
charge d'un échec et celle d'un accusé ont le même `card`. Est-ce un problème
pour P2, qui dispatche d'abord sur `card` ?

### `header: 'unknown'` reporte la question, il ne la tranche pas

P8 devra soit demander à l'utilisateur, soit afficher les lignes sans en-tête.
La passe 14 demandait que la décision ENTRE dans la charge utile ; elle y est,
sous la forme « on ne sait pas ». Est-ce suffisant, ou faut-il que `xlsx_read`
regarde la première ligne (types hétérogènes vs homogènes) — ce qui serait une
devinette ?

## Hors périmètre

Le rendu (P2). Le module `conversation-feed.ts` (P2, apps/web) est dans un
commit à part et n'est PAS dans cette passe.

## Ce qui n'est PAS attendu

« Ça a l'air bien ». Deux verdicts : tient / faux. Un constat non exécuté est
marqué NON EXÉCUTÉ.
