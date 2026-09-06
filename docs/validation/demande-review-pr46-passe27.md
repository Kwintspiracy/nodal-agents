# Demande de review — PR #46, passe 27 (P5 : le registre des projets ; et les correctifs de la passe 26)

Périmètre : **deux commits**.

- `fd2293c3` — **P5, le registre des projets** : `packages/db/migrations/0093_project_registry.sql`
  (+ journal), `packages/db/src/schema/code-projects.ts` et `jobs.ts` (`project_id`),
  `packages/db/src/tests/helpers.ts`, `packages/shared/src/project-roots.ts` (`isWithinRoot`
  exportée), `packages/tools/src/projects/attach.ts` (+ `index.ts`), le seam
  `takeMutationIntent` dans `packages/tools/src/execute.ts`, les deux chemins du runtime CLI
  (`apps/runner/src/cli-runtime/run-job.ts`, `run-chat.ts`), `apps/web/src/lib/project-actions.ts`,
  et les tests `packages/tools/src/tests/projects/attach*.test.ts`,
  `apps/web/src/lib/__tests__/project-actions.test.ts`.
- `0cb5889b` — **les correctifs de la passe 26** : `scheduleId` dans la provenance cron
  (`JobTriggerContext`, `run-schedules.ts`, `toSpaceListRow`, `spaces-list.ts` + tests),
  `RowActionButton` pour « Back to the conversation », `aria-expanded`/`aria-controls` sur les
  disclosures, contrat de `TextButton` élargi (`components/ui/TextButton.tsx`).

**Hors périmètre** : tout fichier non committé (P6 commence en parallèle : `conversation-id.ts`,
`thread-history.ts`, `chat-messages.ts`, migration 0094, et il PROLONGERA `attach.ts` — relis
`attach.ts` tel qu'il est dans `fd2293c3`, pas l'arbre de travail s'il a déjà bougé).

## Ce que P5 pose (plan « De la maquette au produit », P5)

- Le registre RÉUTILISE `code_projects` : `registered_at` NULL = ligne de comptabilité
  (renommage, masquage, preuve, ou la ligne créée toute seule par `bumpProjectEpoch`),
  NOT NULL = projet déclaré ; `kind` (`code` | `documents`), `agent_id` (responsable),
  `registered_from` (`spaces` | `conversation`), `registered_job_id`. `agent_jobs.project_id`
  = le projet auquel un travail s'est rattaché. Aucun lecteur existant ne regarde
  `registered_at` : l'onglet Code et la vérification lisent par clé, comme avant.
- `attachProductionToProject(ctx, targets)` : sur les MÊMES cibles que l'intention de
  mutation. Un REGISTRE, jamais une garde : ne refuse jamais l'écriture, ne crée aucun projet,
  ne lève jamais (`failed` + code loggé). Contenance par `isWithinRoot` (frontière de segment,
  casse repliée sur Windows seulement), le plus niché gagne, second passage sur les chemins
  RÉELS (`realpathSync.native`) si le lexical ne trouve rien. `UPDATE … WHERE project_id IS
  NULL` = le premier projet gagne ; l'ignoré est nommé (`kept_existing`).
- Branché : seam d'`executeTool` (après l'intention, quand l'écriture VA avoir lieu : `written`,
  `no_targets`, `skipped` ; jamais sur `failed`/`already_terminal`) ; `run-job.ts` (cibles
  `dir` = les workspaces, comme l'intention) ; `run-chat.ts` (`jobId: null` → `no_job`, site
  posé pour P6).
- Hors de tout projet enregistré : rien n'est créé. « Où écrire ? » est P10 (lot 3).
- Écran : `listProjectsAction` (enregistrés seulement, compte et dernière activité par LEFT
  JOIN groupé), `listProjectTerrainsAction`, `createProjectAction` (zod ; sous-dossier relatif
  seulement, `..`/absolu/contrôle refusés, puis `isUnderPath` sur le chemin FINAL ; `mkdir -p`
  AVANT la ligne ; une ligne de comptabilité existante DEVIENT le projet, ses `verify_*`
  conservés ; déjà enregistré → `already_registered`).

