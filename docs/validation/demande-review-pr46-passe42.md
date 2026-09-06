# Demande de review — PR #46, passe 42 (P11 : fichiers et diff)

Périmètre : **un commit**, `e6713458` (28 fichiers). Codé par un agent Opus sur spec
(`spec-p11-fichiers-diff`), tombé sur sa limite de session pendant la suite web ; relu,
complété (formatage) et vérifié par l'orchestrateur : 8 mutations rouges. L'arbre de travail
contient un petit chantier P10b NON committé (`register-project.ts`, son test,
`system-prompt.ts`, son test) : relire l'état COMMITTÉ, jamais l'arbre.

- `packages/db` : migration `0099_job_checkpoints.sql` (`job_id` FK cascade, `turn`,
  `workspace` texte, `sha`, `taken_at`, unique `(job_id, turn, workspace)`, index `job_id`),
  `schema/job-checkpoints.ts`, `tests/helpers.ts`.
- `packages/checkpoints/src/checkpoints.ts` : `gitEnv`/`gitRaw` (sans `trim`, `maxBuffer` 8 Mo),
  `headCheckpoint(store, workspace)`, `diffFile(store, workspace, fromSha, toSha | null, relPath)`
  → `diff | binary | unchanged | not_in_snapshot` ; `--numstat` d'abord (unchanged / `-\t-` =
  binaire), `toSha === null` ⇒ `git add -A -- <relPath>` puis `diff --cached <fromSha>` ;
  `DIFF_MAX_BYTES` 200 Ko ; tests sur un vrai dépôt fantôme (24).
- `packages/tools/src/execute.ts` : `recordTurnCheckpoint` après `snapshot` — ligne
  `(jobId, ctx.turn, workspace, cp.sha ?? headCheckpoint)`, `ON CONFLICT DO NOTHING`, jamais
  bloquant (`CHECKPOINT_ROW_FAILED`), pas de ligne sans `ctx.turn` ; test `checkpoint-wiring`.
- `apps/runner/src/cli-runtime/run-job.ts` : `takeCliTurnCheckpoints` avant `binding.run` en
  mode `write` (tour = 1 + `count(cli_runs du job)`), un échec d'instantané lève
  `checkpoint_failed:<cause>` sous le filet de l'intention (verrous rendus) ; test
  `checkpoint-cli-runtime`.
- `apps/runner/src/routes/file-diff.ts` + `server.ts` : `GET /api/jobs/:jobId/file-diff?toolCallId&path`
  derrière `requireRunnerAuth`, entité vérifiée pour un appelant non de confiance (404 sinon) ;
  `file_edit` → `{ kind: 'fragment', oldString, newString, path }` sans git ; sinon chemin =
  `?path` (DOIT figurer sur la carte `presented.files` de la ligne) ou `scannedEditPath(row)`,
  résolu par `resolveScannedPath` (dossiers de l'agent + dossiers des instantanés du job),
  dossier = plus long préfixe parmi les dossiers photographiés, `from` = instantané du tour de
  la ligne, `to` = tour suivant du même dossier sinon arbre de travail (`to: 'next_turn' |
  'working_tree'`) ; codes `no_checkpoint | path_unresolved | workspace_unreachable |
  not_in_snapshot` ; test `routes/file-diff` (8).
- `packages/shared/src/fragment-diff.ts` : `fragmentDiff` (LCS par lignes, borné
  `FRAGMENT_DIFF_MAX_LINES`) ; `apps/web/src/lib/line-diff.ts` devient sa vue `op`.
- `apps/web` : `lib/file-diff-actions.ts` (`getFileDiffAction` : session, entité, relais au runner
  avec `WORKER_SECRET`), `spaces/FileDiff.tsx` (`DisclosureButton`, chargement au clic, cache
  par panneau, `gitDiffLines`, `DiffBody` par état, « No diff: <raison> »), `FilesCard` :
  un fichier `listed` ou sans `toolCallId` n'a pas de bouton ; `ToolStep.jobId`.

## Mesuré

checkpoints 24 ; tools 145 (wiring 17, seam, cards, builtins) ; runner 30 (route 8, CLI
instantané 4, intention CLI 18) ; shared 8 ; db 258 ; web 69 (FileDiff 9, action, fil) ;
`pnpm typecheck` 33/33 ; dependency-cruiser 0 ; lint 0 erreur. Migration 0099 appliquée sur
la base dev. Mutations rouges puis restaurées : ligne `job_checkpoints` non écrite (4) ;
harnais sans instantané (3) ; chemin hors carte accepté (1) ; entité de l'appelant ignorée
(1) ; binaire non détecté (1) ; fichier lu avec bouton (1) ; LCS sans ligne commune (3).

## Questions, par priorité

### P0 — sécurité et exactitude du diff

1. **La route lit le disque de l'hôte** (`git diff` sur le magasin fantôme, `GIT_WORK_TREE` =
   un dossier attaché). Le chemin vient soit de la ligne d'audit, soit de `?path` vérifié
   contre `presented.files`. Un `presented.files[].path` forgé par un outil MCP tiers (qui
   déclare une carte `files`) pourrait-il désigner un fichier HORS du dossier attaché
   (`../../secret`) — `within`/`relative` le refusent-ils (`relPath.startsWith('../')`) ? Et un
   lien symbolique dans le dossier ?
