# Demande de review — PR #46, passe 32 (P5b : le registre des projets se remplit tout seul)

Périmètre : **un commit**, `16d1f574`.

- `packages/tools/src/projects/markers.ts` (neuf : `hasMarker`, `realPathOf`,
  `rebaseOntoLexicalRoots`, extraits de `verification/intent.ts` qui les importe désormais),
  `packages/tools/src/projects/register.ts` (neuf : `registerCodeProjects`),
  `packages/tools/src/projects/attach.ts` (`registerManifestProjects` avant la recherche du
  projet contenant ; `AttachContext.agentId` + `workspaces` ; issue `attached.registered`),
  `packages/tools/src/execute.ts` (le seam passe `agentId` et `workspaces`),
  `packages/tools/src/index.ts` (exports).
- `apps/runner/src/job/code-projects.ts` (`PROJECT_MARKERS` lu depuis `@nodal-agents/shared`,
  `hasMarker`/`scanProjects`/`resolveScannedPath`/`listHiddenWorkspaceRoots`/`scannedEditPath`
  exportés, `ownerIds` sur `RawProject` et `canonicalRoots`),
  `apps/runner/src/cli-runtime/run-job.ts` (`harnessWrote` → `harnessEdits`, cibles = fichiers
  écrits, sinon dossiers attachés), `run-chat.ts` (agent + dossiers passés, cibles inchangées),
  `apps/runner/src/bootstrap/backfill-registered-projects.ts` (neuf),
  `apps/runner/src/server.ts` (`startRegistryBackfillBackground` après `serve()`).
- Tests : `packages/tools/src/tests/projects/attach.test.ts` (bloc P5b, cas a–g + « sans
  dossier attaché »), `attach-seam.test.ts` (déclaration par le VRAI `file_write`, écriture
  qui échoue), `apps/runner/src/tests/cli-runtime/intent-cli-runtime.test.ts` (bloc P5b, 4 cas),
  `apps/runner/src/tests/bootstrap/backfill-registered-projects.test.ts` (neuf).