## Mesuré

- `attach.test.ts` (pglite, 10) : rattache / hors projet rien n'est créé / premier gagne /
  already_attached / imbriqués → le plus niché / masqué compte / Windows casse + frontière /
  ligne de comptabilité ≠ projet / sans job rien / cible `dir` = le projet.
- `attach-seam.test.ts` (2) : par `executeTool` + VRAI `file_write` dans un workspace temporaire
  réel → fichier relu, ligne `tool_calls`, `project_id` posé ; chemin hors terrain refusé, rien
  rattaché.
- `project-actions.test.ts` (8) : dossier + ligne relus ; doublon ; `../evil` refusé et RIEN
  au-dessus du terrain ; absolu refusé ; entité voisine → `workspace_not_found` ; comptabilité
  promue avec sa preuve ; liste sans la comptabilité, compte 2, dernière activité ; terrains.
- Mutations exécutées par moi : seam débranché → `expected null to be '<id>'` ;
  `isNull(project_id)` retiré → 2 rouges (premier gagne, already_attached). Passe 26 : repli
  de provenance retiré → `expected [ null, null ] to deeply equal ['digest-a','digest-b']`.
- Suites complètes : `packages/tools` vert, `packages/db` 258 vert, `apps/web` suites touchées
  vertes, runner `cli-runtime` et `cron` verts ; `pnpm typecheck` racine vert ; lint web 0 erreur.
- Migration 0093 appliquée sur la base dev (`runMigrations`).

## Ce dont je doute moi-même

### Le rattachement se fait AVANT l'écriture

Comme l'intention : le job est rattaché quand l'outil « va » écrire. Si `file_write` échoue
ensuite (quota, disque), le job porte un projet où rien n'a atterri. Conservateur comme
l'intention (« reste sale ») — mais ici c'est un registre d'affichage, pas une garde. Acceptable
ou faux ?

### Le terrain lui-même peut être le projet

`createProjectAction` accepte `subfolder: ''` (un dépôt attaché tel quel), alors que Quentin a
dit « un projet est un sous-dossier du terrain ». J'ai choisi le cas pratique (son propre dépôt
est un terrain ET un projet). Y a-t-il un cas où ça casse `attachProductionToProject` (un
terrain-projet englobe TOUT ce que l'agent écrit, y compris `terrain/vrac`) ? Faut-il l'exiger
strict ?

### Le second passage `realpath` touche le disque dans le seam

Uniquement quand le lexical ne trouve rien, mais c'est un `realpathSync.native` par projet
enregistré ET par cible, dans le chemin chaud d'une écriture. Coût réel ? Cas où il ment
(un projet enregistré dont le dossier a été supprimé → repli sur le chemin normalisé) ?

### `registered_from` + `registered_job_id` sans écrivain

P5 n'écrit jamais `registered_from = 'conversation'` : c'est P10 (la réponse à « où écrire ? »
crée le projet). Colonnes posées d'avance ou YAGNI ?

### `TextButton` élargi par un commentaire

La passe 26 disait « le contrat n'est pas tenu ». J'ai élargi le contrat documenté (disclosure
inline avec `aria-expanded`) plutôt que créer un composant DS de disclosure compact (qui
exigerait sa `.figma.tsx` et la parité Figma). Est-ce une décision de design que je n'avais pas
à prendre seul ? Si oui, dis-le : je la remonterai à Quentin telle quelle.

## Ce qui n'est PAS attendu

« Ça a l'air bien ». Deux verdicts : tient / faux. Dis explicitement si tu ne trouves rien de
neuf. Un constat non exécuté est marqué NON EXÉCUTÉ (sandbox lecture seule : ni pnpm ni git).
