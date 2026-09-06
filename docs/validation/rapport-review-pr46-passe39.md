## P0

### 1. Garde portée au job

**[Bloquant, déduit sans exécution] — [packages/tools/src/builtin/register-project.ts](D:/APPS/NodalAI/packages/tools/src/builtin/register-project.ts:89)**

`jobHasAnsweredQuestion` vérifie seulement l’existence, dans le job, d’une ligne `kind = 'question' AND status = 'approved'`. Il ne vérifie ni la question posée, ni la réponse choisie, ni le chemin ensuite transmis à `register_project`.

Scénario concret :

1. L’agent appelle `ask_user` pour « Quelle couleur utiliser ? ».
2. L’utilisateur répond « Bleu ».
3. La ligne approuvée déverrouille le test aux lignes 95–99.
4. L’agent appelle `register_project({path: "comptabilite"})`.
5. `computeApproval` aux lignes 156–157 renvoie `undefined` et le dossier est créé sans consentement sur sa destination.

Ce n’est donc pas seulement un agent volontairement malveillant : une reprise mal orientée ou une hallucination après n’importe quelle question suffit. La propriété « le propriétaire a été consulté dans ce job » n’implique pas « le propriétaire a autorisé ce projet ».

Une liaison robuste, sans analyser le texte de la question, serait une autorisation structurée : `ask_user` porterait par exemple les effets associés à chaque option (`toolName`, entrée autorisée ou jeton opaque). La réponse approuvée créerait une capacité consommable, et `register_project` exigerait une capacité correspondant au chemin/nom demandé. Une autre possibilité est une ligne dédiée `project_registration_authorizations`, produite lors de la résolution de la question et consommée par l’outil.

### 2. Reprise après approbation ordinaire

Pas de constat.

La reprise construit une règle exacte `register_project → auto_approve` dans [apps/runner/src/job/execute.ts](D:/APPS/NodalAI/apps/runner/src/job/execute.ts:1916). Dans [packages/tools/src/execute.ts](D:/APPS/NodalAI/packages/tools/src/execute.ts:188), cette règle devient `matchedRule`; la garde dynamique aux lignes 288–297 exige `!matchedRule`, donc `computeApproval` n’est pas rappelé. Il n’existe ensuite aucun plancher spécifique à `register_project`. L’appel atteint bien `execute`.

`mutatesWorkspace: false` à [packages/tools/src/builtin/register-project.ts](D:/APPS/NodalAI/packages/tools/src/builtin/register-project.ts:126) évite intention et instantané, car ceux-ci ne sont exécutés que sous `if (tool.mutatesWorkspace)` à [packages/tools/src/execute.ts](D:/APPS/NodalAI/packages/tools/src/execute.ts:501). C’est cohérent avec le contrat actuel : création d’un dossier vide et écriture du registre, sans livrable restaurable. Le `file_write` suivant prendra sa propre intention et son instantané.

### 3. Résolution d’un dossier absent et liens symboliques

Pas de constat.

[packages/tools/src/builtin/file-ops/workspace.ts](D:/APPS/NodalAI/packages/tools/src/builtin/file-ops/workspace.ts:349) remonte depuis la cible jusqu’au plus profond ancêtre existant, applique `realpath` à cet ancêtre, reconstruit le suffixe absent, puis contrôle la frontière aux lignes 374–383. Un lien symbolique existant dans le terrain et pointant dehors est donc refusé avant le `mkdir`.

Les chemins inexistants sont explicitement pris en charge. La fonction sonde même deux fois aux lignes 387–388 pour réduire la course TOCTOU. La course résiduelle entre cette dernière vérification et `mkdir` demeure documentée aux lignes 338–347, mais elle n’est pas introduite par cette PR.

## P1

### 4. Terrain lui-même comme projet

Pas de défaut technique, mais l’arbitrage produit reste effectivement ouvert.

Avec plusieurs terrains, le libellé nu — par exemple `terrain` — est résolu vers la racine à [packages/tools/src/builtin/file-ops/workspace.ts](D:/APPS/NodalAI/packages/tools/src/builtin/file-ops/workspace.ts:185). `isSafeSubfolder("terrain")` l’accepte ensuite à [packages/shared/src/project-subfolder.ts](D:/APPS/NodalAI/packages/shared/src/project-subfolder.ts:26). L’agent peut donc déclarer toute la racine depuis une conversation.

