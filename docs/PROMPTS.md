# Prompts envoyés au LLM — inventaire complet

> ⚠️ **DÉPRÉCIÉ (2026-07-15) — instantané historique, ne PAS s'y fier.**
> Ce document a dérivé en silence : audit du 15/07 → `ALWAYS_ON_TOOLS` compte 16 outils (pas 3),
> `return_result` et `save_memory` ont été réécrits (lot channel-return), le header
> `## Your available adapters` n'existe plus (remplacé par `## Skills (load before acting)`
> en disclosure progressive), et les numéros de ligne ont tous dérivé.
> La source de vérité est le code : `packages/orchestration/src/system-prompt.ts`,
> `packages/tools/src/builtin/index.ts` (`ALWAYS_ON_TOOLS`), et les descriptions des tools
> eux-mêmes. La moitié générée des docs (`apps/docs/scripts/gen-reference.ts`) publie
> l'inventaire des tools à jour à chaque build. Un inventaire de prompts maintenu à la main
> re-dérivera toujours — ne pas ressusciter ce fichier sans le générer depuis le code.

**Source de vérité.** ~~(voir l'avertissement ci-dessus)~~ Tout ce que le LLM "voit" lors d'un appel `generateText` provient de :
1. La **personnalité** de l'agent (donnée DB, pas dans le code).
2. Le **system prompt** assemblé par `buildSystemPrompt` (orchestration package).
3. Les **descriptions de tools** + **descriptions de schémas Zod** des outils whitelistés pour cet agent.
4. Les **messages** précédents du job (user task + tool_calls + tool_results).
5. Quelques **markers internes** injectés par le runner (approval, deferred handoff).

Les chaînes hardcodées par catégorie ci-dessous. Les portions interpolées (`${...}`) viennent toujours de la DB.

---

## 1. Assemblage du system prompt

### `packages/orchestration/src/system-prompt.ts`

| Ligne | Contenu |
|---|---|
| 45 | `## Your available adapters` (header — listé seulement si l'agent a des skills assignés) |

Le system prompt final = `agent.personality` (DB) + `## Your team` (si orchestrateur) + `## Your available adapters` (si skills).
Si la personality contient `{{team}}`, le bloc team est injecté à cet endroit ; sinon il est ajouté à la fin.

### `packages/orchestration/src/team-block.ts`

#### Mode router (orchestrateur avec sub-agents)

| Ligne | Contenu |
|---|---|
| 95 | `## Your team` |
| 97 | `You are a **router orchestrator**. Route requests to the right sub-agent using their \`assign_*\` tool.` |
| 107 | `- **${agentName}**${roleTag} — use \`assign_${toolSlug}\` to assign work${skillsTag}${instrTag}` (1 ligne par child) |
| 114 | `After a sub-agent returns its result, call \`return_result\` with the final answer for the user. Do NOT delegate again unless the user's request explicitly requires another agent.` |

#### Mode planner (orchestrateur avec workers + task board)

| Ligne | Contenu |
|---|---|
| 112 | `## Your team` |
| 114 | `You are a **planning orchestrator**. Create tasks using \`create_task\` and assign them to agents.` |
| 123 | `- **${agentName}**${roleTag} (assigned_to: \`${agentSlug}\`)${skillsTag}${instrTag}` (1 ligne par child) |

#### Fragments dynamiques communs

- `roleTag` = `" (orchestrator)"` si le child est lui-même orchestrateur.
- `skillsTag` = `"\n  Skills: ${skills.join(', ')}"`.
- `instrTag` = `"\n  Instructions: ${instructions}"` (champ libre depuis `agent_assignments.instructions`).

---

## 2. Descriptions des tools always-on (built-in)

Ces 3 tools sont injectés dans **chaque** worker (et `return_result` dans chaque orchestrateur).

| Tool | Fichier | Description |
|---|---|---|
| `return_result` | `packages/tools/src/builtin/return-result.ts:17` | "Report the final result of your task. Call this when the task is complete or when you are blocked and cannot proceed. Use status='success' when the task succeeded, status='blocked' when data is not found or you cannot proceed after 2 attempts." |
| `save_memory` | `packages/tools/src/builtin/save-memory.ts:34` | "Save a durable fact that will make you better at a future, unrelated task. Use sparingly — only save facts that are specific, stable over time, and reusable outside the current session." |
| `query_memory` | `packages/tools/src/builtin/query-memory.ts:39` | "Read your persistent memories. Use before starting a task to recall relevant context, preferences, and learned rules. Filter by skill_tags to retrieve skill-specific memories." |
| `web_search` | `packages/tools/src/builtin/web-search.ts:25` | "Search the web for current information. Use when you need up-to-date data, news, or any facts you are not sure about." (registered mais pas dans `ALWAYS_ON_TOOLS` — opt-in via skill assignment) |

`ALWAYS_ON_TOOLS = ['return_result', 'save_memory', 'query_memory']` — défini dans `packages/tools/src/builtin/index.ts:30`.

---

## 3. Tools d'orchestration (générés dynamiquement par agent)

### `assign_<slug>` — un par child d'un orchestrateur router

`packages/orchestration/src/router/assign-tools.ts:107` génère la description :
```
Assign a task to ${agentName}${roleNote}.${skillsDesc}${instrNote}
```
Avec :
- `roleNote` = `" (orchestrator — manages their own team)"` si le child est orchestrateur.
- `skillsDesc` = `" Skills: ${skills.join(', ')}."`.
- `instrNote` = `" Instructions: ${instructions}"`.

Schéma input (lignes 12-20) :
- `task` : "What this agent should do. Be specific and complete."
- `data` : "Data from a previous step to pass to this agent (e.g. spreadsheet content, search results)."

### `create_task` / `list_tasks` — pour orchestrateur planner

`packages/orchestration/src/planner/task-tools.ts`

| Tool | Ligne | Description |
|---|---|---|
| `create_task` | 75 | "Create a task in the task board and assign it to an agent. Tasks are executed asynchronously by the cron tick after this job completes. Use depends_on to chain tasks sequentially." |
| `list_tasks` | 133 | "List tasks on the task board for this job. Returns task IDs (needed for depends_on), titles, statuses, and assignments." |

Champs schéma `create_task` (lignes 13-26) : `title`, `description`, `assigned_to`, `priority`, `depends_on`, `context`. Tous avec `.describe()` LLM-bound.

---

## 4. Descriptions de tools adapters

Tous les adapters tournent dans leur package sous `packages/adapters/<name>/src/tools/*.ts`. Chaque tool a une `description:` (envoyée au LLM avec son schéma input).

### Gmail — `packages/adapters/gmail/src/tools/`

| Tool | Fichier:ligne | Verbe |
|---|---|---|
| `gmail_send_message` | `messages.ts:66` | "Send an email via Gmail. Supports plain text and HTML bodies, CC, BCC, Reply-To, and file attachments…" |
| `gmail_list_messages` | `messages.ts:138` | "List Gmail messages matching a query. Returns message IDs, thread IDs, sender, subject, date and snippet…" |
| `gmail_get_message` | `messages.ts` | (lire le fichier pour le détail) |
| `gmail_get_thread` | `messages.ts` | |
| `gmail_untrash_message` | `messages.ts:541` | "Restore a Gmail message from the Trash folder." |
| `gmail_list_labels` | `labels.ts:33` | "List all Gmail labels — both system labels (INBOX, SENT, TRASH, SPAM, etc.) and user-created labels…" |
| `gmail_get_label` | `labels.ts:83` | "Get details and message counts for a specific Gmail label." |
| `gmail_update_label` | `labels.ts:180` | "Update an existing Gmail user label — rename it or change its visibility." |
| `gmail_delete_draft` | `drafts.ts:321` | "Permanently delete a Gmail draft. This is irreversible." |

### Google Docs — `packages/adapters/google-docs/src/tools/`

| Tool | Fichier:ligne |
|---|---|
| `docs_create_document` | `lifecycle.ts:35` |
| `docs_get_document` | `lifecycle.ts:104` |

### Google Drive — `packages/adapters/google-drive/src/tools/`

| Tool | Fichier:ligne |
|---|---|
| `drive_list_files` | `list-files.ts:47` |
| `drive_read_file` | `read-file.ts:31` |
| `drive_create_folder` | `create-folder.ts:27` |
| `drive_copy_file` | `copy-file.ts:25` |
| `drive_rename_file` | `rename-file.ts:23` |
| `drive_move_file` | `move-file.ts:24` |
| `drive_list_permissions` | `list-permissions.ts:30` |

### Google Sheets — `packages/adapters/google-sheets/src/tools/`

| Tool | Fichier:ligne |
|---|---|
| `sheets_read_range` | `values.ts:41` |
| `sheets_read_all` | `values.ts:91` |
| `sheets_get_metadata` | `structure.ts:42` |
| `sheets_add_sheet` | `structure.ts:157` |
| `sheets_rename_sheet` | `structure.ts:317` |
| `sheets_clear_filter` | `filters.ts:90` |

### Notion — `packages/adapters/notion/src/tools/`

| Tool | Fichier:ligne |
|---|---|
| `notion_get_page` | `pages.ts:36` |
| `notion_get_page_content` | `pages.ts:102` |
| `notion_archive_page` | `pages.ts:309` |
| `notion_query_database` | `databases.ts:55` |
| `notion_delete_block` | `blocks.ts:203` |
| `notion_list_comments` | `comments.ts:41` |
| `notion_add_comment` | `comments.ts:89` |
| `notion_list_users` | `users.ts:39` |
| `notion_get_user` | `users.ts:83` |

> Pour la liste exhaustive des champs schéma de chaque tool adapter, ouvrir directement le fichier — chaque champ Zod a un `.describe()` qui termine dans le schéma envoyé au LLM.

---

## 5. Markers internes injectés dans la conversation

### Approval gate

`apps/runner/src/job/execute.ts:515`
```
[AWAITING_APPROVAL] tool_call_id=${call.id}
```
Inséré comme `tool-result` quand un tool nécessite approbation. L'agent voit ça, sait qu'il est bloqué, et le runner suspend le job (`status = awaiting_approval`).

### Délégation différée (multi-assign en un seul tour)

`packages/orchestration/src/router/only-one-per-turn.ts:68-71`
```
Deferred — another handoff in this turn took priority. Call me again after the first handoff completes and you have its result.
```
Quand un orchestrateur appelle 2 `assign_*` dans le même tour, seul le 1er est exécuté ; les autres reçoivent ce tool_result avec `is_error: true` pour préserver l'invariant "every tool_use has a matching tool_result".

---

## 6. Compilation des résultats finaux (cron)

`apps/runner/src/cron/deliver-results.ts:135-139` — quand un orchestrateur planner termine, ses sous-tâches du board sont compilées en un texte unique livré à l'utilisateur :
```
## ${t.title}${statusTag}
${body || '(no result)'}
```
séparé par `\n\n---\n\n` entre tâches. `statusTag` = `" [${t.status}]"` si pas `done`.

Ce texte n'est pas envoyé au LLM — c'est le **résultat final** délivré (Telegram/Email/log/…).

---

## 7. Données dynamiques DB qui finissent dans le prompt

Tout ce qui suit n'est pas dans le code mais traverse le LLM à chaque appel :

| Source | Destination |
|---|---|
| `agents.personality` | Tête du system prompt (raw, untouched) |
| `agents.name`, `agents.slug`, `agents.role` | Bloc team de l'orchestrateur parent |
| `agent_assignments.instructions` | Bloc team + descriptions des `assign_*` tools |
| `agent_skills.name`, `agent_skills.slug` | Section "## Your available adapters" + bloc team annotations |
| `agent_jobs.task` | Premier message user de la conversation |
| `agent_jobs.messages` (jsonb) | Historique complet de tous les tours |
| `agent_jobs.system_prompt` (cache) | Réutilisé tel quel après le 1er build pour éviter de re-querier la DB |

---

## Comment vérifier en live ce que le LLM reçoit

```bash
cd D:/APPS/NodalAI/packages/db && node --input-type=module -e "
import postgres from 'postgres';
const sql = postgres('postgresql://nodalai:nodalai@localhost:25432/nodalai');
const [r] = await sql\`SELECT system_prompt, messages FROM agent_jobs WHERE id = 'JOBID'\`;
console.log('SYSTEM:'); console.log(r.system_prompt);
console.log('MESSAGES:'); console.log(JSON.stringify(r.messages, null, 2));
await sql.end();
"
```

Le `system_prompt` est gelé après le 1er tour de la loop ; les `messages` reflètent l'état au dernier checkpoint.
