# Demande de review — PR #46, passe 19 (P2 : réponse à la passe 18)

Périmètre : **le commit qui suit `1f0c4220`** (apps/web : `conversation-feed.ts`,
`ConversationFeedView.tsx`, `getSpaceConversationAction`, deux tests).

## Ce que la passe 18 a trouvé, et ce qui en a été fait

| Constat passe 18                                                                                                                                                                                    | Vérifié                            | Ce qui a changé                                                                                                                                                                                                                                                                                                            |
| --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ---------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| **P1** — la frontière comparait `content === job.task` après que les messages ont passé `redactTranscriptForDisplay`, la tâche restant brute : une demande contenant un secret perdait sa frontière | Vrai (`actions.ts:2328` vs `2334`) | La tâche passe par la **même** rédaction (`redactTranscriptForDisplay([{ role: 'user', content: job.task }])`) avant d'être comparée ET affichée (fil et en-tête). Test pglite : tâche avec `sk-ant-…` + historique → `['history', 'request', 'turn', 'answer']`, texte de la demande masqué, en-tête masqué, zéro `note`. |
| **P1** — un tour `inferred` (`lastTurn + 1`) recevait les métriques de ce numéro, qui peut être celui d'une tentative rejetée ; le « ≈ » ne rendait pas l'attribution juste                         | Vrai                               | Un tour déduit n'a **ni modèle ni jetons** (`usage: null`, `model: null`). Le « ≈ » disparaît. Les totaux du job restent complets. Test : `[3, 4, 'inferred', null, undefined]`.                                                                                                                                           |

## Ce dont je doute moi-même

Rien de neuf sur P2 au-delà des dettes déjà notées (relecture toutes les 3 s →
P4 ; `return_result`/`assign_*` sans ligne d'audit → « no card recorded »).
Si cette passe ne trouve rien de neuf, P2 est clos et la suite est P3 (cartes
de preuve depuis `verification_runs`, envois depuis `job_deliveries`) et P4
(barre d'état, coût) dans la même page.

## Ce qui n'est PAS attendu

« Ça a l'air bien ». Deux verdicts : tient / faux. Dis explicitement si tu ne
trouves rien de neuf. Un constat non exécuté est marqué NON EXÉCUTÉ.
