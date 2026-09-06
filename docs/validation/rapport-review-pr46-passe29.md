Verdict : **faux**. Aucun bloquant, trois constats importants et un mineur.

## Constats

### Bloquant

Aucun.

### Important

1. [chat-or-work.ts:148](D:/APPS/NodalAI/apps/web/src/lib/chat-or-work.ts:148) — les appels outils échoués ou bloqués sont classés comme des productions réussies.

   `classifyProduction()` ne reçoit ni `toolOutput` ni l’issue de l’appel. Une ligne `files`, `sent`, `terminal` ou `generic/write` suffit donc à produire un encart, même si `executeTool` l’a persistée avec `outcome: 'error'`, `blocked` ou `awaiting_approval`.

   Ce qui casse : un refus d’approbation d’écriture peut afficher « Produced » alors que rien n’est sorti du chat. Pour `files`, l’absence normale de `presented` sur l’échec devient même un fichier sans nom aux lignes 160–167.

   La requête qui perd l’information est dans [conversation-actions.ts:385](D:/APPS/NodalAI/apps/web/src/lib/conversation-actions.ts:385). Les tests de classement ne couvrent aucun outcome d’échec.

2. [conversation-actions.ts:334](D:/APPS/NodalAI/apps/web/src/lib/conversation-actions.ts:334) — les plafonds conservent le début du fil et masquent définitivement ses tours récents.

   Les messages sont triés chronologiquement puis limités à 500 aux lignes 343–346 ; les jobs de tête suivent la même logique avec une limite de 100 aux lignes 347–359.

   Ce qui casse : dès le 101e tour d’un canal, `/chat/[id]` reste figé sur les 100 premiers jobs. Pour le dashboard, les messages au-delà du 500e disparaissent. Le fil ne montre donc plus la conversation actuelle. Il faut sélectionner les N plus récents puis les remettre dans l’ordre chronologique pour l’affichage.

3. [conversation-actions.ts:615](D:/APPS/NodalAI/apps/web/src/lib/conversation-actions.ts:615) — `canReply` autorise toute conversation dashboard, même si elle appartient à un ancien ROOT ou à un autre agent.

   `sendChatMessageAction` résout ensuite systématiquement le ROOT actuel dans [actions.ts:11215](D:/APPS/NodalAI/apps/web/src/lib/actions.ts:11215). Le runner vérifie seulement que la conversation et le ROOT appartiennent à l’entité ; il ne vérifie pas que `conversations.agent_id` correspond à l’agent demandé ([run-chat-turn.ts:255](D:/APPS/NodalAI/apps/runner/src/chat/run-chat-turn.ts:255)).

   Ce qui casse : répondre dans l’ancien fil de l’agent A après avoir désigné B comme ROOT écrit des messages de B dans la conversation de A et exécute B avec l’historique de A. C’est un cas réel dès qu’un ROOT change.

### Mineur

4. [chat-or-work.ts:165](D:/APPS/NodalAI/apps/web/src/lib/chat-or-work.ts:165) — les cartes `files` sans charge utile échappent au plafond de huit fichiers.

   Cette branche ajoute un fichier sans incrémenter `files`. Dix lignes `files` sans `presented` produisent donc dix entrées au lieu de huit plus « and 2 more files ».

   Ce qui casse : l’encart n’applique pas le plafond annoncé aux fichiers anonymes. Ce défaut amplifie notamment le constat 1 pour les appels échoués.

## Réponse aux cinq doutes

1. **Titre gardant `[Message from …]:` : faux comme titre utilisateur.**

   Ce préfixe est utile dans la tâche remise à l’agent, mais pas dans le titre du fil. Il faut le retirer lors de la dérivation du titre, sans modifier la tâche auditée.

   La correction doit couvrir :

   - `touchConversation` pour les nouveaux titres ;
   - les données déjà créées par 0094, via une nouvelle migration corrective puisque 0094 a déjà été appliquée ;
   - idéalement le repli `firstRequest` de la liste, afin que les conversations encore sans titre soient cohérentes.

