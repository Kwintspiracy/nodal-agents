# Demande de review — PR #46, passe 21 (P3 : réponse à la passe 20)

Périmètre : **le commit P3 qui suit `520a30a6`** (apps/web :
`getSpaceConversationAction`, `spaces/[id]/page.tsx`, `DeliveriesCard.tsx`, le
test de l'action). La passe 20 a relu ce même contenu à l'état indexé ; ce
commit y ajoute sa réponse.

## Ce que la passe 20 a trouvé, et ce qui en a été fait

| Constat passe 20                                                                                                            | Vérifié                                                                                   | Ce qui a changé                                                                                                                                                                                                                                                                                                 |
| --------------------------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Les preuves ne remontaient que des **enfants directs** ; le détail Code parcourt les descendants jusqu'à `ROLLUP_MAX_DEPTH` | Vrai (`relevantIds = [id, ...childRows]` contre la BFS de `getCodingProcessDetailAction`) | Même BFS, niveau par niveau, bornée à l'entité et à `ROLLUP_MAX_DEPTH` ; `relevantIds` = le job + TOUS ses descendants ; la trace D8 se fusionne depuis les descendants. Test pglite : un petit-enfant avec une preuve verte → deux séquences remontent à la racine (rouge de l'enfant, verte du petit-enfant). |
| `stage={job.status}`                                                                                                        | Tient                                                                                     | Inchangé                                                                                                                                                                                                                                                                                                        |
| Preuve visible sur l'enfant ET la racine                                                                                    | Tient (T24)                                                                               | Inchangé                                                                                                                                                                                                                                                                                                        |
| Envois sous le fil, à part des cartes `sent`                                                                                | Tient                                                                                     | Inchangé                                                                                                                                                                                                                                                                                                        |

## Ce dont je doute moi-même

Rien de neuf sur P3. Si cette passe ne trouve rien de neuf, P3 est clos. P4
(barre d'état et coût) a une dépendance à nommer : la garde du plan (« cache
lu au dixième, cache écrit 1,25× ») suppose un estimateur de coût cache-aware,
or `estimateModelCostUsd` (`packages/shared/src/model-catalog.ts`) ignore
`cachedTokens` / `cacheCreationTokens`. Ce n'est pas dans cette passe.

## Ce qui n'est PAS attendu

« Ça a l'air bien ». Deux verdicts : tient / faux. Dis explicitement si tu ne
trouves rien de neuf. Un constat non exécuté est marqué NON EXÉCUTÉ.
