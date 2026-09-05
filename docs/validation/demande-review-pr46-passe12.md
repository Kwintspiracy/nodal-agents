# Demande de review — PR #46, passe 12 (P1 : réponse à la passe 11)

Périmètre : **HEAD, le commit qui suit `1de9d482`** (lui-même fils de
`277aef63`, la passe 11). Même pierre : P1 du plan « De la maquette au
produit ». Rien d'autre de la PR n'a bougé.

## Ce que la passe 11 a trouvé, et ce qui en a été fait

| Constat passe 11 | Vérifié à la source | Ce qui a changé |
|---|---|---|
| **P0** — une carte déclarée hors vocabulaire était rabattue sur `generic` en silence | Vrai (`cards.ts`, ancienne l. 35-40) | `cardForTool` et `declaresCard` LÈVENT `ToolCardError` (nomme l'outil, la valeur, le vocabulaire, la réparation). `registry.register()` la refuse AVANT d'enregistrer — l'outil n'entre pas. L'absence reste `generic`. |
| **P1** — `query_memory` → `table`, pas `text` | Vrai (`MemoryRecord[]`, colonnes stables) | `table`. Et le même raisonnement appliqué aux autres sorties en lignes : `list_models` (`{id,label}[]`), `list_schedules` (`ScheduleRow[]`), `list_conversations` (`ConversationEntry[]`) → `table`. `skill_view` rend le CONTENU d'une skill → `read`. |
| **P1** — `code_task` → `files` décrit ce que la sortie ne fournit pas | Vrai (`CodeTaskOutput` : `resultText`, coût, durée, exit ; aucun fichier, aucun diff) | `delegation`, PAS `terminal` ni `text` — voir le doute ci-dessous. |
| **P1** — l'asymétrie Airtable annoncée n'existe pas dans le code | Vrai : `create/list_records_for_table` sont des outils MCP (`airtable__…`), donc `generic` par la fabrique. La table de la passe 11 était fausse, le code n'a jamais eu ces lignes. | Aucun changement de code. La table ci-dessous est la vraie. |
| **P1** — `delegation`, `create_task`, `list_tasks` hors de la garde | Vrai | `1de9d482` : les suites `assign-tools.test.ts` et `task-tools.test.ts` portent l'assertion. Mutation mesurée : cartes retirées → 2 tests rouges (`expected undefined to be 'delegation'`, `… 'text'`). |
| **P1** — le test prouve la présence, pas la justesse | Vrai | `cards.test.ts` compare la **table complète** nom → carte (72 outils) à l'attendu. Mutation mesurée : `query_memory` remis à `text` → rouge, le diff nomme la ligne. |
| **P2** — autres sites échappant à la garde dans `packages/tools/src` | Aucun (confirmé par la passe 11) | — |

Mesuré ici, pas déduit : `tools` 833 verts (57 fichiers) ; `tsc` du paquet
propre ; mutation « `register()` sans `assertToolCard` » → le test « le
registre REFUSE » rougit seul, les 8 autres restent verts.

## Ce dont je doute moi-même — à attaquer en priorité

### P1 — `code_task` → `delegation` : est-ce vrai, ou commode ?

Mon argument : `code_task` confie un travail à un AUTRE agent (le CLI), et
rend sa réponse finale, son coût, sa durée — exactement ce que rend
`assign_<agent>`. Ses pas à lui arrivent à part, en lignes `tool_calls`
vivantes (`live-events.ts`), comme ceux d'un sous-agent Nodal. Donc même
carte.

Le contre-argument que je vois : un sous-agent Nodal a une ligne `agent_jobs`
(sous-job, propre conversation) ; `code_task` a une ligne `cli_runs`. Quand P2
dessinera la carte `delegation`, elle attendra peut-être un sous-job qui
n'existe pas pour `code_task`. Question précise : la carte `delegation`
doit-elle porter la forme (« un autre agent a travaillé, voici sa réponse »)
ou la structure de données (un `agent_jobs` enfant) ? Si c'est la seconde,
`code_task` mérite sa propre carte, ou `terminal`.

### P1 — l'extension à `list_models`, `list_schedules`, `list_conversations`

La passe 11 n'a demandé que `query_memory`. J'ai étendu par cohérence : une
sortie qui est un tableau d'objets à colonnes stables est une `table`. Mais
`list_models` liste des identifiants destinés au LLM (pour `create_agent`),
pas à l'utilisateur. Une table de trois lignes `{id, label}` dans le fil de
conversation, est-ce juste ou est-ce du bruit qu'un `text` aurait mieux
résumé ? Trancher outil par outil.

### P1 — lever à l'affichage

`registry.register()` refuse déjà toute carte inventée. `cardForTool()` lève
AUSSI, ce qui met une exception potentielle dans le chemin de rendu (P2).
Le seul chemin qui l'atteint : un outil construit HORS registre avec un cast
(`as unknown as ToolDefinition`). Est-ce le bon endroit pour échouer fort, ou
faut-il que `cardForTool` soit total (jamais d'exception) et que la garde
vive UNIQUEMENT à l'enregistrement — quitte à ce que les outils hors registre
(`assign_<agent>`, `create_task`, MCP) passent par une `assertToolCard`
explicite à leur fabrication ?

### P2 — `declaresCard` lève aussi

Pour l'énumération du registre, une carte inventée lève au lieu de rendre
`false`. Choix assumé : « inventée » n'est pas « non déclarée ». Mais la
fonction s'appelle `declaresCard` et lève — un lecteur s'y attend-il ?

## La table des cartes, telle qu'elle EST (72 outils, énumérés par le test)

| Carte | Outils |
|---|---|
| text | return_result, save_memory, mark_memory_helpful, mark_memory_outdated, create/update/toggle/run_schedule, create/update/attach/detach_agent, attach/detach/create/update_skill, attach/detach/create_connector, attach/detach/create_mcp |
| read | file_read, docx_read, pptx_read, skill_file_read, **skill_view** |
| search | file_search, web_search, xlsx_find_cells, search_history |
| files | file_write, file_edit, file_list, skill_file_write, skill_file_list, docx_* / pptx_* / xlsx_* (écrivains) |
| table | xlsx_read, **query_memory, list_models, list_schedules, list_conversations** |
| terminal | run_command, run_skill_script |
| sent | dashboard_publish, telegram_send_message, send_file, send_image, send_video, send_audio, send_voice |
| checks | review_verdict |
| delegation | **code_task** ; assign_<agent> (orchestration, hors registre) |
| text (orchestration, hors registre) | create_task, list_tasks |
| generic | tout outil MCP (dont `airtable__*`) ; tout adaptateur de connecteur (par repli) |

En gras : ce qui a changé depuis la passe 11.

## Hors périmètre

Le rendu des cartes (P2) — la passe 11 a raison de dire que « entrée et
sortie brutes, dites telles quelles » n'est pas prouvé par P1 : c'est P2 qui
le prouvera. La qualification des ~140 adaptateurs de connecteurs : pierre à
part.

## Ce qui n'est PAS attendu

« Ça a l'air bien ». Deux verdicts valent : le constat tient, le constat est
faux. Un constat non exécuté est marqué NON EXÉCUTÉ — la passe 11 l'a fait
correctement pour `cards.test.ts`, faire pareil.
