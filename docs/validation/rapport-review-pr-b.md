# Rapport de review - PR B

tokens used
114,263
## Rapport de review — PR B (`fix/cli-naming` → `main`)

Verdict : **CHANGEMENTS DEMANDÉS**.

La PR ne change effectivement que du texte et des commentaires. En revanche, la nouvelle bannière contient plusieurs affirmations fausses ou trop absolues.

### Constats bloquants

#### P1 — La bannière affirme recevoir l’état du dépôt, mais le runtime CLI ne le transmet jamais

- Bannière : [AgentComposer.tsx:990](</D:/APPS/NodalAI/apps/web/src/app/(dashboard)/agents/[id]/edit/AgentComposer.tsx:990>)
- Construction conditionnelle du bloc Git : [system-prompt.ts:761](</D:/APPS/NodalAI/packages/orchestration/src/system-prompt.ts:761>)
- Appel runtime job sans `workspaceGit` : [run-job.ts:189](</D:/APPS/NodalAI/apps/runner/src/cli-runtime/run-job.ts:189>)
- Appel runtime chat sans `workspaceGit` : [run-chat.ts:124](</D:/APPS/NodalAI/apps/runner/src/cli-runtime/run-chat.ts:124>)

`buildSystemPrompt` ne rend le bloc Git que lorsque `jobContext.workspaceGit` existe. Les deux chemins `cli-runtime` lui passent seulement l’origine, la surface, la tâche et éventuellement le chat Telegram.

Ce qui casse concrètement : la bannière promet que Nodal fournit la branche, le HEAD et l’état dirty du dépôt, alors qu’aucune session runtime — job ou chat — ne les reçoit par ce chemin. Claude Code peut éventuellement exécuter lui-même `git status`, mais ce n’est pas ce que la bannière affirme.

Ce n’est donc pas seulement le cas conditionnel « hors dépôt » évoqué dans la demande : **sur cette branche, le câblage runtime n’envoie jamais la sonde Git**.

#### P1 — « Skills, connecteurs et MCP non reçus » est faux comme description du prompt

- Négation dans la bannière : [AgentComposer.tsx:992](</D:/APPS/NodalAI/apps/web/src/app/(dashboard)/agents/[id]/edit/AgentComposer.tsx:992>)
- Construction systématique de la découvrabilité : [system-prompt.ts:684](</D:/APPS/NodalAI/packages/orchestration/src/system-prompt.ts:684>)
- Injection dans le prompt : [system-prompt.ts:731](</D:/APPS/NodalAI/packages/orchestration/src/system-prompt.ts:731>)
- Skills non assignés listés : [agent-baseline.ts:181](</D:/APPS/NodalAI/packages/orchestration/src/agent-baseline.ts:181>)
- Connecteurs et MCP configurés mais non assignés listés : [agent-baseline.ts:187](</D:/APPS/NodalAI/packages/orchestration/src/agent-baseline.ts:187>)
- Inventaires des connecteurs des coéquipiers : [team-block.ts:121](</D:/APPS/NodalAI/packages/orchestration/src/team-block.ts:121>)
- Inventaires MCP des coéquipiers : [team-block.ts:153](</D:/APPS/NodalAI/packages/orchestration/src/team-block.ts:153>)

Il est vrai que le runtime ne reçoit ni le contenu des skills assignés, ni les outils opérationnels des connecteurs/MCP de l’agent. Mais il peut recevoir :

- les skills disponibles qu’il pourrait demander ;
- les connecteurs et MCP configurés dans le workspace ;
- les skills, connecteurs et MCP de ses coéquipiers dans le roster.

Ce qui casse concrètement : « does not receive … skills, connectors, MCP servers » décrit faussement le contenu réel du prompt. La phrase suivante — « changing those here would have no effect » — est également trop forte : assigner un skill, connecteur ou MCP modifie les ensembles utilisés par `buildDiscoverabilityBlock`, donc peut modifier ce que le prochain prompt affiche ou supprime.

La formulation devrait distinguer clairement **absence d’accès opérationnel** et **présence d’informations descriptives dans le prompt**.

### Constat important

#### P2 — L’intitulé « on the Tools tab » ne pointe pas vers l’intitulé croisé annoncé

- Renvoi : [AgentComposer.tsx:3744](</D:/APPS/NodalAI/apps/web/src/app/(dashboard)/agents/[id]/edit/AgentComposer.tsx:3744>)
- Intitulé « Call a coding CLI (tool) » : [AgentComposer.tsx:2112](</D:/APPS/NodalAI/apps/web/src/app/(dashboard)/agents/[id]/edit/AgentComposer.tsx:2112>)
- Ce composant est rendu dans `AutonomyTab` : [AgentComposer.tsx:1773](</D:/APPS/NodalAI/apps/web/src/app/(dashboard)/agents/[id]/edit/AgentComposer.tsx:1773>)
- L’onglet Tools contient seulement la capacité et ses réglages fournisseur : [AgentComposer.tsx:603](</D:/APPS/NodalAI/apps/web/src/app/(dashboard)/agents/[id]/edit/AgentComposer.tsx:603>), [ToolsTabContent.tsx:203](</D:/APPS/NodalAI/apps/web/src/app/(dashboard)/agents/[id]/edit/ToolsTabContent.tsx:203>)

