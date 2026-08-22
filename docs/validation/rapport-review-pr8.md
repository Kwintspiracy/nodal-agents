Verdict global : le bug initial est réel, mais le correctif est incomplet et introduit un prompt contradictoire pour Claude Code. La PR ne doit pas être validée en l’état.

## Constats bloquants

### 1. Le bloc équipe annonce des outils de délégation inexistants

- Fichier : `packages/orchestration/src/team-block.ts`
- Lignes : 235–260
- Appel : `packages/orchestration/src/system-prompt.ts:405-416`

`buildTeamBlock` ordonne à l’agent d’utiliser `assign_<agent>`, `create_task`, `list_tasks` et `return_result`. Une session Claude Code lancée par `runClaudeTurn` ne reçoit aucun de ces outils Nodal.

Ce qui casse concrètement : l’orchestrateur voit désormais ses sous-agents, mais ne peut pas les appeler. Il est explicitement invité à émettre des tool calls inconnus. Le symptôme principal que la PR prétend corriger — déléguer aux agents rattachés en base — reste donc non fonctionnel sur la surface CLI.

Verdict : « `cli-runtime` retire trop peu ».

### 2. Le bloc skills est inutilisable sur la surface CLI

- Fichier : `packages/orchestration/src/system-prompt.ts`
- Lignes : 513–526
- Inclusion : `packages/orchestration/src/system-prompt.ts:635`

Chaque skill est présenté sous la forme `skill_view('<slug>')`, puis le prompt impose d’appeler `skill_view` et `run_skill_script`. Ces deux outils appartiennent au runtime Nodal et ne sont pas exposés à Claude Code.

Ce qui casse concrètement : dès qu’un skill paraît pertinent, l’agent est obligé par son prompt d’appeler un outil absent avant d’agir. Il ne peut pas charger les instructions du skill et peut soit échouer, soit refuser d’avancer parce que l’étape déclarée obligatoire est impossible.

Verdict : le cas soupçonné dans la demande est confirmé.

### 3. Le baseline impose les outils mémoire Nodal absents

- Fichier : `packages/orchestration/src/agent-baseline.ts`
- Lignes : 46–55
- Inclusion : `packages/orchestration/src/system-prompt.ts:587`

Le baseline impose `mark_memory_outdated` et `save_memory`. Pour les workers, il impose également de sauvegarder les découvertes avant de terminer.

Le bloc mémoire lui-même mentionne aussi `query_memory` :

- Fichier : `packages/orchestration/src/system-prompt.ts`
- Lignes : 264–271

Ce qui casse concrètement : un agent CLI qui découvre une mémoire erronée ou une information durable reçoit une obligation impossible à satisfaire. Il ne peut ni invalider ni enregistrer la mémoire, alors que le prompt lui dit « MUST ».

Verdict : « `cli-runtime` retire trop peu ».

### 4. Le bloc workspace documente la mauvaise API de fichiers

- Fichier : `packages/orchestration/src/system-prompt.ts`
- Lignes : 295–313
- Inclusion : `packages/orchestration/src/system-prompt.ts:566`

Le bloc décrit `file_read`, `file_write`, `file_edit`, `file_list` et `file_search`, ainsi qu’une syntaxe propre aux labels de workspaces Nodal. Claude Code dispose de `Read`, `Write`, `Edit`, `Glob`, `Grep` et `Bash`, pas de cette API.

Ce qui casse concrètement : l’agent est orienté vers des noms d’outils inexistants. Avec plusieurs workspaces, il peut également interpréter `label/chemin` comme un vrai chemin relatif au `cwd`, alors que cette résolution par label est assurée par les builtins Nodal, pas par le système de fichiers de Claude Code.

Le chemin absolu fourni reste une information utile, mais les instructions opérationnelles qui l’accompagnent sont fausses pour cette surface.

### 5. Le chemin job perd une grande partie du `JobContext`

- Appel CLI : `apps/runner/src/cli-runtime/run-job.ts`
- Lignes : 181–186
- Construction complète, chemin Nodal : `apps/runner/src/job/execute.ts`
- Lignes : 1054–1086
- Dérivation trop précoce vers le CLI : `apps/runner/src/job/execute.ts:906-928`

Le chemin CLI ne transmet que `origin`, `task` et éventuellement `telegramChatId`. Le chemin normal calcule aussi :

- `notifyOnSuccess`
- `isDelegated`
- `triggerContext`
- `workspaceInventory`
- `deployment`

La dérivation CLI arrive avant même le calcul de ces valeurs.

