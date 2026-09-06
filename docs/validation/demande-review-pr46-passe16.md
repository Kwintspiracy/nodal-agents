# Demande de review — PR #46, passe 16 (P1 : réponse à la passe 15)

Périmètre : **HEAD, le commit qui suit `0344b711`** (les fichiers
`apps/web/**/spaces/**` et `conversation-feed*` du même commit ou des
commits voisins sont P2 et HORS périmètre de cette passe).

## Ce que la passe 15 a trouvé, et ce qui en a été fait

| Constat passe 15 | Vérifié | Ce qui a changé |
|---|---|---|
| `table.clipped` ignorait les intitulés de colonnes coupés à `CARD_CELL_MAX` | Vrai (`presenters.ts`, `tableCard`) | `clipped` part de `columns.some(c => c.length > CARD_CELL_MAX)` puis intègre les cellules. Test : une colonne de 201 caractères, sans ligne → `clipped: true` et intitulé à 200 ; rien de coupé → `false` ; une cellule coupée → `true`. |
| `card` déclaré brut dans l'audit | Tient | Inchangé |
| `text` + `failure: true` plutôt qu'une carte `failure` | Tient | Inchangé |
| `header: 'unknown'` pour `xlsx_read` | Tient | Inchangé |

## Ce dont je doute moi-même

Rien de neuf sur P1. Si cette passe ne trouve rien de neuf, P1 est clos ; la
suite est P2 (le rendu), qui aura sa propre demande.

## Ce qui n'est PAS attendu

« Ça a l'air bien ». Deux verdicts : tient / faux. Un constat non exécuté est
marqué NON EXÉCUTÉ.
