# Demande de review — PR #46, passe 37 (P10a : `ask_user`, l'agent pose une question à boutons)

Périmètre : **un commit**, `5c7938a7` (42 fichiers). Codé par un agent Opus sur spec, relu par
l'orchestrateur, 10 mutations rouges. L'arbre de travail est propre (rien d'autre en cours).

- `packages/tools/src/builtin/ask-user.ts` (neuf), `execute.ts` (troisième plancher
  `asksUser`, `hasAnsweredQuestion`, `kind` posé à l'insertion et sur `ApprovalGateRequest`),
  `types.ts` (`asksUser`, `ApprovalGateRequest.kind`), `builtin/index.ts` (enregistré,
  `ALWAYS_ON_TOOLS`), `tests/builtin/ask-user.test.ts`, `tests/cards.test.ts`.
- `packages/db/migrations/0098_approval_requests_question.sql` (`kind` NOT NULL DEFAULT
  'approval' CHECK, `answer` text), `schema/approvals.ts`, `tests/helpers.ts`.
- `packages/shared/src/tool-cards.ts` (`QuestionCardSchema.answer`, `question` = carte
  structurée, `readQuestionToolInput`).
- `packages/delivery` : `QuestionCard`, `sendQuestionCard?` ; Telegram (un bouton par ligne,
  `callback_data = <callbackId>:o<i>`), Discord (5 par rangée, `custom_id`), Slack (bloc
  actions, `action_id`).
- `apps/runner/src/approvals/resolve.ts` (`answer`, trois codes), `routes/approve.ts`,
  `approvals/notify.ts` (`buildQuestionCardBody`, carte de question ou repli texte numéroté),
  `telegram/approval-callback.ts` (`ParsedApprovalCallback`, suffixe `o<n>` ≤ 3 chiffres,
  garde « pick an option »), `channels/{discord,slack}/approval-callback.ts` + `interactions.ts`
  ; tests `resolve-question`, `approval-callback-question`, `notify-question`, `job/ask-user-flow`
  (bout en bout : suspension → réponse → reprise, le transcript porte `{ answer }`).
- `apps/web` : `lib/actions.ts` (`kind`, `answer` listés et transportés),
  `lib/conversation-feed.ts` (`FeedQuestionRow`, `ToolStep.question`, `showsAlone` sur une
  question en attente), `lib/job-feed.ts` (questions chargées par job, filtrées en SQL sur
  `kind`), `approvals/page.tsx` + `QuestionActions.tsx`, `spaces/ConversationFeedView.tsx`
  (`case 'question'` → `QuestionCard`, entrée relue quand `presented` manque),
  `spaces/QuestionCard.tsx`, `spaces/ProjectThread.tsx` (`LiveRefresh` branché), tests.

## Ce que P10a pose (plan, P10, moitié « plomberie »)

Un outil `ask_user` : 2 à 6 options, le job se SUSPEND par la porte d'approbation existante
(ligne `approval_requests` de `kind = 'question'`, marqueur `[AWAITING_APPROVAL]`), la
question part dans le canal d'origine avec un bouton par option et s'affiche au dashboard
(page Approvals + carte dans le fil des trois pages). Un clic résout la ligne avec le LIBELLÉ
choisi (validé contre les options de la ligne), le job reprend, la reprise rejoue l'appel
avec son `toolCallId` d'origine et `execute()` rend `{ answer, option_index }`. Décliner =
le marqueur `[REJECTED]` habituel. Une règle `auto_approve` explicite ou `fully_autonomous`
ne sautent PAS une question (plancher) ; `block` reste honoré.

## Mesuré

- Suites ciblées : tools 32 (ask-user 14, cards), runner 63 (approvals, telegram, flow), web
  23 ; suites complètes vertes (tools 909, web 1215, db 258, shared 470, delivery 190,
  orchestration 235, runner 1322 avec un `.pg.test.ts` de concurrence qui passe seul) ;
  `pnpm typecheck` 33/33 ; dependency-cruiser 0 ; lint 0 erreur.
- 10 mutations rouges puis restaurées : plancher retiré (auto_approve saute la question) ;
  `kind` toujours 'approval' ; réponse hors options acceptée par l'outil ; par la résolution ;
  réponse sur une approbation ordinaire ignorée ; index d'option non borné (Telegram) ; un ✅
  sur une question passe ; carte de question envoyée comme approbation ; question en attente
  qui ne se montre pas seule ; clic qui n'envoie pas le libellé.
- Migration 0098 appliquée sur la base dev (colonnes `kind`, `answer` présentes).

## Questions, par priorité

### P0 — ce qui casserait la reprise ou la sécurité

1. **La reprise.** `executeResolvedApprovals` (job/execute.ts) rejoue l'outil approuvé avec la
   règle synthétique `resume-bypass` ; pour `ask_user`, le plancher ignore cette règle et
   consulte `hasAnsweredQuestion(jobId, toolCallId, toolName, kind, status ∈ approved|rejected)`.
   Un chemin où la reprise rejoue l'appel SANS `toolCallId` (le marqueur d'attente sans id, un
   job d'avant l'étape D) → la question serait REPOSÉE (nouvelle ligne pending) — boucle ?
   Vérifier ce que `executeResolvedApprovals` fait d'un `req.toolCallId` NULL.
2. **Plusieurs questions dans un même tour** : la porte suspend au premier `awaiting_approval`
   et marque les suivants `[DEFERRED]` ; à la reprise, un second `ask_user` du même tour a-t-il
   sa propre ligne et son propre `toolCallId` ? Un scénario où deux questions partagent une
   ligne ou une réponse ?
3. **Sécurité des boutons** : Telegram/Discord/Slack — les gardes existantes (chat privé,
   propriétaire, même bot, même chat, `pending`) s'appliquent AVANT la branche `option` ? Un
   `o<n>` forgé depuis un autre chat peut-il répondre ? Un index négatif ou `o007` ?
4. **`answer` côté web** : `resolveApprovalAction` transporte `answer` au runner avec
   `WORKER_SECRET` ; la validation est dans `resolveApprovalDecision` (les options de la ligne)
   — le web ne fait qu'un `z.string().max(400)`. Rien à contourner ?

### P1 — ce qui donnerait un résultat faux

5. **Deux lignes `tool_calls` de même `toolCallId`** (l'appel suspendu `awaiting_approval`,
   puis l'appel rejoué `success`) : comment le fil les montre-t-il ? Une seule carte (la
   dernière) ou deux ? Regarder `job-feed.ts` / `conversation-feed.ts` pour les approbations
   ordinaires (`run_command` approuvé) : la même question s'y posait déjà.
6. **`ask_user` dans `ALWAYS_ON_TOOLS`** : tout agent peut poser une question, y compris un
   sous-agent délégué — la carte part alors dans la conversation du PROPRIÉTAIRE
   (`resolveChannelApprovalDeliveryTarget`) ; le fil du délégué (`/scheduled/<jobId>`) montre-t-il
   la carte ? Et un cron sans conversation : la question reste sur la page Approvals seulement ?
7. **Décliner depuis Discord/Slack n'est pas offert** (la carte ne porte que des options) alors
   que Telegram garde `r` : incohérence assumée par l'agent — acceptable, ou un bouton
   « Decline » sur les trois ?
8. **Le repli texte sans boutons (WhatsApp)** numérote les options mais rien ne lit un numéro
   dans un message entrant : limite dite. Un risque que l'utilisateur réponde « 2 » et que ce
   message relance un JOB (classifié comme demande) pendant que l'autre est suspendu ?
9. **`present()` sur la ligne suspendue** : `presented` NULL sur l'appel `awaiting_approval`
   (pas d'exécution), donc la carte lit `tool_input` (`readQuestionToolInput`) — et sur la
   ligne rejouée, `presented.answer`. Cohérent avec P1 (la carte est déclarée par l'outil) ?

### P2

10. Les textes de plateforme (`buildQuestionCardBody`, « Pick an option. », « Answered: … »)
    : invariant #2 respecté (la question et le contexte sont verbatim) ? Une phrase de trop ?
11. `OPTION_SUFFIX = /^o(\d{1,3})$/` : « `o012` » → index 12, fine ; est-ce dit ?

## Ce qui n'est PAS attendu

Le style, le nommage. Un constat désigne un fichier, une ligne, et ce qui casse.
