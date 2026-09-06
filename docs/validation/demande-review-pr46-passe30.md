# Demande de review — PR #46, passe 30 (P8 : Spaces liste les projets, la page d'un projet ; et les correctifs de la passe 29)

Périmètre : **deux commits**.

- `d01585a3` — **P8** : `apps/web/src/lib/project-actions.ts` (`lastProof`, `getProjectPageAction`,
  `readProjectFolder`, `createProjectConversationAction`), `apps/web/src/lib/project-path.ts`,
  `app/(dashboard)/spaces/page.tsx`, `spaces/ProjectsTable.tsx`, `spaces/NewProjectButton.tsx`,
  `spaces/[id]/page.tsx` (neuve), `spaces/ProjectShelf.tsx`, `spaces/ProjectConversations.tsx`,
  `spaces/NewProjectConversationButton.tsx`, `spaces/ProjectComposer.tsx`,
  `spaces/ConversationFeedView.tsx` (lien d'une délégation), `chat/ThreadComposer.tsx`
  (`onBeforeSend`), `scheduled/[id]/page.tsx` (l'ancienne `spaces/[id]`, déménagée),
  `scheduled/ScheduledSection.tsx` (+ test) ; `spaces/ConversationsTable.tsx` et
  `listSpacesAction` supprimés ; tests `project-actions` (10 cas de plus), `project-path`,
  `ProjectsTable`, `ProjectShelf`, `ProjectConversations`.
- `717a28da` — **les correctifs de la passe 29** (à VÉRIFIER) : `tool-card-payload.ts`
  (`outcomeOfToolOutput`), `chat-or-work.ts` (issue, plafond, `unclassified`),
  `conversation-thread.ts` (note de troncature, note « non classé »), `job-feed.ts`
  (`assembleJobFeeds` groupé), `conversation-actions.ts` (plus récents puis remis en ordre,
  `truncated`, `stripGroupPrefix` au repli), `actions.ts` (`sendChatMessageAction` vise l'agent
  de la conversation), `apps/runner/src/chat/run-chat-turn.ts` (`conversation_agent_mismatch`),
  `apps/runner/src/job/conversation-id.ts` (`stripGroupPrefix` au titrage),
  `packages/shared/src/group-prefix.ts`, migration `0096_conversation_titles_prefix.sql`.

**Hors périmètre** : rien n'est en cours dans l'arbre de travail — c'est la fin du lot 2.

## Ce que P8 pose (plan « De la maquette au produit », P8)

- `/spaces` : `listProjectsAction` — les projets enregistrés (`registered_at IS NOT NULL`),
  compte et dernière activité des travaux (`agent_jobs.project_id`) en un LEFT JOIN groupé,
  dernier verdict de preuve par `DISTINCT ON (canonical_key)` sur `verification_runs` (clé =
  `projectKey(path)`, `green` → `pass`, sinon `fail`, `null` pour `documents` ou sans run).
  `ProjectsTable` ; masqués listés avec l'étiquette « hidden ».
- « New project » : modale `dismissable={false}`, terrains chargés à l'ouverture
  (`listProjectTerrainsAction`), aperçu du chemin final par `previewProjectPath` (module pur,
  la même règle `isSafeSubfolder` que l'action), erreurs de l'action affichées par code.
- `/spaces/[id]` : `getProjectPageAction` — bornée à l'entité ET aux lignes enregistrées ;
  `readProjectFolder` (un niveau, dossiers d'abord, `stat` des fichiers, `.git`/`node_modules`
  comptés dans `ignored`, plafond 200 → `more`, dossier absent → `missing: true`) ; preuve =
  `verify_commands` + `deriveVerifyStatus` + les 3 dernières séquences de la clé ;
  conversations = celles dont un travail porte `project_id` (sous-requête) OU ancrées par
  `current_project_id` (50, `anchored` dit lequel) ; `projectConversationId` = la plus
  récente `dashboard` ancrée. `createProjectConversationAction` : ligne `conversations`
  {dashboard, `current_project_id`, titre = nom du projet, agent ROOT}. `ProjectComposer` :
  `ThreadComposer.onBeforeSend` crée cette conversation au premier envoi.
- Le fil d'un RUN vit sur `/scheduled/[id]` (l'ancienne page, déplacée telle quelle) ; la
  section Scheduled et le lien d'une délégation dans un fil pointent là.

## Mesuré

- Web 77 fichiers / 1191 tests ; runner 823 ; shared 470 ; tools 72 (execute + projects) ;
  `pnpm typecheck` racine ; dependency-cruiser ; lint 0 erreur.
- Mutations (rouges puis restaurées) — P8 par Opus : tri de la dernière preuve inversé, tri des
  entrées retiré, filtre `registered_at` retiré, ancrage retiré ; passe 29 par Opus : 9 (issue,
  plafond anonyme, note, coupe, plafond-début, fils mélangés — refaite sans `tool_call_id`
  après un premier VERT —, agent root, mismatch runner, titre-préfixe) ; par moi : issue lue
  comme succès → 8 rouges ; contrôle d'agent du fil retiré → rouge.
- Migration 0096 appliquée sur la base dev : 0 titre préfixé restant. Captures Playwright de
  `/spaces` (registre vide, modale ouverte SANS soumettre), `/scheduled` (13 automatisations,
  261 runs), un groupe déplié, le fil d'un run sur `/scheduled/<id>` (carte « Sent to
  telegram »).

## Ce dont je doute moi-même

### La conversation du projet est « la plus récente ancrée »

Une conversation du dashboard qui a PRODUIT dans le projet (donc ancrée par P6) devient « la
conversation du projet » que la saisie du bas prolonge — même si elle n'a pas été créée
depuis la page. Est-ce le comportement voulu (« ce qui parle du projet, c'est son chat ») ou
faut-il distinguer une conversation CRÉÉE depuis le projet ?

### `createProjectConversationAction` prend le ROOT, `sendChatMessageAction` prend l'agent du fil

Cohérent aujourd'hui (la conversation naît avec le ROOT, puis reste au ROOT). Mais un projet
a un agent RESPONSABLE (`code_projects.agent_id`) : la conversation du projet ne devrait-elle
pas naître avec LUI plutôt qu'avec le ROOT ? (Le chat du dashboard n'a jamais parlé à un
autre agent que le ROOT ; c'est peut-être le lot 3.)

### Le lien d'une délégation vers `/scheduled/<jobId>`

Un délégué n'est pas un run d'automatisation, mais `/scheduled/[id]` est la seule route qui
rende le fil d'UN job. Route neutre à créer, ou acceptable tant que la page rend le bon fil ?

### `readProjectFolder` suit-il les liens ?

`readdir` avec `withFileTypes` ne suit pas les liens symboliques (un lien est `isSymbolicLink`,
ni dossier ni fichier → classé `file` ici) ; `stat` sur un lien vers un dossier échoue-t-il ou
rend-il la taille du dossier ? Rien n'est lu au-delà d'un niveau, donc pas de fuite, mais
l'étagère peut mentir sur la sorte d'une entrée.

### Les plafonds de la passe 29 avec la note en tête

`truncated.messages` est vrai dès que la requête rend EXACTEMENT 500 lignes — donc aussi
quand il y en a pile 500. La note dit alors « Older turns are not shown » à tort, une fois sur
cinq cents. Acceptable, ou lire N+1 ?

## Ce qui n'est PAS attendu

« Ça a l'air bien ». Deux verdicts : tient / faux. Dis explicitement si tu ne trouves rien de
neuf — et, pour `717a28da`, si les sept corrections de la passe 29 tiennent. Un constat non
exécuté est marqué NON EXÉCUTÉ (sandbox lecture seule : ni pnpm ni git).