Ce qui casse concrètement :

- un worker CLI délégué ne reçoit pas la règle empêchant une livraison directe et peut doubler la réponse de l’orchestrateur ;
- un cron/webhook CLI ne reçoit pas l’intention `notify_on_success` ;
- il ne reçoit pas les informations de déclenchement ;
- il ne reçoit pas l’inventaire du workspace partagé ;
- il ne reçoit pas la réalité du déploiement local, réseau ou conteneur.

Les deux chemins ne sont donc pas alignés.

### 6. Le chat CLI perd lui aussi le contexte de déploiement

- Appel CLI : `apps/runner/src/cli-runtime/run-chat.ts`
- Lignes : 121–125
- Appel chat normal : `apps/runner/src/chat/run-chat-turn.ts`
- Lignes : 326–332

Le chat normal appelle `getDeploymentContext` et passe `deployment`. Le chat CLI ne le fait pas.

Ce qui casse concrètement : deux agents utilisés depuis le même chat reçoivent des descriptions différentes de leur environnement selon leur runtime. L’agent CLI ne sait pas, via le prompt Nodal, s’il tourne en loopback, sur le LAN ou dans un conteneur.

### 7. Le test ne couvre aucun des deux câblages qu’il affirme couvrir

- Fichier : `packages/orchestration/src/tests/cli-runtime-surface.test.ts`
- Lignes : 13, 18, 53–121

Le commentaire ligne 13 affirme que le câblage est vérifié dans `apps/runner`, mais aucune occurrence de `buildSystemPrompt` n’existe dans les tests du runner pour `run-job.ts` ou `run-chat.ts`. Ce fichier importe uniquement `buildSystemPrompt` et ne charge aucun appelant du runner.

Résultat des mutations demandées :

| Mutation | Résultat |
|---|---|
| Retirer `cli-runtime` de la condition du builtin | Rougit grâce à l’assertion lignes 89–95 |
| Repasser `run-chat.ts` à `agentRow.personality` | Reste verte |
| Repasser `run-job.ts` à `agentRow.personality` | Reste verte |

Ce qui casse concrètement : les deux régressions exactes que cette PR corrige peuvent être réintroduites sans faire échouer le nouveau test.

Je n’ai pas modifié les fichiers pour exécuter matériellement ces mutations, conformément à la contrainte de lecture seule. Le résultat est néanmoins déterministe : aucun des deux fichiers mutés n’est importé ou exercé par ce test.

## Vérifications complémentaires

- Aucun troisième appelant de `runClaudeTurn` n’a été trouvé dans `apps/runner/src`. Les deux seuls appelants sont `cli-runtime/run-job.ts:195` et `cli-runtime/run-chat.ts:129`.
- L’absence de `jobId` côté chat ne crée pas à elle seule de bloc vide : `buildSystemPrompt` n’accepte ni ne consulte de `jobId`. La mémoire est correctement classée à partir de `task`, qui est fournie par le chat.
- Retirer le bloc `Built-in capabilities` ne retire pas d’information non liée aux outils : `system-prompt.ts:281-283` montre que ce bloc est uniquement un catalogue des builtins. Sur ce point précis, la PR ne retire pas trop.
- `'chat'` et `'cli-runtime'` ne sont pas réellement équivalents : le bloc de contexte du chat ajoute des instructions spécifiques à `run_task` dans `system-prompt.ts:197-220`, tandis que `cli-runtime` ne le fait pas. Leur seul comportement commun est l’omission du catalogue builtin ; les fusionner en une surface unique serait donc incorrect.
- La « posture git » annoncée dans `apps/runner/src/cli-runtime/run-job.ts:176` et `system-prompt.ts:558` n’existe pas dans `buildSystemPrompt`. Aucun bloc git n’y est assemblé. Claude Code peut inspecter le dépôt grâce à son `cwd` et à Bash, mais ce n’est pas une information fournie par ce prompt.

## Coût

La mesure avant/après sur un agent réel n’est pas reproductible depuis cette revue en lecture seule sans accès à une base d’application peuplée. Je ne fournis donc pas de chiffre inventé.

Le coût est cependant payé à chaque appel : `run-chat.ts:121` et `run-job.ts:181` reconstruisent le prompt complet avant chaque reprise de session. Le marqueur de cache mentionné dans `system-prompt.ts:622-660` concerne les fournisseurs du runtime Nodal ; rien dans `runClaudeTurn` ne démontre que Claude Code exploite ce découpage comme cache de prompt. La PR n’apporte donc ni mesure ni garantie d’amortissement sur les reprises.
tokens used
107,870
Verdict global : le bug initial est réel, mais le correctif est incomplet et introduit un prompt contradictoire pour Claude Code. La PR ne doit pas être validée en l’état.