2. **`git add -A -- <relPath>` dans le magasin** pour le cas « arbre de travail » : il modifie
   l'INDEX du magasin fantôme (par dossier). Deux lectures concurrentes du même dossier
   (`GIT_INDEX_FILE` partagé par dossier) ou une lecture pendant un `snapshot` en cours
   peuvent-elles corrompre l'index ou faire photographier un état partiel au tour suivant ?
3. **Le tour de la ligne CLI** : `takeCliTurnCheckpoints` numérote `1 + count(cli_runs)`, et la
   ligne `tool_calls` `cli:*` porte-t-elle le MÊME `turn` ? Vérifier `buildCliAuditRow` /
   `onEvent` : si `tool_calls.turn` est NULL pour les lignes CLI, la route rend
   `no_checkpoint` pour tout fichier du harnais — et la pierre ne tient pas pour le cas qui l'a
   motivée.
4. **`file_write` d'un fichier NEUF** (n'existait pas à l'instantané) : `diffFile` avec `toSha`
   null restage le chemin et compare — le diff montre tout en `+` ? Et avec `toSha` (tour
   suivant) où le fichier existe : `ls-tree` le trouve. Un cas où un fichier créé puis
   supprimé dans le même tour rend `not_in_snapshot` au lieu d'un diff ?

### P1

5. **Le harnais refuse le tour si l'instantané échoue** : un terrain énorme (un `node_modules`
   non ignoré, des Go de données) rend `snapshot` très lent ou en échec (`maxBuffer`,
   `GIT_TIMEOUT_MS`) — le runtime CLI qui marchait hier refuse aujourd'hui. Le seam a le même
   contrat pour les outils Nodal ; est-ce acceptable pour le harnais, ou faut-il une porte de
   sortie dite (un réglage) ?
6. **`ToolStep.jobId`** ajouté pour la carte : cohérent avec le reste du fil (les cartes de
   délégation, la question) ?
7. **`FileDiff` charge par `getFileDiffAction`** à chaque premier clic ; la page se rafraîchit
   toutes les 3 s (`LiveRefresh`) : le panneau ouvert survit-il au `router.refresh()` (état
   client conservé) ou se referme-t-il et perd son diff ?

### P2

8. Les phrases « No diff: … » sont dans le web (pas le runner) : conforme à la lecture de
   l'invariant #2 retenue au plan.
9. `DIFF_MAX_BYTES` 200 Ko et `FRAGMENT_DIFF_MAX_LINES` 2 000 : dits à l'écran (« … truncated ») ?

## Ce qui n'est PAS attendu

Le style, le nommage. Un constat désigne un fichier, une ligne, et ce qui casse.