L’accès à `code_task` et ses valeurs par fournisseur sont bien dans Tools, mais l’intitulé croisé nouvellement créé, « Call a coding CLI (tool) », se trouve dans Autonomy.

Ce qui casse concrètement : un utilisateur qui cherche textuellement l’autre mode sur Tools ne trouve pas l’intitulé promis. Il y trouve le groupe `code-task`, tandis que la carte portant ce nom est ailleurs.

### Vérification détaillée de la bannière

| Affirmation | Verdict | Justification |
|---|---|---|
| Reçoit son identité | **VRAI** | Ligne d’identité composée depuis `agent.name` dans [system-prompt.ts:432](</D:/APPS/NodalAI/packages/orchestration/src/system-prompt.ts:432>). Le runtime transmet désormais un `Agent` complet. |
| Reçoit sa personnalité | **VRAI** | `agent.personality` est concaténée directement dans [system-prompt.ts:438](</D:/APPS/NodalAI/packages/orchestration/src/system-prompt.ts:438>). |
| Reçoit ses faits mémoire | **CONDITIONNEL, donc formulation trompeuse** | Le bloc est vide sans entité, sans fait sélectionné ou avec un budget ne laissant passer aucun fait : [system-prompt.ts:656](</D:/APPS/NodalAI/packages/orchestration/src/system-prompt.ts:656>). Un agent sans mémoire ne « reçoit » aucun bloc mémoire. |
| Reçoit les chemins absolus de ses workspaces | **VRAI pendant une exécution réussie, conditionnel dans l’UI** | Les chemins saisis par l’UI doivent être absolus : [actions.ts:1164](</D:/APPS/NodalAI/apps/web/src/lib/actions.ts:1164>). Le runtime refuse de démarrer sans workspace : [run-job.ts:91](</D:/APPS/NodalAI/apps/runner/src/cli-runtime/run-job.ts:91>), [run-chat.ts:56](</D:/APPS/NodalAI/apps/runner/src/cli-runtime/run-chat.ts:56>). La bannière reste néanmoins atteignable avant qu’un workspace existe. |
| Reçoit l’état du dépôt | **FAUX** | Aucun des deux appels runtime ne fournit `workspaceGit`. Voir constat P1. |
| Reçoit la liste de ses coéquipiers | **CONDITIONNEL mais sémantiquement acceptable** | `buildTeamBlock` renvoie une chaîne vide sans enfant actif : [team-block.ts:72](</D:/APPS/NodalAI/packages/orchestration/src/team-block.ts:72>). Avec des coéquipiers, le roster est bien injecté. |
| Ne reçoit pas les outils Nodal | **VRAI pour l’accès opérationnel** | Le bloc des builtins est supprimé sur `cli-runtime` : [system-prompt.ts:639](</D:/APPS/NodalAI/packages/orchestration/src/system-prompt.ts:639>). |
| Ne reçoit pas les skills | **FAUX au sens littéral** | Le contenu des skills assignés est supprimé, mais des informations de skills peuvent arriver via la découvrabilité et le roster. |
| Ne reçoit pas les connecteurs | **FAUX au sens littéral** | Pas d’outils de connecteur, mais des métadonnées de connecteurs peuvent être injectées. |
| Ne reçoit pas les serveurs MCP | **FAUX au sens littéral** | Pas de configuration MCP Nodal transmise, mais des métadonnées MCP peuvent être injectées. |
| Ne reçoit pas les approbations par outil | **VRAI** | Aucune règle `approvalRules` n’est injectée dans le prompt ni transformée en outils du runtime. |
| Ne peut pas déléguer à ses coéquipiers | **VRAI pour Nodal** | Le roster est construit avec `delegation: false` : [system-prompt.ts:462](</D:/APPS/NodalAI/packages/orchestration/src/system-prompt.ts:462>). Aucun outil Nodal de délégation n’est raccordé. |
| Le CLI ne pourrait déléguer par un autre mécanisme propre | **NON VÉRIFIÉ** | Le code prouve l’absence de pont vers la délégation Nodal. Il ne permet pas d’exclure toute capacité externe installée ou future du CLI lui-même. |

### Exactitude des nouveaux intitulés

