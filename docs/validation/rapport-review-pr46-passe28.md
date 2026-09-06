Verdict : **faux**. Aucun bloquant, mais trois constats importants et deux mineurs.

## Constats

### Bloquant

Aucun.

### Important

1. [thread-history.ts:71](D:/APPS/NodalAI/apps/runner/src/job/thread-history.ts:71) — WhatsApp est absent de `CONVERSATIONAL_CHANNELS`.

   `loadThreadHistory()` retourne donc systématiquement `[]` pour WhatsApp à la ligne 164. Chaque message WhatsApp repart sans les tours précédents, alors que P6 présente WhatsApp comme une conversation persistante. Le commentaire de la ligne 325 affirme d’ailleurs, à tort, que WhatsApp figure dans cet ensemble.

2. `/new` ne fonctionne pas correctement dans les conversations de groupe hors Telegram.

   - [discord/handler.ts:109](D:/APPS/NodalAI/apps/runner/src/channels/discord/handler.ts:109) : `/new` n’est pas reconnu comme commande et est rejeté par `group_filter` ligne 110.
   - [whatsapp/handler.ts:87](D:/APPS/NodalAI/apps/runner/src/channels/whatsapp/handler.ts:87) : même problème ; la ligne 91 rejette `/new` sans mention.
   - [slack/handler.ts:173](D:/APPS/NodalAI/apps/runner/src/channels/slack/handler.ts:173) : le texte est préfixé par `[Message from …]:` avant l’appel à `parseNewConversationCommand()` ligne 180. Une mention Slack contenant `/new` devient donc un message ordinaire et n’ouvre rien.

   Seul Telegram traite `/new` avant ou dans le filtre de groupe. L’engagement « les quatre handlers : `/new` → `openNewConversation` » n’est pas tenu.

3. [conversation-id.ts:83](D:/APPS/NodalAI/apps/runner/src/job/conversation-id.ts:83) — la création implicite de la première conversation est sujette à une course.

   Deux messages simultanés peuvent tous deux constater l’absence de ligne puis exécuter `openNewConversation()` ligne 99. La migration ne pose qu’un index non unique sur le tuple. Deux conversations sont alors créées sans `/new`, et chaque job peut partir dans une conversation différente. Cela casse l’invariant « une conversation par chat jusqu’au geste explicite `/new` ».

   En outre, [conversation-id.ts:95](D:/APPS/NodalAI/apps/runner/src/job/conversation-id.ts:95) ne départage pas deux `created_at` égaux : après deux `/new` simultanés ou un backfill à dates identiques, la conversation courante devient indéterminée.

### Mineur

4. [attach.ts:228](D:/APPS/NodalAI/packages/tools/src/projects/attach.ts:228) — dans le cas `job: 'kept_existing'`, `projectId` désigne le projet ignoré, pas celui effectivement porté par le job.

   Le type expose donc un champ dont la signification change selon `job`. Un appelant lisant naturellement `projectId` comme le rattachement effectif obtient une information fausse. Aucun appelant actuel du périmètre ne semble exploiter l’issue, mais le contrat public est piégeux.

5. [attach.ts:218](D:/APPS/NodalAI/packages/tools/src/projects/attach.ts:218) — `conversation: 'set'` est rendu sans vérifier qu’une ligne a été mise à jour.

   L’`UPDATE` n’utilise pas `RETURNING`; une conversation absente ou appartenant à une autre entité produit zéro modification, puis la ligne 223 annonce tout de même `set`. Cela peut notamment arriver avec les UUID orphelins pré-P6 que le changement veut conserver.

## Réponse aux cinq doutes

1. **Tri par `created_at` : tient sur le choix du champ, faux sur l’ordre total.**

   `updated_at` serait effectivement incorrect : un ancien travail tardif pourrait reprendre la tête. Il faut conserver `created_at`, mais lui ajouter une règle qui sérialise/désigne réellement la conversation courante. Un simple second tri par UUID rendrait le résultat déterministe, sans dire lequel des deux `/new` concurrents est réellement le dernier.

2. **Compte dashboard “messages user − 1” : tient, CLI comprise.**

   [run-chat-turn.ts:236](D:/APPS/NodalAI/apps/runner/src/chat/run-chat-turn.ts:236) insère le message utilisateur avant la bifurcation vers le runtime CLI. `run-chat.ts` reçoit donc une conversation où le tour courant est déjà présent lorsqu’il appelle `loadConversationContext()` à la ligne 215. Le `−1` est correct sur les deux chemins dashboard.

3. **`/new` nu envoyé au modèle : faux comme contrat robuste.**

   « First turn » ne signifie pas « l’utilisateur vient d’exécuter `/new` » : un premier message naturel possède exactement le même contexte. Le modèle ne peut donc pas distinguer sûrement une commande de réinitialisation d’une demande littérale. Il faudrait transporter explicitement ce fait dans `ConversationContext` ou retirer la commande du message modèle sans fabriquer de texte utilisateur.

4. **Rattachement CLI seulement après un succès : faux pour représenter les productions réelles.**

   Une CLI peut modifier des fichiers puis sortir en erreur à cause des tests. Le registre omet alors une production réelle. Inversement, le succès en mode `write` ne prouve pas qu’un fichier a changé. `cli_runs.files_changed` **n’existe pas** : [cli-runs.ts:34](D:/APPS/NodalAI/packages/db/src/schema/cli-runs.ts:34) à 82 ne contient aucun champ de ce type. Il faut un signal pré/post-exécution ou un inventaire de changements fourni par le runtime.

5. **`kept_existing` avec le projet trouvé : faux.**

   Il faut exposer les deux identités, par exemple `keptProjectId` et `ignoredProjectId`, ou une variante discriminée propre à `kept_existing`. Le log seul ne rend pas l’API non ambiguë.

## Exécution

- Lecture ciblée du commit et des fichiers/tests du périmètre : effectuée.
- État du worktree vérifié ; les fichiers non committés P7 ont été exclus.
- Suites Vitest, typecheck, lint et dependency-cruiser : **NON EXÉCUTÉES** — environnement en lecture seule.

Ce n’est donc pas « rien de neuf ».