Le chemin vide autorisé par `isSafeSubfolder` n’est en revanche pas appelable directement, car le schéma impose `path.min(1)` à [packages/tools/src/builtin/register-project.ts](D:/APPS/NodalAI/packages/tools/src/builtin/register-project.ts:37). L’accès à la racine passe par son libellé.

### 5. Frontière « document » dans le prompt

Pas de constat bloquant.

Le texte de [packages/orchestration/src/system-prompt.ts](D:/APPS/NodalAI/packages/orchestration/src/system-prompt.ts:450) précise « anything that is not code in a repository » et exclut explicitement le code allant dans un dossier à manifeste.

Il reste une ambiguïté sémantique raisonnable pour un `README.md`, une documentation versionnée ou un fichier de configuration : l’extension seule évoque un document, tandis que le contexte du dépôt en fait un artefact du projet de code. La phrase « in a repository » donne néanmoins au modèle la règle nécessaire ; je ne vois pas de rupture déterministe justifiant un constat.

### 6. Projet masqué

Pas de constat.

[apps/runner/src/job/conversation-id.ts](D:/APPS/NodalAI/apps/runner/src/job/conversation-id.ts:268) exclut les projets masqués des options. Si l’utilisateur ou l’agent nomme néanmoins explicitement leur dossier, l’upsert de [packages/tools/src/projects/register.ts](D:/APPS/NodalAI/packages/tools/src/projects/register.ts:103) ne modifie pas une ligne déjà déclarée, puis l’outil la relit et la rattache. C’est cohérent avec « masquer n’est pas désinscrire ».

### 7. Chemins absolus

Pas de constat.

`resolveAndCheckPath` accepterait un chemin absolu contenu dans un terrain, mais `isSafeSubfolder(input.path)` le refuse ensuite à [packages/tools/src/builtin/register-project.ts](D:/APPS/NodalAI/packages/tools/src/builtin/register-project.ts:182). Pour un outil qui exprime volontairement un sous-dossier de terrain, cette restriction est cohérente, même si elle diffère de `file_write`.

## P2

### 8. Douze projets contre six options

**[P2, déduit sans exécution] — [packages/orchestration/src/system-prompt.ts](D:/APPS/NodalAI/packages/orchestration/src/system-prompt.ts:454)**

La consigne demande d’« offrir les projets déclarés » et une option « New project », tandis que la liste peut contenir douze projets aux lignes 403 et 468. Elle ne dit pas de sélectionner les plus pertinents ni de limiter la question à cinq projets.

Scénario concret : une entité possède douze projets déclarés. Le modèle suit littéralement le bloc et appelle `ask_user` avec les douze projets plus « New project ». Le schéma refuse l’appel, car [packages/tools/src/builtin/ask-user.ts](D:/APPS/NodalAI/packages/tools/src/builtin/ask-user.ts:34) impose au plus six options. L’outil décrit certes ailleurs qu’il faut choisir les options les plus probables, mais le bloc contextuel spécialisé donne une instruction contradictoire plus directe.

Il faut soit plafonner la liste à cinq projets, soit demander explicitement « choose up to five relevant registered projects, plus one New project option ».

## Constats hors demande

### Échec de rattachement après création non atomique

**[P1, déduit sans exécution] — [packages/tools/src/builtin/register-project.ts](D:/APPS/NodalAI/packages/tools/src/builtin/register-project.ts:186)**

Le dossier est créé aux lignes 186–193, puis la ligne `code_projects` est écrite aux lignes 195–204, avant le rattachement aux lignes 231–243. Si `attachProductionToProject` échoue, l’outil renvoie `ok: false`, mais ni le dossier ni la déclaration ne sont annulés.

Scénario concret : le job disparaît ou devient introuvable entre l’upsert et `markJob`. `attachProductionToProject` rend `attach_job_not_found`; l’appel annonce `attach_failed:attach_job_not_found`, alors que Spaces contient déjà le nouveau projet et que le dossier existe. La conversation reste sans projet courant et peut reposer « où écrire ? » au tour suivant.

La création du dossier ne peut pas entrer dans une transaction SQL, mais la déclaration et les rattachements devraient être atomiques, avec nettoyage explicite du dossier seulement s’il a été créé par cet appel et demeure vide.

## Constats bloquants

- Garde de `register_project` déverrouillée par n’importe quelle question approuvée du job — [packages/tools/src/builtin/register-project.ts](D:/APPS/NodalAI/packages/tools/src/builtin/register-project.ts:89).