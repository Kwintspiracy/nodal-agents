## P0 — ce qui casserait la règle

### 1. Clé entre intention et registre

Je ne vois pas de scénario où l’écart d’expansion produit deux clés différentes pour la même cible.

Dans [intent.ts](D:/APPS/NodalAI/packages/tools/src/verification/intent.ts:249), une cible `dir` égale à une racine sans manifeste est éclatée en enfants, puis chaque enfant produit sa propre clé. Dans [attach.ts](D:/APPS/NodalAI/packages/tools/src/projects/attach.ts:323), cette même cible non éclatée produit la clé de la racine, immédiatement refusée par `hasMarker` à la ligne 327.

Le résultat est donc une absence de déclaration, pas une seconde clé. En revanche, le rattachement peut temporairement manquer les enfants à manifeste lorsque l’appelant ne fournit que la racine.

### 2. `ON CONFLICT … WHERE` et `RETURNING`

Le comportement attendu est bien celui de PostgreSQL 16/17 : lorsqu’un conflit est rencontré mais que la condition du `DO UPDATE … WHERE` est fausse, la ligne n’est pas mise à jour et n’apparaît pas dans `RETURNING`.

L’hypothèse utilisée dans [register.ts](D:/APPS/NodalAI/packages/tools/src/projects/register.ts:94) est donc correcte. Déduit sans exécution sur PostgreSQL réel dans cet environnement.

### 3. Déclaration sans édition observée

**Constat P0 — déclaration d’un projet sans production de code.**  
Dans [run-job.ts](D:/APPS/NodalAI/apps/runner/src/cli-runtime/run-job.ts:534), un tour réussi entre dans le rattachement même si `edits` est vide ; les dossiers attachés deviennent alors les cibles aux lignes 555–560. Dans [run-chat.ts](D:/APPS/NodalAI/apps/runner/src/cli-runtime/run-chat.ts:325), tout tour `write` réussi fait directement la même chose.

Scénario concret : un agent possède un dépôt `terrain/app` avec `package.json`; l’utilisateur lance un tour en mode `write`, mais le modèle répond seulement « je vais d’abord analyser la demande » sans appeler d’outil d’édition. `app` reçoit néanmoins `registered_at`, `registered_from='conversation'` et devient le projet courant de la conversation. La condition annoncée — « un dossier où une production de code a atterri » — est alors fausse.

Ce repli historique était défendable pour le seul rattachement, qui pouvait travailler sur un projet déjà déclaré. Il ne l’est plus pour une création automatique irréversible du registre. Il faut soit distinguer « rattacher » de « déclarer », soit ne permettre la déclaration automatique qu’en présence d’au moins une édition attribuable au tour. Déduit sans exécution.

## P1 — ce qui donnerait un résultat faux

### 4. `agent_id` du backfill

**Constat P1 — propriétaire non déterministe.**  
[code-projects.ts](D:/APPS/NodalAI/apps/runner/src/job/code-projects.ts:516) charge les workspaces sans `ORDER BY`, puis [backfill-registered-projects.ts](D:/APPS/NodalAI/apps/runner/src/bootstrap/backfill-registered-projects.ts:68) prend `ownerIds[0]`.

Scénario concret : Alice et Bob ont attaché le même dépôt. Selon le plan choisi par PostgreSQL, le premier détenteur peut être Alice à un boot et Bob dans une autre installation identique. Le premier boot qui déclare le projet fige arbitrairement cet agent dans Spaces.

La demande décrit le choix comme « premier détenteur », mais le code ne définit aucun premier. Mettre `NULL` lorsqu’il y a plusieurs détenteurs serait plus honnête ; à défaut, il faut un ordre métier explicite et stable. Déduit sans exécution.

### 5. Sens de `registered_at`

`listProjectsAction` trie d’abord sur `max(agent_jobs.created_at)`, puis seulement sur `registered_at` pour les projets sans activité rattachée, dans [project-actions.ts](D:/APPS/NodalAI/apps/web/src/lib/project-actions.ts:240). La date de backfill ne perturbe donc pas le classement des projets ayant des jobs rattachés.

Elle reste toutefois affichée comme date d’ajout dans [ProjectShelf.tsx](D:/APPS/NodalAI/apps/web/src/app/(dashboard)/spaces/ProjectShelf.tsx:69). Un projet déclaré aujourd’hui par le backfill peut ainsi apparaître comme « ajouté il y a 11 jours ». C’est une ambiguïté sémantique, pas une rupture fonctionnelle : la colonne représente tantôt la déclaration, tantôt l’activité historique. Déduit sans exécution.

### 6. Cache de 60 secondes

Je ne vois pas de biais durable lié au registre lui-même : `scanProjects` ne lit effectivement pas `code_projects`.

Une entrée mise en cache juste avant une nouvelle écriture peut être ancienne pendant 60 secondes, mais l’écriture nouvelle passe normalement par la déclaration au fil de l’eau. Au premier démarrage, le cache est vide. Pas de constat sur ce point.

### 7. Fichier écrit puis supprimé

