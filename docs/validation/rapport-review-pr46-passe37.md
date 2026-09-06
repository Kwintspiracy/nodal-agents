# Review PR #46 — passe 37

Revue statique du commit `5c7938a7` et de l’état courant. L’environnement en lecture seule a refusé l’exécution des tests ; tous les constats ci-dessous sont donc marqués comme déduits sans exécution.

## P0 — reprise et sécurité

### 1. Reprise sans `toolCallId`

**Constat P0 — déduit sans exécution.**  
[packages/tools/src/execute.ts:78](D:/APPS/NodalAI/packages/tools/src/execute.ts:78) et [apps/runner/src/job/execute.ts:1948](D:/APPS/NodalAI/apps/runner/src/job/execute.ts:1948)

Une ancienne ligne `approval_requests` approuvée avec `tool_call_id = NULL` ne peut pas reprendre `ask_user` :

1. `executeResolvedApprovals` rejoue l’outil sans identifiant.
2. `hasAnsweredQuestion` retourne systématiquement `false`.
3. La porte crée une nouvelle question, elle aussi sans `toolCallId`.
4. Le runner transforme le résultat en `unexpected_gate_on_approved_tool` et marque pourtant l’ancienne ligne `executed_at`.
5. La nouvelle ligne peut être répondue, mais sa reprise suit exactement le même chemin.

Le job peut donc produire une suite de questions sans identifiant qu’aucune réponse ne permet d’exécuter. C’est la boucle anticipée dans la demande.

### 2. Plusieurs questions dans le même tour

**Constat P0 — déduit sans exécution.**  
[apps/runner/src/job/execute.ts:3112](D:/APPS/NodalAI/apps/runner/src/job/execute.ts:3112), [apps/runner/src/job/execute.ts:3147](D:/APPS/NodalAI/apps/runner/src/job/execute.ts:3147), [apps/runner/src/job/execute.ts:3176](D:/APPS/NodalAI/apps/runner/src/job/execute.ts:3176) et [apps/runner/src/job/execute.ts:2032](D:/APPS/NodalAI/apps/runner/src/job/execute.ts:2032)

`wouldRequireApproval` ne tient compte que des règles et de `defaultApproval`. Il ignore `ToolDefinition.asksUser`. Comme `ask_user` est un outil `read` sans `defaultApproval`, deux questions émises avec d’autres lectures sont éligibles au pré-passage parallèle.

Scénario concret :

1. Le modèle émet `ask_user(call-A)` puis `ask_user(call-B)`.
2. Le pré-passage exécute les deux avant que `awaitingApproval` soit posé : deux lignes pending et deux notifications sont créées.
3. La boucle sérialisée conserve `[AWAITING_APPROVAL]` pour A et écrit `[DEFERRED]` pour B.
4. Si l’utilisateur répond à B en premier, `executeResolvedApprovals` rejoue B, puis cherche seulement le même `toolName` et un texte contenant `[AWAITING_APPROVAL]`.
5. Il remplace donc le résultat de A par la réponse de B ; le marqueur différé de B reste inchangé.
6. La ligne B est néanmoins marquée exécutée. La réponse est attribuée au mauvais appel et définitivement perdue pour B.

Chaque question possède bien sa ligne et son `toolCallId`, mais la suspension et la reprise ne les maintiennent pas isolées.

Le test bout en bout ajouté ne couvre qu’une question ; aucun test ne couvre plusieurs `ask_user` dans un même tour.

### 3. Sécurité des boutons

Aucun contournement relevé.

Les branches `option` arrivent après les gardes :