1. **« Call a coding CLI (tool) » — VRAI.**  
   `code_task` reste un builtin appelé depuis la boucle normale du job Nodal. Il reçoit une tâche autonome, puis son résultat revient à la boucle. La description du builtin le confirme dans [code-task/index.ts:212](</D:/APPS/NodalAI/packages/tools/src/builtin/code-task/index.ts:212>).

2. **« Run this agent ON Claude Code » / « no Nodal reasoning loop » — VRAI.**  
   Nodal conserve l’ordonnancement, le relais des messages, le budget, le verrou de workspace, l’audit et la livraison. La boucle de raisonnement et les appels d’outils internes sont ceux de Claude Code. La formulation « no Nodal reasoning loop » est donc exacte ; « Nodal ne participe plus » ne le serait pas.

3. **« What runs this agent’s turns » — VRAI comme description principale.**  
   `agents.runtime` sélectionne le chemin d’exécution des tours. Il a également des effets UI — champs masqués, onglets inertes — mais ceux-ci découlent du choix de runtime et ne rendent pas le libellé mensonger.

4. **Renvoi « that is in Settings » — VRAI.**  
   Le sélecteur runtime se trouve bien dans l’onglet affiché `Settings`, sous le champ « What runs this agent’s turns ».

5. **Renvoi « on the Tools tab » — PARTIELLEMENT VRAI.**  
   La capacité `code-task` et ses defaults sont dans Tools, mais la nouvelle carte explicitement intitulée « Call a coding CLI (tool) » est dans Autonomy. Voir constat P2.

### Garde de régression

La décision de ne garder que le commentaire est insuffisante.

L’argument du coût d’un import `apps/web → orchestration` est incomplet : l’application web importe déjà `buildSystemPrompt` depuis `@nodal-agents/orchestration` dans [actions.ts:101](</D:/APPS/NodalAI/apps/web/src/lib/actions.ts:101>). Un import dans un composant client peut poser un problème de bundle, mais cela n’interdit ni un test Node côté web ni un contrat partagé sans dépendances serveur.

Garde peu coûteuse recommandée :

- définir un petit contrat de surface partagé, par exemple des états `operational`, `described`, `conditional` pour mémoire, workspace, Git, skills, connecteurs et MCP ;
- faire générer la bannière depuis ce contrat ;
- tester dans `cli-runtime-surface.test.ts` les cas positifs et négatifs réels, avec :
  - zéro mémoire puis une mémoire ;
  - zéro workspace puis un workspace ;
  - `workspaceGit` absent puis présent ;
  - skill/connecteur/MCP assigné ou seulement configuré ;
  - coéquipier portant skill/connecteur/MCP.

À défaut, même un test de texte ciblé dans `apps/web` serait plus utile que le commentaire : il ne prouverait pas seul le runtime, mais empêcherait au moins une modification silencieuse de la promesse visible. Le test actuel ne couvre notamment ni le câblage Git des deux chemins runtime, ni la contradiction introduite par `buildDiscoverabilityBlock`.

### Occurrences visibles restantes de « Coding CLI »

#### Ambiguë

- [CodeProcessesTable.tsx:84](</D:/APPS/NodalAI/apps/web/src/app/(dashboard)/code/CodeProcessesTable.tsx:84>)  
  « Attach the Coding CLI capability … or switch one to the Claude Code runtime ».

  Ce qui casse concrètement : l’ancien nom ambigu reste visible. Le contraste avec « Claude Code runtime » aide, mais l’interface demande toujours d’attacher une capacité nommée « Coding CLI » alors que le nouveau vocabulaire est « call a coding CLI (tool) » / `code-task`.

#### Visibles mais contextualisées

Les messages de [actions.ts:5601](</D:/APPS/NodalAI/apps/web/src/lib/actions.ts:5601>), [actions.ts:5758](</D:/APPS/NodalAI/apps/web/src/lib/actions.ts:5758>), [actions.ts:5867](</D:/APPS/NodalAI/apps/web/src/lib/actions.ts:5867>) et [actions.ts:5941](</D:/APPS/NodalAI/apps/web/src/lib/actions.ts:5941>) peuvent remonter à l’écran sous forme d’erreurs. Ils parlent de l’auto-run, du budget, des defaults ou des providers « coding CLI ». Comme ces réglages sont partagés entre `code_task` et le runtime, leur portée est réellement ambiguë, mais je ne peux pas établir depuis chaque appelant quel contexte exact sera visible : **NON VÉRIFIÉ**.

Les autres occurrences trouvées sont des commentaires de code ou les nouvelles formulations explicitement distinguées.

### Changement de comportement

Aucun changement de comportement détecté dans le commit fonctionnel `4b7e094` :

- seulement deux fichiers applicatifs modifiés ;
- modifications limitées aux chaînes affichées et aux commentaires ;
- `git diff --check` ne signale aucune erreur.

Aucun fichier n’a été modifié pendant cette review.