## Constats bloquants

### 1. Le bloc équipe annonce des outils de délégation inexistants

- Fichier : `packages/orchestration/src/team-block.ts`
- Lignes : 235–260
- Appel : `packages/orchestration/src/system-prompt.ts:405-416`

`buildTeamBlock` ordonne à l’agent d’utiliser `assign_<agent>`, `create_task`, `list_tasks` et `return_result`. Une session Claude Code lancée par `runClaudeTurn` ne reçoit aucun de ces outils Nodal.

Ce qui casse concrètement : l’orchestrateur voit désormais ses sous-agents, mais ne peut pas les appeler. Il est explicitement invité à émettre des tool calls inconnus. Le symptôme principal que la PR prétend corriger — déléguer aux agents rattachés en base — reste donc non fonctionnel sur la surface CLI.

Verdict : « `cli-runtime` retire trop peu ».

### 2. Le bloc skills est inutilisable sur la surface CLI

- Fichier : `packages/orchestration/src/system-prompt.ts`
- Lignes : 513–526
- Inclusion : `packages/orchestration/src/system-prompt.ts:635`

Chaque skill est présenté sous la forme `skill_view('<slug>')`, puis le prompt impose d’appeler `skill_view` et `run_skill_script`. Ces deux outils appartiennent au runtime Nodal et ne sont pas exposés à Claude Code.

Ce qui casse concrètement : dès qu’un skill paraît pertinent, l’agent est obligé par son prompt d’appeler un outil absent avant d’agir. Il ne peut pas charger les instructions du skill et peut soit échouer, soit refuser d’avancer parce que l’étape déclarée obligatoire est impossible.

Verdict : le cas soupçonné dans la demande est confirmé.

### 3. Le baseline impose les outils mémoire Nodal absents

- Fichier : `packages/orchestration/src/agent-baseline.ts`
- Lignes : 46–55
- Inclusion : `packages/orchestration/src/system-prompt.ts:587`

Le baseline impose `mark_memory_outdated` et `save_memory`. Pour les workers, il impose également de sauvegarder les découvertes avant de terminer.

Le bloc mémoire lui-même mentionne aussi `query_memory` :

- Fichier : `packages/orchestration/src/system-prompt.ts`
- Lignes : 264–271

Ce qui casse concrètement : un agent CLI qui découvre une mémoire erronée ou une information durable reçoit une obligation impossible à satisfaire. Il ne peut ni invalider ni enregistrer la mémoire, alors que le prompt lui dit « MUST ».

Verdict : « `cli-runtime` retire trop peu ».

### 4. Le bloc workspace documente la mauvaise API de fichiers

- Fichier : `packages/orchestration/src/system-prompt.ts`
- Lignes : 295–313
- Inclusion : `packages/orchestration/src/system-prompt.ts:566`

Le bloc décrit `file_read`, `file_write`, `file_edit`, `file_list` et `file_search`, ainsi qu’une syntaxe propre aux labels de workspaces Nodal. Claude Code dispose de `Read`, `Write`, `Edit`, `Glob`, `Grep` et `Bash`, pas de cette API.

Ce qui casse concrètement : l’agent est orienté vers des noms d’outils inexistants. Avec plusieurs workspaces, il peut également interpréter `label/chemin` comme un vrai chemin relatif au `cwd`, alors que cette résolution par label est assurée par les builtins Nodal, pas par le système de fichiers de Claude Code.

Le chemin absolu fourni reste une information utile, mais les instructions opérationnelles qui l’accompagnent sont fausses pour cette surface.

### 5. Le chemin job perd une grande partie du `JobContext`

- Appel CLI : `apps/runner/src/cli-runtime/run-job.ts`
- Lignes : 181–186
- Construction complète, chemin Nodal : `apps/runner/src/job/execute.ts`
- Lignes : 1054–1086
- Dérivation trop précoce vers le CLI : `apps/runner/src/job/execute.ts:906-928`

Le chemin CLI ne transmet que `origin`, `task` et éventuellement `telegramChatId`. Le chemin normal calcule aussi :

- `notifyOnSuccess`
- `isDelegated`
- `triggerContext`
- `workspaceInventory`
- `deployment`

La dérivation CLI arrive avant même le calcul de ces valeurs.

Ce qui casse concrètement :