**Hors périmètre** : `docs/plans/*` (modifiés dans l'arbre, pas encore committés) ; aucune
migration (aucune colonne nouvelle — le registre est celui de 0093).

## Ce que P5b pose (plan « De la maquette au produit », P5b)

La décision de Quentin, 06/09 au soir : les projets de l'onglet Code ont leur place dans Spaces
sans un clic. **Une seule définition** : un dossier où une production de code a atterri et qui
porte un manifeste (`PROJECT_MARKERS`) EST un projet, déclaré par la conversation qui y a
produit. Le registre (`code_projects.registered_at`) se remplit donc :

1. **Au rattachement** (`attach.ts`) : AVANT de chercher le projet déclaré qui contient une
   cible, les cibles `deliverableType: 'code_project'` passent par `rebaseOntoLexicalRoots` puis
   `resolveProjectRoots` — la MÊME dérivation que l'intention de mutation — et chaque racine
   dérivée dont le dossier porte un manifeste est déclarée par `registerCodeProjects` :
   `INSERT … ON CONFLICT (entity_id, project_key) DO UPDATE SET registered_at = now(),
   registered_from = 'conversation', registered_job_id = <job>, kind = 'code', agent_id =
   <agent si connu> WHERE registered_at IS NULL`, `RETURNING id`. Une ligne déjà déclarée n'est
   pas retouchée (le WHERE est faux, rien n'est rendu) ; `display_name` et `hidden` ne sont
   jamais touchés. La recherche existante trouve ensuite la racine déclarée : le job s'y
   rattache (« le premier gagne »), la conversation aussi (« la dernière décide »).
2. **Sur le chemin CLI** (`run-job.ts`) : après `binding.run`, les lignes `tool_calls` de CE job
   portant un outil d'édition (`EDIT_TOOLS`) depuis le début du tour donnent les CHEMINS écrits
   (`scannedEditPath` + `resolveScannedPath`, les mêmes lectures que l'onglet Code) ; s'il y en
   a, ce sont les cibles (`kind: 'file'`), sinon les dossiers attachés (`kind: 'dir'`) comme
   avant ; condition inchangée (tour réussi OU au moins une édition). `run-chat.ts` garde les
   dossiers attachés : sans job, les lignes `cli:*` n'ont pas de `job_id`.
3. **Au boot du runner** (`backfill-registered-projects.ts`) : pour chaque entité, les projets
   DÉRIVÉS par `scanProjects` (la règle de l'onglet Code) dont le dossier existe ET porte un
   manifeste sont déclarés (`registered_job_id = NULL`, `agent_id` = premier détenteur,
   `registered_at` = dernière activité du scan) ; sautés : dossier disparu, sans manifeste,
   sous un dossier attaché `hidden_from_code` (règle de sous-arbre, `isWithinRoot`), déjà
   déclaré. Tâche de fond jamais attendue, une ligne `[projects] REGISTRY_BACKFILL
   registered=N skipped=M`.

Ce qui ne change PAS : une racine dérivée SANS manifeste (`terrain/vrac`) ne se déclare
jamais — c'est le domaine de la question « où écrire ? » (P10, restreinte aux documents) ; un
`office_file` ne déclare rien ; l'onglet Code lit toujours sa dérivation.

## Mesuré

- tools 59 fichiers / 882 tests ; runner 114 fichiers / 1296 tests (un fichier
  `.pg.test.ts` de concurrence sur Postgres réel a échoué sous charge dans la suite complète
  et passe seul, 3/3 — hors périmètre, non modifié) ; db 258 ; `pnpm typecheck` racine 33/33 ;
  dependency-cruiser 0 violation ; lint 0 erreur.
- 8 mutations rouges puis restaurées : déclaration débranchée (5 tests), manifeste ignoré
  (cas c), `setWhere` retiré (cas d ; et la seconde passe du backfill), documents déclarés
  (cas g), chemins écrits ignorés sur le chemin CLI (2 tests), dossiers masqués déclarés au
  backfill, date du boot au lieu de la dernière activité.
- Base dev : backfill joué (`apps/runner/.cache/backfill-registry-dev.mts`) — 3 projets
  déclarés (`podium-app`, `igdb-app`, `notes-app`, agent = détenteur, `registered_at` = dernière
  activité du 26/08), 9 sautés.

## Questions, par priorité

### P0 — ce qui casserait la règle

1. **La clé.** `registerManifestProjects` dérive la clé par `rebaseOntoLexicalRoots` +
   `resolveProjectRoots` ; l'intention de mutation, elle, passe AUSSI par `expandWorkspaceRoots`
   (un `kind: 'dir'` égal à une racine attachée sans manifeste est éclaté en enfants de premier
   niveau). Le registre ne le fait pas : une cible `dir` = racine sans manifeste rend la racine,
   `hasMarker` la refuse, rien n'est déclaré. Y a-t-il un cas où l'intention pose une ligne de
   comptabilité sous une clé et où le registre déclarerait une AUTRE clé pour le même dossier
   (deux lignes `code_projects` pour un dossier) ?
2. **`ON CONFLICT … DO UPDATE … WHERE registered_at IS NULL` + `RETURNING`** : sur Postgres, une
   ligne non mise à jour parce que le WHERE est faux n'est pas rendue — c'est ce sur quoi
   `registered` et le compteur du backfill reposent. Vrai sur pglite (les tests le prouvent) ;
   un doute sur Postgres 16/17 ?
3. **Le chemin CLI déclare le TERRAIN sur un tour réussi sans ligne d'édition** (repli
   `kind: 'dir'`, comme avant pour le rattachement) : un tour en mode `write` qui n'a rien écrit
   (une réponse de chat par la CLI) déclare un dossier attaché à manifeste comme projet. C'est
   la condition d'avant (« tour réussi OU édition ») appliquée à la déclaration. Défendable
   (le dossier attaché à manifeste EST un projet, quoi qu'il arrive) ou trop large ? Même
   question pour `run-chat.ts`.

### P1 — ce qui donnerait un résultat faux sans casser

4. **`agent_id` au backfill = premier détenteur** (`ownerIds[0]`, ordre des lignes
   `agent_workspaces`) : arbitraire quand deux agents attachent le même dossier. Est-ce dit
   assez fort, et faut-il plutôt NULL dans ce cas ?
5. **`registered_at` = dernière activité** au backfill, `now()` au rattachement : un projet
   déclaré au boot a une date de 2026-08-26 alors que sa déclaration date d'aujourd'hui. Spaces
   trie sur la dernière activité des jobs, pas sur cette colonne (à vérifier dans
   `listProjectsAction`) — la date sert-elle ailleurs ?
6. **Le cache 60 s de `scanProjects`** partagé avec le contexte des agents : le module dit
   pourquoi c'est sans conséquence (le scan ne lit pas le registre). Un cas où ça biaise ?
7. **`harnessEdits` résout les chemins avec `existsSync`** (cas 4 de `resolveScannedPath`,
   plusieurs dossiers sans label) : un fichier écrit puis supprimé dans le tour ne se situe
   plus. L'onglet Code accepte la même perte. Acceptable ici ?
8. **Windows** : `hasMarker(root.path)` sur la racine LEXICALE (casse du propriétaire),
   `existsSync` insensible à la casse ; `projectKey` replie la casse. Un piège de casse ou de
   jonction qui ferait déclarer deux fois le même dossier ?

### P2

9. Le compteur `skipped` mélange quatre raisons (disparu, sans manifeste, masqué, déjà
   déclaré) sur une seule ligne de log. Faut-il les distinguer ?
10. `code-projects.ts` : `PROJECT_MARKERS` local retiré au profit de la liste partagée — la
    liste est identique ; `hasMarker` du runner et celui de `tools/projects/markers.ts` restent
    deux fonctions (chacune dans son paquet, le runner ne peut pas importer un chemin interne de
    tools ; `hasMarker` est aussi exporté de `@nodal-agents/tools` mais `code-projects.ts` garde
    la sienne). Deux copies de trois lignes, ou une à faire converger ?

## Ce qui n'est PAS attendu

Le style, le nommage, la longueur des commentaires. Un constat vaut s'il désigne un fichier,
une ligne, et ce qui casse ; « conforme » et « ça a l'air bien » ne valent rien.
