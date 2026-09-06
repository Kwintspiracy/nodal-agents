# Demande de review — PR #46, passe 28 (P6 : la conversation continue et son projet courant ; et les correctifs de la passe 27)

Périmètre : **le commit `ea984c1b`**, en deux parts.

**P6** — `packages/db/migrations/0094_conversations_all_channels.sql` (+ journal),
`packages/db/src/schema/chat-messages.ts` (+ `jobs.ts` : commentaire de `conversation_id`),
`packages/db/src/tests/helpers.ts`, `packages/orchestration/src/system-prompt.ts`
(`ConversationContext`, `buildConversationBlock`), `packages/tools/src/projects/attach.ts`
(issue refondue, `current_project_id`), `packages/tools/src/types.ts` (`ToolContext.conversationId`),
`apps/runner/src/job/conversation-id.ts` (réécrit), `apps/runner/src/job/thread-history.ts`,
`apps/runner/src/job/execute.ts`, `apps/runner/src/chat/run-chat-turn.ts`, les quatre handlers
de canal (`telegram/handler.ts`, `channels/{slack,discord,whatsapp}/handler.ts`),
`apps/runner/src/cli-runtime/{run-job,run-chat}.ts`, `apps/web/src/lib/actions.ts`
(`listConversationsAction` seulement), et les tests correspondants.

**Passe 27** — `apps/web/src/lib/project-actions.ts` (contenance physique) + test ;
`packages/tools/src/execute.ts` (`MutationGate`, `isPresentedFailure`, rattachement après
l'exécution) + `attach-seam.test.ts` ; `run-job.ts` / `run-chat.ts` (rattachement après
`binding.run`) + `intent-cli-runtime.test.ts` ; `run-schedules.test.ts`, `provider.test.ts`.

**Hors périmètre** : tout fichier non committé (P7 commence en parallèle : `chat-or-work.ts`,
`conversation-thread.ts`, `conversation-actions.ts`, `app/(dashboard)/chat/**`, migration 0095).

## Ce que P6 pose (plan « De la maquette au produit », P6)

- `conversations` = la table de TOUS les canaux : `channel` (CHECK dashboard/telegram/slack/
  discord/whatsapp, DEFAULT dashboard), `chat_id`, `current_project_id` (FK code_projects SET NULL),
  index `(entity, agent, channel, chat_id, created_at DESC)`. Backfill : une ligne par
  conversation de canal existante (identité d'hier conservée telle quelle ; 54 lignes sur la
  base dev), titre = première ligne de la première tâche, 60 car.
- **Pas de FK** `agent_jobs.conversation_id → conversations` : mesuré, 95 jobs de la base dev
  portent l'uuid d'une conversation supprimée (CASCADE sur chat_messages, jamais sur les jobs) —
  une FK les ramènerait à NULL et la page Runs perdrait leur regroupement.
- `resolveConversation` (la plus récente par `created_at` du tuple, sinon INSERT),
  `openNewConversation` (INSERT toujours, sans hériter du projet courant), `touchConversation`
  (titre posé UNE fois par un `CASE` SQL, `updated_at`), `parseNewConversationCommand` (`/new`
  exact ou préfixe `/new ` ; `/newer` non), `loadConversationContext` (tours précédents : jobs de
  tête hors `excludeJobId` pour un canal, messages `user` − 1 pour le dashboard ; projet courant
  avec `display_name ?? basename`).
- `thread-history.ts` : relecture par `conversation_id`, jobs de TÊTE (`parent_job_id IS NULL`),
  `MAX_TURNS` + `BUDGET_CHARS` ; le silence de 4 h, `IDLE_RESET_MS`, `MAX_LOOKBACK_MS` et
  `THREAD_IDLE_RESET_MINUTES` ont disparu (la variable ne survit que dans le backfill 0059).
- Bloc `## Conversation` après `## Job context` : « first turn » / « Turns before this one: N » ;
  projet courant `**name** — \`path\` (kind)` neutralisé par `sanitizePromptField`, ou « none yet ».
