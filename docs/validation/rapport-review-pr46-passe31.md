Verdict : **faux**. Aucun bloquant, un constat important, aucun mineur.

## Constats

### Bloquant

Aucun.

### Important

1. `apps/web/src/lib/project-actions.ts:771` — les conversations de projet créées avant la migration ne sont plus reconnues comme « conversation du projet ».

   Le nouveau lecteur exige `origin = 'project'`, mais la migration `packages/db/migrations/0097_conversations_origin_project.sql:19` élargit seulement la contrainte : elle ne requalifie aucune ligne existante. Or les versions précédentes créaient ces conversations avec `origin = 'user'`.

   Ce qui casse : après mise à niveau, un projet ayant déjà une conversation affiche toujours celle-ci dans la liste, mais `projectConversationId` devient `null`. Au prochain envoi, `ProjectComposer` appelle `createProjectConversationAction()` et crée une seconde conversation au lieu de prolonger le fil existant. Il faut une stratégie de compatibilité, par exemple reprendre l’ancienne sélection comme repli uniquement lorsqu’aucune conversation `origin = 'project'` n’existe.

### Mineur

Aucun.

## Réponse aux trois doutes

1. **Sous-requête `GROUP BY … ORDER BY max() … LIMIT 3` : tient.**

   PostgreSQL 16 accepte cette forme. Le planificateur ne peut pas supprimer sémantiquement l’`ORDER BY`, puisqu’il détermine ici les lignes retenues par `LIMIT 3`. L’ordre du résultat final de `IN` n’est pas garanti, mais il n’est pas utilisé : `groupVerificationRuns()` rétablit ensuite l’ordre d’affichage.

   PostgreSQL 16 réel : **NON EXÉCUTÉ**. Conclusion issue de la sémantique SQL et de la lecture statique.

2. **Lecteur restant limité à `origin = 'user'` : non.**

   Le seul filtre de liste trouvé dans `apps/web` est désormais `origin IN ('user', 'project')` dans `apps/web/src/lib/conversation-actions.ts:227`. Le filtre de `project-actions.ts:771` cherche volontairement `project`. Aucun lecteur strict `origin = 'user'` n’a été trouvé dans `apps/runner`.

   Les occurrences restantes dans le runner sont des écritures ou des données de test, notamment `apps/runner/src/job/conversation-id.ts:145`, pas des filtres de lecture.

3. **Afficher la cible du lien symbolique : non.**

   `kind: 'symlink'`, `bytes: null` et la flèche suffisent pour que l’étagère ne mente plus. Appeler `readlink()` exposerait potentiellement un chemin absolu ou une structure extérieure au terrain, sans nécessité fonctionnelle définie. Garder seulement `nom →` est le meilleur contrat pour ce lot.

## Les six points de la passe 30

1. **Échec de lecture du fil dit, saisie retirée : tient.**

   `ProjectThread.tsx` sépare correctement panne, absence de conversation et fil chargé.

2. **Preuve bornée aux trois dernières séquences en SQL : tient.**

   La sous-requête choisit trois identifiants de séquence avant la lecture des lignes correspondantes.

3. **Cause exacte d’illisibilité du dossier : tient.**

   `ENOENT`, `ENOTDIR`, `EACCES`/`EPERM` et les autres erreurs sont distingués et rendus avec des textes différents.

4. **Conversation du projet identifiée par `origin = 'project'` : faux.**

   Le modèle tient pour les nouvelles conversations, mais pas pour les lignes historiques `origin = 'user'`. C’est le constat important ci-dessus.

5. **Lien symbolique listé sans être mesuré : tient.**

   `Dirent.isSymbolicLink()` est consulté et seuls les vrais fichiers passent par `stat()`.

6. **Troncature exacte par lecture N+1 : tient.**

   Le drapeau utilise `length > N`, puis les données sont coupées à N. Un fil exactement au plafond n’est plus déclaré tronqué.

## Exécution

- Lecture du document de cadrage, du commit `3528b4c4`, du rapport de passe 30 et des fichiers concernés : exécutée.
- Recherche des usages de `origin` dans `apps/web` et `apps/runner` : exécutée.
- `git diff --check 3528b4c4^ 3528b4c4` : exécuté, aucune erreur signalée.
- Tests Vitest ciblés : **NON EXÉCUTÉS** — lancement refusé par le sandbox.
- Typecheck, lint, dependency-cruiser et suites complètes : **NON EXÉCUTÉS**.
- Migration sur PostgreSQL 16 réel : **NON EXÉCUTÉE**.
- Vérification réelle des permissions et liens symboliques sur disque : **NON EXÉCUTÉE**.

**« Rien de neuf » : non.** La rupture de continuité des conversations de projet antérieures à `0097` est un constat nouveau.