- un worker CLI délégué ne reçoit pas la règle empêchant une livraison directe et peut doubler la réponse de l’orchestrateur ;
- un cron/webhook CLI ne reçoit pas l’intention `notify_on_success` ;
- il ne reçoit pas les informations de déclenchement ;
- il ne reçoit pas l’inventaire du workspace partagé ;
- il ne reçoit pas la réalité du déploiement local, réseau ou conteneur.

Les deux chemins ne sont donc pas alignés.

### 6. Le chat CLI perd lui aussi le contexte de déploiement

- Appel CLI : `apps/runner/src/cli-runtime/run-chat.ts`
- Lignes : 121–125
- Appel chat normal : `apps/runner/src/chat/run-chat-turn.ts`
- Lignes : 326–332

Le chat normal appelle `getDeploymentContext` et passe `deployment`. Le chat CLI ne le fait pas.

Ce qui casse concrètement : deux agents utilisés depuis le même chat reçoivent des descriptions différentes de leur environnement selon leur runtime. L’agent CLI ne sait pas, via le prompt Nodal, s’il tourne en loopback, sur le LAN ou dans un conteneur.

### 7. Le test ne couvre aucun des deux câblages qu’il affirme couvrir

- Fichier : `packages/orchestration/src/tests/cli-runtime-surface.test.ts`
- Lignes : 13, 18, 53–121

Le commentaire ligne 13 affirme que le câblage est vérifié dans `apps/runner`, mais aucune occurrence de `buildSystemPrompt` n’existe dans les tests du runner pour `run-job.ts` ou `run-chat.ts`. Ce fichier importe uniquement `buildSystemPrompt` et ne charge aucun appelant du runner.

Résultat des mutations demandées :

| Mutation | Résultat |
|---|---|
| Retirer `cli-runtime` de la condition du builtin | Rougit grâce à l’assertion lignes 89–95 |
| Repasser `run-chat.ts` à `agentRow.personality` | Reste verte |
| Repasser `run-job.ts` à `agentRow.personality` | Reste verte |

Ce qui casse concrètement : les deux régressions exactes que cette PR corrige peuvent être réintroduites sans faire échouer le nouveau test.

Je n’ai pas modifié les fichiers pour exécuter matériellement ces mutations, conformément à la contrainte de lecture seule. Le résultat est néanmoins déterministe : aucun des deux fichiers mutés n’est importé ou exercé par ce test.

## Vérifications complémentaires

- Aucun troisième appelant de `runClaudeTurn` n’a été trouvé dans `apps/runner/src`. Les deux seuls appelants sont `cli-runtime/run-job.ts:195` et `cli-runtime/run-chat.ts:129`.
- L’absence de `jobId` côté chat ne crée pas à elle seule de bloc vide : `buildSystemPrompt` n’accepte ni ne consulte de `jobId`. La mémoire est correctement classée à partir de `task`, qui est fournie par le chat.
- Retirer le bloc `Built-in capabilities` ne retire pas d’information non liée aux outils : `system-prompt.ts:281-283` montre que ce bloc est uniquement un catalogue des builtins. Sur ce point précis, la PR ne retire pas trop.
- `'chat'` et `'cli-runtime'` ne sont pas réellement équivalents : le bloc de contexte du chat ajoute des instructions spécifiques à `run_task` dans `system-prompt.ts:197-220`, tandis que `cli-runtime` ne le fait pas. Leur seul comportement commun est l’omission du catalogue builtin ; les fusionner en une surface unique serait donc incorrect.
- La « posture git » annoncée dans `apps/runner/src/cli-runtime/run-job.ts:176` et `system-prompt.ts:558` n’existe pas dans `buildSystemPrompt`. Aucun bloc git n’y est assemblé. Claude Code peut inspecter le dépôt grâce à son `cwd` et à Bash, mais ce n’est pas une information fournie par ce prompt.

## Coût

La mesure avant/après sur un agent réel n’est pas reproductible depuis cette revue en lecture seule sans accès à une base d’application peuplée. Je ne fournis donc pas de chiffre inventé.

Le coût est cependant payé à chaque appel : `run-chat.ts:121` et `run-job.ts:181` reconstruisent le prompt complet avant chaque reprise de session. Le marqueur de cache mentionné dans `system-prompt.ts:622-660` concerne les fournisseurs du runtime Nodal ; rien dans `runClaudeTurn` ne démontre que Claude Code exploite ce découpage comme cache de prompt. La PR n’apporte donc ni mesure ni garantie d’amortissement sur les reprises.