- Telegram : chat privé, bot propriétaire, conversation cible et statut pending aux lignes [146](D:/APPS/NodalAI/apps/runner/src/telegram/approval-callback.ts:146), [196](D:/APPS/NodalAI/apps/runner/src/telegram/approval-callback.ts:196), [202](D:/APPS/NodalAI/apps/runner/src/telegram/approval-callback.ts:202) et [209](D:/APPS/NodalAI/apps/runner/src/telegram/approval-callback.ts:209).
- Discord : DM, bot propriétaire, canal cible et pending aux lignes [151](D:/APPS/NodalAI/apps/runner/src/channels/discord/approval-callback.ts:151), [182](D:/APPS/NodalAI/apps/runner/src/channels/discord/approval-callback.ts:182), [188](D:/APPS/NodalAI/apps/runner/src/channels/discord/approval-callback.ts:188) et [193](D:/APPS/NodalAI/apps/runner/src/channels/discord/approval-callback.ts:193).
- Slack : mêmes gardes aux lignes [149](D:/APPS/NodalAI/apps/runner/src/channels/slack/approval-callback.ts:149), [180](D:/APPS/NodalAI/apps/runner/src/channels/slack/approval-callback.ts:180), [186](D:/APPS/NodalAI/apps/runner/src/channels/slack/approval-callback.ts:186) et [191](D:/APPS/NodalAI/apps/runner/src/channels/slack/approval-callback.ts:191).

`o-1` est rejeté par la regex. `o007` devient l’index 7, puis est rejeté puisque `ask_user` offre au plus six options.

### 4. `answer` côté web

Aucun contournement relevé.

[apps/web/src/lib/actions.ts:5856](D:/APPS/NodalAI/apps/web/src/lib/actions.ts:5856) ne fait que borner le transport, mais vérifie aussi l’appartenance de la demande à l’entité de la session. [apps/runner/src/approvals/resolve.ts:112](D:/APPS/NodalAI/apps/runner/src/approvals/resolve.ts:112) relit ensuite les options de la ligne et exige une égalité exacte avant l’écriture.

Le `WORKER_SECRET` ne permet donc pas au navigateur d’imposer une réponse arbitraire : seule l’action serveur possède ce secret.

## P1 — exactitude du résultat

### 5. Deux lignes `tool_calls` pour le même appel

Le fil n’affiche qu’une étape. [apps/web/src/lib/job-feed.ts:157](D:/APPS/NodalAI/apps/web/src/lib/job-feed.ts:157) charge les lignes par ordre croissant de création, puis [apps/web/src/lib/conversation-feed.ts:366](D:/APPS/NodalAI/apps/web/src/lib/conversation-feed.ts:366) les place dans une `Map` indexée par `toolCallId` : la dernière ligne écrase celle de suspension.

Cela vaut aussi pour les approbations ordinaires. Le test dédié le vérifie à [apps/web/src/lib/__tests__/conversation-feed-question.test.ts:207](D:/APPS/NodalAI/apps/web/src/lib/__tests__/conversation-feed-question.test.ts:207).

### 6. Sous-agent et cron

La livraison au propriétaire est cohérente : [apps/runner/src/approvals/notify.ts:340](D:/APPS/NodalAI/apps/runner/src/approvals/notify.ts:340) remonte la chaîne et choisit la conversation du propriétaire.

La carte reste attachée au job qui a posé la question : [apps/web/src/lib/job-feed.ts:191](D:/APPS/NodalAI/apps/web/src/lib/job-feed.ts:191) charge les questions par `jobId`. Elle apparaît donc dans le détail `/scheduled/<jobId>` du sous-agent.

Un cron sans conversation n’est pas limité à la page Approvals : si son transcript contient le bloc `tool-call`, son propre fil de job affiche également la carte. Seule la notification de canal peut manquer.

### 7. Décliner depuis Discord/Slack

Les trois cartes de canal ne proposent en réalité aucun bouton Decline :

- Telegram : [packages/delivery/src/channels/telegram-adapter.ts:165](D:/APPS/NodalAI/packages/delivery/src/channels/telegram-adapter.ts:165)
- Discord : [packages/delivery/src/channels/discord-adapter.ts:351](D:/APPS/NodalAI/packages/delivery/src/channels/discord-adapter.ts:351)
- Slack : [packages/delivery/src/channels/slack-adapter.ts:347](D:/APPS/NodalAI/packages/delivery/src/channels/slack-adapter.ts:347)