- Les 4 handlers : `/new` → `openNewConversation` (un `/new` nu garde `/new` comme tâche —
  invariant #2, le runner ne fabrique rien) ; le job porte `conversationId` ET `projectId =
  currentProjectId` ; `touchConversation` après l'insert. Telegram : `/new` passe le filtre de
  groupe. `run-chat-turn.ts` : le job escaladé porte `projectId`, le prompt reçoit `conversation`.
- `attach.ts` : `{ kind: 'attached', projectId, projectPath, job: attached|already_attached|
  kept_existing|no_job, conversation: set|no_conversation } | no_project | failed`. La
  conversation est TOUJOURS écrasée (la dernière production décide) ; `kept_existing` est
  journalisé avec les deux ids.

## Ce que la passe 27 a changé

- **Contenance physique** (`project-actions.ts`) : `realNearestAncestor` des deux côtés (cible et
  terrain) puis `isUnderPath` — un lien ne peut vivre que dans un dossier existant, donc c'est la
  partie existante qui peut mentir ; un terrain pas encore créé partage son ancêtre avec la cible
  et reste dedans. Test : jonction `terrain/lien → ailleurs`, `subfolder: 'lien/externe'` refusé,
  rien créé de l'autre côté.
- **Rattachement après le succès** (`execute.ts`) : `takeMutationIntent` rend `{ error } |
  { targets }` ; après `tool.execute`, `attachProductionToProject` seulement si
  `!isPresentedFailure` (carte `text` avec `failure: true` = l'outil a répondu mais rien n'a
  été produit ; un présentateur qui lève ne cache pas une production). CLI : après
  `binding.run`, seulement si le tour n'est pas en erreur et `mode === 'write'`.

## Mesuré

- Suites : runner (job, telegram, chat, cli-runtime, cron) 61 fichiers / 681 tests ; tools 869 ;
  web 1110 ; db 258 ; orchestration 233 ; `pnpm typecheck` racine ; dependency-cruiser ; lint
  runner/tools/orchestration/db 0 erreur.
- Mutations refaites par moi (rouges puis restaurées) : `isNull(parent_job_id)` retiré de la
  relecture → « un job ENFANT n'est pas un tour » rouge ; bloc Conversation débranché → 4 rouges ;
  rattachement aveugle au succès → « une écriture qui ÉCHOUE … ne rattache rien » rouge
  (`expected '<id>' to be null`). Opus en a fait 5 autres (filtre des jobs de tête, écriture du
  projet courant, `projectId` de l'insert Telegram et du job escaladé).
- Migrations 0093 et 0094 appliquées sur la base dev (`runMigrations`) ; 55 lignes
  `conversations` après backfill (1 + 54, comptées avant par requête).

## Ce dont je doute moi-même

### `resolveConversation` prend la plus récente par `created_at`, pas par `updated_at`

Un `/new` puis un job TARDIF de l'ancienne conversation (une délégation qui finit après) : par
`updated_at`, l'ancienne redeviendrait « la courante ». Par `created_at`, la neuve reste ouverte.
Mais deux `/new` dans la même milliseconde (deux messages en rafale) ? Et un backfill dont les
`created_at` sont `min(created_at)` des jobs — deux segments d'hier avec le même `min` ?

### Le compte « messages user − 1 » du dashboard

`loadConversationContext` est appelé APRÈS l'insert du tour utilisateur ; sur le chemin CLI
(`run-chat.ts`), l'insert du tour utilisateur a-t-il lieu au même moment ? Si non, le compte
est faux d'un sur cette surface.

### `/new` nu : la tâche `/new` part au modèle

Choix pour tenir l'invariant #2 : le runner n'invente aucun texte, le bloc Conversation dit
« first turn ». Le modèle reçoit donc un message qui est littéralement `/new`. Est-ce lisible
pour lui, ou faut-il une directive de plus dans le bloc (« the user just opened a new
conversation with the /new command ») ?

### Rattachement CLI « après le tour, si pas en erreur »

Une CLI qui a modifié dix fichiers puis est sortie non-zéro (tests rouges à la fin) a PRODUIT
dans le projet, et le registre dira non. L'inverse (rattacher un tour qui n'a rien écrit) est-il
plus grave ? Le `cli_runs.files_changed` existe-t-il pour trancher ?

### L'issue `kept_existing` porte le projet TROUVÉ

`projectId` = le projet trouvé, pas celui que le job garde ; l'ignoré n'est que dans un log.
Un appelant qui lirait `projectId` comme « le projet du job » se tromperait. Faut-il les deux
champs ?

## Ce qui n'est PAS attendu

« Ça a l'air bien ». Deux verdicts : tient / faux. Dis explicitement si tu ne trouves rien de
neuf. Un constat non exécuté est marqué NON EXÉCUTÉ (sandbox lecture seule : ni pnpm ni git).