2. **Jusqu’à 300 requêtes lancées par `Promise.all` : problème réel, pas seulement optimisation hypothétique.**

   [conversation-actions.ts:373](D:/APPS/NodalAI/apps/web/src/lib/conversation-actions.ts:373) instancie jusqu’à 100 `assembleJobFeed`, chacun lançant trois requêtes en parallèle dans [job-feed.ts:106](D:/APPS/NodalAI/apps/web/src/lib/job-feed.ts:106). Le pool limite probablement les requêtes réellement exécutées simultanément, mais il ne supprime ni les 300 requêtes ni leur mise en attente.

   Au plafond officiellement pris en charge, c’est un N+1 massif sur une simple page. Il faut charger enfants, appels outils et appels LLM en trois requêtes groupées sur les 100 IDs, puis répartir en mémoire.

3. **Demande utilisateur + accusé + handoff : tient.**

   Le `handoff` n’est pas l’accusé : il montre la consigne exacte effectivement donnée au job. C’est une information d’audit utile lorsqu’une reformulation a déformé la demande. Son affichage replié limite suffisamment le doublon. Je le conserverais.

4. **`canReply` sans vérification du ROOT : faux, cas réel.**

   Le changement de ROOT suffit à le déclencher. `canReply` doit au minimum exiger `channel === 'dashboard' && conversation.agentId === rootAgentId`. Cette concordance doit aussi être vérifiée côté action ou runner, pas uniquement dans l’interface.

5. **Les lignes anciennes sans carte sont silencieusement du chat : faux pour une interface qui prétend classer la production.**

   L’absence de carte ne prouve pas « chat » pour les lignes antérieures à P1. Il faut un avis neutre du type « Older activity cannot be classified », sans créer d’encart « Produced ». L’information peut être affichée seulement lorsqu’une ligne sans carte est réellement présente, afin de ne pas polluer les conversations anciennes sans appels outils.

## Vérification des six corrections de `8ab609f1`

1. **Historique WhatsApp : tient.**

   `whatsapp` figure désormais dans `CONVERSATIONAL_CHANNELS` à [thread-history.ts:81](D:/APPS/NodalAI/apps/runner/src/job/thread-history.ts:81).

2. **`/new` avant le préfixe sur les quatre handlers, avec `/new` nu conservé : tient.**

   Telegram, Slack, Discord et WhatsApp analysent la commande avant d’ajouter le préfixe de groupe. La condition exclut correctement le préfixe pour un `/new` nu, qui reste exactement `/new`.

3. **Première conversation sérialisée, ordre total et `openedByCommand` : tient.**

   Le verrou transactionnel est pris à [conversation-id.ts:103](D:/APPS/NodalAI/apps/runner/src/job/conversation-id.ts:103), les handlers transmettent leur transaction, et le tri est bien `created_at DESC, id DESC` aux lignes 105–117. `openedByCommand` distingue le `/new` nu au premier tour aux lignes 234–240.

4. **Issue de rattachement explicite : tient.**

   `jobProjectId` expose le projet réellement conservé et `.returning()` distingue `conversation: 'not_found'` dans [attach.ts:236](D:/APPS/NodalAI/packages/tools/src/projects/attach.ts:236).

5. **Rattachement d’un tour CLI en erreur ayant écrit : tient.**

   `harnessWrote` borne la recherche au job, aux outils d’édition partagés et au début du tour dans [run-job.ts:147](D:/APPS/NodalAI/apps/runner/src/cli-runtime/run-job.ts:147). La branche d’erreur rattache lorsque ce signal existe aux lignes 511–514.

6. **Directive `/new` dans le prompt : tient.**

   `openedByCommand` est transporté dans `ConversationContext` et ajoute explicitement que le message ne porte aucune demande dans [system-prompt.ts:412](D:/APPS/NodalAI/packages/orchestration/src/system-prompt.ts:412).

## Exécution et périmètre

- Lecture statique des deux commits et de leurs tests : effectuée.
- Worktree vérifié : les fichiers non committés `_render-harness.test.tsx` et la demande de revue ont été exclus de la revue.
- Suites Vitest, typecheck, lint, dependency-cruiser et tests d’intégration : **NON EXÉCUTÉS** — sandbox en lecture seule.
- Validation avec une base PostgreSQL et mesure du pool : **NON EXÉCUTÉES**.

**« Rien de neuf » : non.** Les quatre constats ci-dessus sont nouveaux par rapport à la passe 28.