Telegram accepte encore un suffixe `r` forgé ou provenant d’une ancienne carte, mais ne l’affiche pas. La page web offre Decline. C’est donc une limitation uniforme des cartes de canal, pas une incohérence visible entre Telegram, Discord et Slack.

### 8. Repli WhatsApp

Oui, répondre « 2 » au message WhatsApp n’est pas rattaché à l’`approval_request`. Le mécanisme actuel peut traiter ce texte comme une nouvelle demande et créer un autre job pendant que le premier reste suspendu.

La limitation est explicitement assumée à [apps/runner/src/approvals/notify.ts:467](D:/APPS/NodalAI/apps/runner/src/approvals/notify.ts:467). Je ne la classe pas comme régression bloquante de P10a, puisque le message indique de répondre depuis le dashboard et ne prétend pas accepter le numéro.

### 9. `present()` et ligne suspendue

Cohérent.

La ligne suspendue n’a pas de sortie présentée ; la vue reconstruit la question depuis l’entrée validée. Après reprise, [packages/tools/src/builtin/ask-user.ts:119](D:/APPS/NodalAI/packages/tools/src/builtin/ask-user.ts:119) produit une charge `presented` contenant la réponse. Comme la dernière ligne d’audit l’emporte, la carte passe naturellement de la question en attente à la réponse retenue.

## P2

### 10. Textes de plateforme et invariant nº 2

**Constat P2 — déduit sans exécution.**  
[apps/runner/src/approvals/notify.ts:104](D:/APPS/NodalAI/apps/runner/src/approvals/notify.ts:104), [apps/runner/src/telegram/approval-callback.ts:264](D:/APPS/NodalAI/apps/runner/src/telegram/approval-callback.ts:264), [apps/runner/src/channels/discord/approval-callback.ts:227](D:/APPS/NodalAI/apps/runner/src/channels/discord/approval-callback.ts:227) et [apps/runner/src/channels/slack/approval-callback.ts:225](D:/APPS/NodalAI/apps/runner/src/channels/slack/approval-callback.ts:225)

Le commit ajoute dans le runner plusieurs textes présentés directement à l’utilisateur : « asks », « Tap an option… », « Pick an option » et « Answered: … ».

Cela contrevient littéralement à l’invariant nº 2 d’`AGENTS.md` : « No hardcoded user-facing text in runner. LLM speaks or runner stays silent. »

Scénario concret : un agent francophone pose une question en français ; la carte et les accusés du runner ajoutoutent des phrases anglaises qui ne viennent ni de l’agent ni de la base. La question et le contexte restent verbatim, mais la sortie complète ne respecte pas l’invariant.

### 11. `o012`

[apps/runner/src/telegram/approval-callback.ts:89](D:/APPS/NodalAI/apps/runner/src/telegram/approval-callback.ts:89) autorise un à trois chiffres, zéros initiaux compris. `o012` est donc lu comme l’index numérique 12. Ce comportement n’est pas indiqué explicitement, seulement déductible de la regex et de `Number()`.

Il ne permet toutefois pas de choisir une option : l’index 12 est hors limites pour les deux à six options et la branche retourne `unknown_option`.

## Éléments trouvés hors questions

Aucun constat supplémentaire distinct. Le défaut de pré-passage parallèle explique également pourquoi le commentaire de [apps/runner/src/job/execute.ts:2008](D:/APPS/NodalAI/apps/runner/src/job/execute.ts:2008), qui suppose au plus une approbation par outil et par tour, n’est plus vrai pour `ask_user`.

## Constats bloquants

- P0 — reprise impossible et potentiellement cyclique des questions historiques dont `toolCallId` est `NULL`.
- P0 — plusieurs `ask_user` d’un même tour peuvent être pré-exécutés en parallèle, puis leurs réponses être attribuées au mauvais appel ou perdues.
- P2 — nouveaux textes utilisateur codés en dur dans le runner, en violation de l’invariant nº 2.