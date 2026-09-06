# Demande de review — PR #46, passe 29 (P7 : Chat, la maison de toutes les conversations ; et les correctifs de la passe 28)

Périmètre : **deux commits**.

- `55ec67eb` — **P7** : `packages/db/migrations/0095_tool_calls_risk_level.sql` (+ journal),
  `packages/db/src/schema/tool_calls.ts`, `packages/db/src/tests/helpers.ts`,
  `packages/tools/src/execute.ts` (l'insert `risk_level`) + `execute.test.ts`,
  `apps/web/src/lib/chat-or-work.ts`, `conversation-thread.ts`, `conversation-actions.ts`,
  `job-feed.ts`, `tool-card-payload.ts`, `conversation-feed.ts` (items `produced` / `handoff`),
  `actions.ts` (extraction vers `job-feed.ts`, suppression de `listConversationsAction`,
  `listChatAction`, `getChatJobStatusAction`), `app/(dashboard)/chat/page.tsx`,
  `chat/ConversationsList.tsx`, `chat/ThreadComposer.tsx`, `chat/[id]/page.tsx`,
  `spaces/ProducedCard.tsx`, `spaces/ConversationFeedView.tsx` ; `ChatClient.tsx` supprimé ;
  tests `chat-or-work`, `conversation-thread`, `conversation-actions`, `ProducedCard`.
- `8ab609f1` — **les correctifs de la passe 28** (à VÉRIFIER, pas à relire de zéro) :
  `thread-history.ts` (whatsapp), les quatre handlers (`/new` avant le préfixe ; un `/new` nu
  reste `/new`), `conversation-id.ts` (`pg_advisory_xact_lock`, `ORDER BY created_at DESC,
  id DESC`, `openedByCommand`), `attach.ts` (`jobProjectId`, `conversation: 'not_found'`),
  `run-job.ts` (`harnessWrote` sur `EDIT_TOOLS`), `system-prompt.ts` (ligne `/new`).

**Hors périmètre** : tout fichier non committé (P8 commence en parallèle : `project-actions.ts`,
`project-path.ts`, `app/(dashboard)/spaces/**`, `app/(dashboard)/scheduled/[id]/**`).

## Ce que P7 pose (plan « De la maquette au produit », P7)

- `/chat` : `listAllConversationsAction` — `conversations` de l'entité, `origin = 'user'`, tous
  canaux, tous agents, 200 max ; trois requêtes (la liste, les agrégats `chat_messages` par
  conversation, les agrégats des jobs de tête) ; titre = colonne, sinon première demande (60) ;
  aperçu = dernière réponse (120) ; `turns` = messages `user` (dashboard) ou jobs de tête (canal).
  `ConversationsList` (client) : recherche titre/agent, suppression avec `ConfirmDialog`,
  « New conversation » (`createConversationAction`, `no_root_agent` dit avec le lien Settings).
- `/chat/[id]` : `getConversationThreadAction` — la conversation (bornée à l'entité), ses
  `chat_messages` (500), ses jobs de tête (100), `assembleJobFeed` par job (extrait de
  `getSpaceConversationAction`, partagé), `collectDescendants` (toute profondeur, avec la
  racine de chacun), les `tool_calls` de tous (têtes + descendants) rangées sous leur racine,
  `classifyProduction` par job, le projet de chaque job (`agent_jobs.project_id`), la preuve /
  les envois / le coût sur tous les jobs (`startedAt` = création de la conversation, `endedAt`
  = dernier `completed_at` si tout est terminal), `live`, `canReply = channel === 'dashboard'`.
- `buildConversationThread` (pur) : canal → les items de chaque job SANS `history`, puis
  `produced` si `isWork` ; dashboard → `request` par message user, `turn` (prose, `usage: null`,
  `turn: 0`, `inferred`) par message assistant non vide, puis les items du job escaladé avec son
  `request` converti en `handoff`, `note` « (job no longer available) » si le job est purgé ;
  totaux sommés, modèles dédupliqués.
- `classifyProduction` (pur) : `cli:*` → harness (une entrée par harnais) ; `files` → une
  entrée par fichier (plafond 8, `more`), charge absente = un fichier sans nom, `total: 0` =
  rien ; `sent` → réponse si `channel` = celui de la conversation ET `target` absent ou égal
  au `chat_id`, sinon envoi ; `terminal` → commande ; `generic` → `write`/`destructive` =
  externe certain, `read` = chat, sans niveau = externe INCERTAIN (compté, jamais décisif) ;
  tout le reste (`text`, `read`, `search`, `table`, `checks`, `delegation`, `question`, carte
  absente) = chat. `isWork` = au moins un item certain.
- `tool_calls.risk_level` (0095) : écrit par `executeTool` depuis `tool.riskLevel`, CHECK
  read/write/destructive, NULL avant et sur `cli:*`.
- `ProducedCard` : « Produced », « in <name> · <path> » (lien `/spaces/<id>`) ou « outside any
  registered project », la liste, « and N more files », « N classification(s) uncertain: the
  tool declared no risk level ».

## Mesuré

- Suites : web 74 fichiers / 1140 tests (dont 36 neufs), tools 872, db 258 ; `pnpm typecheck`
  racine, dependency-cruiser (pas d'import du runner depuis le web), lint web 0 erreur.
- Mutations (rouges puis restaurées) : `riskLevel` non écrit → tools rouge ; projet forcé
  `null` → action rouge (Opus) ; `history` conservé → 3 rouges ; « cible absente = réponse »
  inversé → VERT à la première écriture (branche non couverte) → cas ajouté, puis rouge (moi).
- Migration 0095 appliquée sur la base dev ; capture Playwright (chromium headless, 1280×900)
  de `/chat` (55 conversations listées) et du fil Telegram le plus récent : liste et fil se
  dessinent ; aucun encart sur ce fil (lignes d'avant P1, sans carte).
- Passe 28 : runner 688, tools 20, orchestration 235 ; 8 mutations rouges par Opus, 2 refaites
  par moi (whatsapp retiré → rouge ; garde `/new` nu retirée → rouge).

## Ce dont je doute moi-même

### Le titre d'une conversation de canal garde le préfixe de groupe

Le backfill 0094 et `touchConversation` prennent la première ligne de la première tâche ; en
groupe, c'est `[Message from kwint]: Tu es la ?` — visible sur la capture. Faut-il retirer ce
préfixe au titrage (et où : `touchConversation` seulement, ou aussi le backfill) ?

### `assembleJobFeed` par job de tête, en parallèle

Jusqu'à 100 jobs × 3 requêtes lancées d'un coup par `Promise.all`. Sur un fil de 100 tours,
c'est 300 requêtes concurrentes sur le pool. Est-ce un problème réel avec le pool par défaut,
ou une optimisation à faire quand on la mesurera ?

### Un tour du dashboard escaladé : la demande de l'utilisateur ET la consigne

Le fil montre le message de l'utilisateur (`request`), l'accusé de l'agent (`turn`), puis la
consigne passée au job (`handoff`, repliée). Est-ce lisible, ou le `handoff` fait-il doublon
avec l'accusé quand l'agent a reformulé la même chose ?

### `canReply` sans vérification du ROOT

`ThreadComposer` envoie par `sendChatMessageAction`, qui vise l'agent ROOT ; une conversation
du dashboard d'un AUTRE agent (créée avant que le ROOT change) accepterait une saisie que
l'action enverrait au ROOT actuel, pas à l'agent de la conversation. Cas réel ou théorique ?

### Les lignes sans carte sont du chat

Un fil d'avant P1 (0092) n'a aucune carte : un job qui a écrit dix fichiers en août n'aura
jamais d'encart. Dit dans le plan comme limite ; faut-il aussi le dire à l'écran (« older
work, no classification ») ?

## Ce qui n'est PAS attendu

« Ça a l'air bien ». Deux verdicts : tient / faux. Dis explicitement si tu ne trouves rien de
neuf — et, pour `8ab609f1`, si les six corrections de la passe 28 tiennent. Un constat non
exécuté est marqué NON EXÉCUTÉ (sandbox lecture seule : ni pnpm ni git).
