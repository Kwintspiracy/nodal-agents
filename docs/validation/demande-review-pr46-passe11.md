# Demande de review — PR #46, passe 11 (P1 : la carte des outils)

Périmètre : **le seul commit `277aef63`**. Première pierre du plan « De la
maquette au produit » (`docs/plans/de-la-maquette-au-produit.md`, P1).

## Ce que le commit affirme

1. Un vocabulaire FERMÉ `TOOL_CARDS` dans `packages/shared/src/enums.ts`
   (text, read, search, files, table, terminal, sent, checks, question,
   delegation, generic), avec son schéma zod et son type.
2. Un champ `card?: ToolCard` sur `ToolDefinition` (`packages/tools/src/types.ts`),
   optionnel dans le type pour que les outils tiers compilent.
3. `cardForTool()` (`packages/tools/src/cards.ts`) : la carte déclarée si elle
   est dans le vocabulaire, sinon `generic`. `declaresCard()` dit si l'outil
   l'a déclarée lui-même.
4. Les 68 outils natifs et de canal déclarent une carte ; la fabrique MCP
   déclare `generic` ; `assign_<agent>` déclare `delegation` ; `create_task`
   et `list_tasks` `text`. Les ~140 outils d'adaptateurs de connecteurs ne
   déclarent RIEN et retombent sur `generic` — choix assumé, à qualifier plus
   tard.
5. `cards.test.ts` énumère le registre et les fabriques de canal : tout outil
   du produit sans carte rougit en se nommant ; au moins une carte de chaque
   famille utile est déclarée ; le repli est `generic` et rien d'autre.

## Ce dont je doute moi-même — à attaquer en priorité

### P0 — le repli `generic` est-il un « smart fallback » interdit par l'invariant #4 ?

L'invariant du dépôt dit : pas de repli silencieux, échouer fort. Ici un outil
sans carte rend `generic` au lieu de lever. Ma défense : `generic` est une
carte HONNÊTE (entrée et sortie brutes, dites telles quelles), pas une
devinette, et DeepSeek Harness fait pareil pour ses outils non enregistrés.
Mais la ligne entre « repli honnête » et « repli silencieux » mérite un regard
extérieur. La question précise : un adaptateur de connecteur qui ne déclare
rien et rend `generic` cache-t-il quelque chose à l'utilisateur, ou lui dit-il
la vérité ?

### P1 — les cartes choisies sont-elles JUSTES ?

Le patch a posé les cartes par nom d'outil, depuis une table écrite à la main
(`scratchpad/patch-cards.py`, reproduite ci-dessous). Vérifier au moins :

- `query_memory` → `text`. Une liste de souvenirs, est-ce du texte ou une table ?
- `xlsx_find_cells` → `search`. Des cellules trouvées, `search` ou `table` ?
- `file_list` / `skill_file_list` → `files`. Une liste de fichiers sans diff
  est-elle une carte `files` ?
- `create_records_for_table` → `text` mais `list_records_for_table` → `table`.
  Asymétrie voulue (on écrit, on ne montre pas) ou erreur ?
- `code_task` → `files`. Le harnais de code produit des fichiers, mais aussi
  une sortie de terminal. Une carte suffit-elle ?
- Les outils meta (`create_agent`, `attach_skill`…) → `text`. Un réglage
  écrit se montre-t-il comme une réponse ?

### P1 — le test prouve-t-il ce qu'il dit ?

`cards.test.ts` : la mutation « retirer `card` de `run_command` » a rougi le
test en le nommant, vérifié à la main. Mais : la suite « couvre le vocabulaire
utile » exige une carte de chaque famille SAUF `question` et `delegation`.
`delegation` est déclarée par `assign_<agent>` dans `orchestration`, hors du
registre `tools` — le test ne la voit pas. Est-ce un trou, ou le bon
périmètre ?

### P2 — la fabrique `send-media.ts` et `query_memory`

Ces deux sites ont échappé au patch automatique (nom calculé, commentaire en
fin de ligne) et ont été posés à la main. Y en a-t-il d'AUTRES que le test ne
voit pas parce qu'ils ne passent ni par le registre ni par les fabriques
listées dans le test ? Chercher tout `riskLevel:` dans `packages/tools/src`
hors tests et comparer.

## La table des cartes, telle que posée

| Carte | Outils |
|---|---|
| text | return_result, query_memory, save_memory, mark_memory_helpful, mark_memory_outdated, list_models, list_schedules, skill_view, create/update/toggle/run_schedule, create/update/attach/detach_agent, attach/detach/create/update_skill, attach/detach/create_connector, attach/detach/create_mcp, lint_skill_content, list_conversations, create_records_for_table, create_task, list_tasks |
| read | file_read, docx_read, pptx_read, skill_file_read |
| search | file_search, web_search, xlsx_find_cells, search_history |
| files | file_write, file_edit, file_list, skill_file_write, skill_file_list, code_task, docx_*, pptx_*, xlsx_* (écrivains) |
| table | xlsx_read, list_records_for_table |
| terminal | run_command, run_skill_script |
| sent | dashboard_publish, telegram_send_message, send_file, send_image, send_video, send_audio, send_voice |
| checks | review_verdict |
| delegation | assign_<agent> (orchestration) |
| generic | tout outil MCP ; tout adaptateur de connecteur (par repli) |

## Hors périmètre

Tout le reste de la PR (dix passes déjà faites). Le rendu des cartes : c'est
P2, rien n'est affiché ici. Les adaptateurs de connecteurs : leur
qualification est une pierre à part.

## Ce qui n'est PAS attendu

« Ça a l'air bien », « conforme aux bonnes pratiques ». Deux verdicts valent :
le constat tient, le constat est faux. Un constat non exécuté est marqué NON
EXÉCUTÉ.
