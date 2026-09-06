Verdict : **faux**. Aucun bloquant, deux constats importants et un mineur.

## Constats

### Bloquant

Aucun.

### Important

1. `apps/web/src/app/(dashboard)/spaces/[id]/page.tsx:94` — l’échec de lecture du fil est transformé silencieusement en fil vide.

   Lorsque `getConversationThreadAction()` rend une erreur autre qu’un succès, la page affiche simplement « Nothing said here yet ». Elle conserve également le composeur actif.

   Ce qui casse : une panne DB, une erreur d’assemblage ou une incohérence d’accès est présentée comme une conversation vide. L’utilisateur peut alors renvoyer un message sans savoir que l’historique n’a pas été chargé. Cela contrevient au principe « fail loud ».

2. `apps/web/src/lib/project-actions.ts:647` — la preuve d’un projet est chargée sans plafond avant de ne garder que trois séquences à la ligne 730.

   La requête récupère toutes les lignes `verification_runs` correspondant à la clé, sans limite SQL ni sélection préalable des trois dernières séquences. `groupVerificationRuns(proofRows)` traite ensuite l’historique entier, puis `sequences.slice(-3)` en jette presque tout.

   Ce qui casse : le coût de `/spaces/[id]` augmente indéfiniment avec l’historique de vérification, alors que le contrat de la page est borné à trois séquences. Un projet ancien peut ralentir ou faire dépasser les limites de mémoire/temps de la page.

### Mineur

3. `apps/web/src/lib/project-actions.ts:549` — une erreur de lecture est indistinguable d’un dossier supprimé dans l’interface.

   `readProjectFolder()` met `missing: true` pour un chemin absent, illisible ou qui n’est pas un dossier. `ProjectShelf.tsx:78` affirme pourtant : « This folder is not there any more ».

   Ce qui casse : un refus de permission ou un chemin devenu fichier est diagnostiqué à tort comme une suppression.

## Réponse aux cinq doutes

1. **La conversation la plus récente ancrée : faux comme définition durable de “la conversation du projet”.**

   Une conversation seulement ancrée par une production antérieure peut évincer celle explicitement créée depuis la page dès que son `updated_at` devient plus récent. Il faut distinguer l’origine « créée depuis le projet », ou définir explicitement qu’un projet possède plusieurs conversations et demander laquelle prolonger. En l’état, le choix implicite par récence est surprenant et instable.

2. **ROOT à la création plutôt que responsable du projet : acceptable pour P8, mais à trancher au lot 3.**

   Le comportement est cohérent avec le chat actuel : le dashboard parle au ROOT et le correctif de la passe 29 garantit ensuite que le fil reste attaché à cet agent. Utiliser immédiatement `code_projects.agent_id` changerait le modèle fonctionnel du chat. Ce n’est pas un défaut isolé de P8, mais la décision devra être explicite avant d’introduire le chat multi-agent.

3. **Lien d’une délégation vers `/scheduled/<jobId>` : faux sémantiquement, fonctionnellement acceptable à titre transitoire.**

   La page sait rendre le bon job, mais l’URL et le retour « Scheduled » affirment qu’une délégation est une automatisation. Une route neutre de détail de job est préférable. Ce n’est pas bloquant pour P8 si cette dette de navigation est assumée.

4. **Liens symboliques dans `readProjectFolder` : l’étagère ment effectivement.**

   `Dirent.isDirectory()` est faux pour le lien, qui est donc classé `file`; puis `stat()` suit le lien. Un lien vers un dossier est affiché comme fichier avec la taille statistique de la cible. Un lien vers un fichier extérieur révèle aussi sa taille. Utiliser `lstat()` et une sorte explicite `symlink`, ou ne pas mesurer les liens, rendrait le comportement honnête.

5. **Plafond exactement atteint : faux positif réel ; lire N+1.**

   Avec exactement 500 messages ou 100 jobs, la note affirme à tort que des tours anciens manquent. Une lecture `LIMIT N + 1`, suivie d’une coupe à N, permet de connaître la troncature sans requête de comptage supplémentaire.

## Vérification des sept corrections de `717a28da`

1. **L’issue d’un appel décide du classement : tient.**

   `outcomeOfToolOutput()` est consulté avant les cartes. Les issues d’échec, de blocage et d’attente ne deviennent plus des productions réussies.

2. **Le plafond de huit fichiers couvre les fichiers anonymes : tient.**

   Toutes les branches `files`, y compris sans `presented`, passent par `pushFile()`, qui incrémente le même compteur et alimente `more`.

3. **Les plafonds gardent la fin du fil et signalent la coupe en tête : tient, avec le faux positif exact-N décrit ci-dessus.**

   Les requêtes lisent en ordre décroissant, puis les lignes sont inversées pour l’affichage chronologique. La note est placée avant le fil.

4. **L’assemblage des fils de jobs est groupé : tient.**

   `assembleJobFeeds()` charge enfants directs, appels outils et appels LLM en trois requêtes groupées, puis répartit les résultats en mémoire. Le précédent schéma de trois requêtes par job de tête a disparu.

5. **La réponse vise l’agent de la conversation : tient.**

   `sendChatMessageAction()` lit `conversations.agent_id`, vérifie l’entité et l’état de l’agent, puis transmet cet identifiant au runner.

6. **Le runner refuse un agent différent de celui du fil : tient.**

   `run-chat-turn.ts:269` rend `conversation_agent_mismatch` avant l’insertion du message utilisateur.

7. **Préfixes de groupe et activité ancienne non classable : tient.**

   `stripGroupPrefix()` est partagé par le titrage du runner et le repli web; la migration 0096 corrige les titres existants sans toucher aux tâches. Les lignes anciennes sans carte produisent une note neutre lorsqu’aucune production certaine n’est établie.

## Exécution et périmètre

- Lecture statique des commits `d01585a3` et `717a28da`, de leurs tests et du rapport de passe 29 : exécutée.
- Inspection Git du statut, de l’historique et des différences : exécutée.
- Le document non suivi `docs/validation/demande-review-pr46-passe30.md` a été traité comme entrée de revue et exclu des constats.
- Suites Vitest ciblées : **NON EXÉCUTÉES** — commande refusée par le sandbox.
- `pnpm typecheck`, lint, dependency-cruiser, tests complets et tests d’intégration PostgreSQL : **NON EXÉCUTÉS**.
- Vérification réelle des liens symboliques sur disque : **NON EXÉCUTÉE** ; conclusion issue de la sémantique Node de `Dirent` et `stat()`.

**« Rien de neuf » : non.** Les trois constats ci-dessus sont nouveaux par rapport à la passe 29.