**Constat P1 — une production réelle peut ne jamais être déclarée.**  
Dans [resolveScannedPath](D:/APPS/NodalAI/apps/runner/src/job/code-projects.ts:208), lorsque l’auteur possède plusieurs workspaces et que le chemin relatif n’a pas de label, le choix dépend de l’existence actuelle du fichier. [run-job.ts](D:/APPS/NodalAI/apps/runner/src/cli-runtime/run-job.ts:178) lui passe directement `existsSync`.

Scénario concret : le tour écrit `src/generated.ts` dans `app`, puis le supprime après l’avoir consommé. Avec plusieurs workspaces non labellisés dans l’audit, aucun candidat n’existe à la fin du tour. `harnessEdits` devient vide ; si le terrain parent n’a pas de manifeste, `app` n’est pas déclaré malgré une production de code réelle.

La même perte dans l’onglet Code explique la cohérence entre vues, mais ne la rend pas correcte pour un événement de déclaration. Il faudrait conserver le workspace résolu au moment de l’exécution ou auditer le chemin absolu. Déduit sans exécution.

### 8. Windows, casse et jonctions

La casse seule est correctement repliée par `projectKey`; je ne vois pas de doublon pour `C:/Dev/App` contre `c:/dev/app`.

**Constat P1 — deux alias lexicaux d’une jonction peuvent encore créer deux projets physiques identiques.**  
[markers.ts](D:/APPS/NodalAI/packages/tools/src/projects/markers.ts:62) utilise le chemin réel uniquement pour choisir une racine, puis restitue volontairement sa forme lexicale. La clé est ensuite calculée sur cette forme par [project-roots.ts](D:/APPS/NodalAI/packages/shared/src/project-roots.ts:170).

Scénario concret : `C:/terrain/app` et `D:/liens/app` sont deux workspaces pointant par jonction vers le même dépôt. Une écriture attribuée au premier label déclare la clé `c:/terrain/app`; une autre attribuée au second déclare `d:/liens/app`. Spaces contient alors deux lignes pour le même dossier physique, avec rattachements et preuves séparés.

Le commentaire documente ce choix, mais cela répond positivement à la question sur les jonctions : le doublon demeure possible. Déduit sans exécution.

## P2

### 9. Compteur `skipped`

Le compteur unique de [backfill-registered-projects.ts](D:/APPS/NodalAI/apps/runner/src/bootstrap/backfill-registered-projects.ts:60) ne casse pas le backfill, mais il est trop pauvre pour diagnostiquer un résultat inattendu.

Scénario concret : `registered=0 skipped=30` ne permet pas de savoir si tout était déjà déclaré — situation saine — ou si 30 projets ont perdu leur manifeste ou sont devenus inaccessibles. Des compteurs `missing`, `no_marker`, `hidden` et `already_registered` rendraient le log exploitable. Non bloquant.

### 10. Deux implémentations de `hasMarker`

Les deux fonctions lisent désormais la même constante `PROJECT_MARKERS`. Je ne recommande pas d’introduire une dépendance du runner vers `tools` uniquement pour trois lignes de lecture disque : cela resserrerait inutilement l’architecture.

Le vrai invariant est la liste partagée, déjà assurée. Aucun constat.

## Constats hors questions

### Déclaration avant validation du job ou de la conversation

**Constat P1 — une référence invalide peut tout de même déclarer durablement le projet.**  
[attach.ts](D:/APPS/NodalAI/packages/tools/src/projects/attach.ts:214) appelle `registerManifestProjects` avant de vérifier le job via `markJob` et avant l’UPDATE de la conversation aux lignes 258–278.

Scénario concret : l’appel reçoit un ancien `conversationId` supprimé ou appartenant à une autre entité, avec `jobId=null`, et une cible située dans un dépôt à manifeste. Le projet est déclaré, puis le résultat indique `conversation: 'not_found'`. Il n’existe donc aucune conversation ayant produit ou déclaré ce projet, contrairement aux métadonnées `registered_from='conversation'`.

Même problème si `markJob` échoue après l’upsert : la fonction rend `failed`, mais la déclaration reste acquise. Il faudrait valider les ancres avant la déclaration ou regrouper déclaration et rattachement dans une transaction. Déduit sans exécution.

### Déclaration partielle sur plusieurs racines

**Constat P1 — l’opération n’est pas atomique.**  
[register.ts](D:/APPS/NodalAI/packages/tools/src/projects/register.ts:70) exécute un upsert séparé pour chaque racine, sans transaction.

Scénario concret : un outil produit dans deux dépôts à manifeste ; le premier upsert réussit, puis la connexion tombe avant le second. `attachProductionToProject` rend `failed`, mais le premier projet reste déclaré et le second non. Au-delà du résultat trompeur, la conversation et le job ne sont rattachés à aucun des deux. Déduit sans exécution.

L’exécution des tests n’a pas été possible : le profil de cette session interdit les écritures nécessaires à Vitest. Tous les constats ci-dessus sont donc issus de l’inspection statique du commit et de l’état courant.

## Constats bloquants

- P0 — [run-job.ts:534](D:/APPS/NodalAI/apps/runner/src/cli-runtime/run-job.ts:534) et [run-chat.ts:325](D:/APPS/NodalAI/apps/runner/src/cli-runtime/run-chat.ts:325) : un tour réussi sans édition déclare un projet sans qu’une production de code y ait atterri.