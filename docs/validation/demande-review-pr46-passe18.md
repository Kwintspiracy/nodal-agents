# Demande de review — PR #46, passe 18 (P2 : réponse à la passe 17)

Périmètre : **le commit qui suit `5a58a8a8`** (apps/web : `conversation-feed.ts`
et son test, `ConversationFeedView.tsx`, `HistoryGroup.tsx`). P1 est clos.

## Ce que la passe 17 a trouvé, et ce qui en a été fait

| Constat passe 17 | Vérifié | Ce qui a changé |
|---|---|---|
| **P0** — `thread-history.ts` préfixe les échanges précédents d'une conversation en messages `user`/`assistant`/`tool` ordinaires (ids `history-tool-N`, résultat `messageId: 'history'`) ; le fil prenait le premier `user` pour la demande et les suivants pour des rappels | Vrai (`thread-history.ts:306-340`, `execute.ts:1775-1788`) | **Frontière** : la demande de CE job est le DERNIER message `user` dont le texte est exactement `job.task` (le job frais commence par `{ role: 'user', content: job.task }` ; l'historique peut contenir la même phrase plus ancienne ; les `user` qui suivent sont des `[système]`). Tout ce qui précède devient un item `history` (échanges `user`/`agent` en texte, replié dans l'écran : « Earlier in this conversation · N messages »). Tours, appels et totaux ne comptent que ce job. Test : historique avec une demande identique + `history-tool-1` → `['history', 'request', 'turn', 'turn', 'answer']`, zéro `note`, 2 tours. |
| **P1** — le k-ième message `assistant` ≠ `llm_calls.turn = k` : le runner avance `turn` avant chaque tentative, une tentative rejetée n'ajoute qu'un `[système]` | Vrai (`execute.ts:821, 2500, 2591-2617, 2870`) | Le tour d'un message vient de la **ligne d'audit** d'un de ses appels (`tool_calls.turn`, `turnSource: 'audit'`) ; un message sans appel (texte final) prend `tour précédent + 1` et le dit (`turnSource: 'inferred'`, l'écran préfixe « ≈ » aux jetons). `index` reste le rang d'affichage. Test : tours runner 1, 2 (rejeté), 3, 4 → messages `[1,1,audit,m1]`, `[2,3,audit,m3]`, `[3,4,inferred,m4]`. |
| `return_result` / `assign_*` sans ligne d'audit | Tient | Inchangé |
| `LiveRefresh` relit tout toutes les 3 s | Tient, dette pour P4 | Inchangé, noté dans le plan |
| Copie anglaise | Tient | Inchangé |

## Ce dont je doute moi-même

### La frontière repose sur l'égalité stricte `content === job.task`

Si le runner réécrit la tâche avant de la poser en premier message (typo,
rabattage, `original_task`), ou si `truncate()` de l'historique produit un
texte identique à la tâche courante ET que le job frais n'a pas son propre
message (impossible d'après `execute.ts:1755`, mais à confirmer), la frontière
tombe à 0 et tout redevient « ce job » — l'ancien comportement, pas pire. Y
a-t-il un chemin où le premier message du job frais n'est PAS `job.task` tel
quel ? (`originalTask` existe en colonne ; chercher qui l'écrit.)

### Le tour déduit (`inferred`)

Un message texte seul après une tentative rejetée prendrait `tour précédent + 1`
alors que le runner a compté deux tours : les jetons affichés seraient ceux de
la tentative rejetée. L'écran le dit (« ≈ »). Faut-il plutôt n'afficher AUCUN
jeton pour un tour déduit ?

## Ce qui n'est PAS attendu

« Ça a l'air bien ». Deux verdicts : tient / faux. Un constat non exécuté est
marqué NON EXÉCUTÉ.
