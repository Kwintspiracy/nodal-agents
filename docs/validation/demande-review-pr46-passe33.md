# Demande de review — PR #46, passe 33 (les correctifs de la passe 32 sur P5b)

Périmètre : **deux commits**, `4491ae46` et `aefdcec3`, qui répondent à la passe 32
(`docs/validation/rapport-review-pr46-passe32.md`). Même branche, aucun autre changement de
code dans l'arbre (un agent code P10a en parallèle dans d'AUTRES fichiers : `ask_user`,
`approval_requests.kind/answer`, Telegram, web Approvals — hors périmètre de cette passe, ne
pas relire ce qui n'est pas committé).

- `packages/tools/src/projects/attach.ts` : `registerManifestProjects` ne retient que les
  cibles `kind: 'file'` ; déclaration + `markJob` + conversation dans `db.transaction`, avec
  `AttachRollback` (code) : `attach_registered_without_anchor` (sans job ET conversation
  introuvable), `attach_registered_not_matched` (une racine déclarée ne contient aucune cible —
  incohérence), et la panne de `markJob` (rollback, code de `markJob`).
- `apps/runner/src/cli-runtime/run-job.ts` : `harnessEdits` résout SANS le disque
  (`resolveScannedPath(p, author, roots, () => true)` — relatif = relatif au cwd, premier
  dossier) ; commentaires du repli retournés ; `run-chat.ts` idem.
- `apps/runner/src/job/code-projects.ts` : `ScannedWrite.jobId`, `RawProject.jobIds`.
- `apps/runner/src/bootstrap/backfill-registered-projects.ts` : `registered_at = now()` ;
  `agent_id` = l'unique détenteur sinon NULL ; compteurs `skipped.{missing,noMarker,hidden,
  alreadyRegistered}` ; RATTACHE l'historique (`agent_jobs.project_id` où NULL, « le premier
  gagne ») pour tout projet dérivé au registre — déclaré par cette passe OU déjà déclaré
  (`aefdcec3`).
- Tests : `attach.test.ts` (h, h bis, i, i bis, j), `intent-cli-runtime.test.ts` (le cas
  « terrain à manifeste sans édition » retourné : ne déclare RIEN), `backfill-registered-projects.test.ts`
  réécrit (second agent, `app2` pré-déclaré depuis Spaces intact et son job rattaché).

## Ce que la passe 32 a demandé, et ce qui a été fait

| Constat 32 | Réponse |
|---|---|
| P0 — tour réussi sans édition déclare le terrain | seules les cibles FICHIER déclarent ; les cibles `dir` (repli CLI, chat CLI, shell) rattachent seulement |
| P1 — `agent_id` non déterministe | NULL dès qu'il y a plusieurs détenteurs |
| P1 — `registered_at` = dernière activité | `now()` (l'instant de la déclaration) ; l'activité vit sur les jobs rattachés — d'où le rattachement de l'historique |
| P1 — fichier écrit puis supprimé | résolution sans le disque, relatif au cwd |
| P1 — jonctions, deux alias lexicaux | INCHANGÉ : c'est D10 (racines attachées qui se recouvrent), arbitrage de Quentin en attente, dit dans le plan |
| P2 — compteur `skipped` | par raison |
| Hors question — déclaration avant validation des ancres | transaction + rollback sans ancre |
| Hors question — déclaration non atomique sur plusieurs racines | la même transaction |

## Mesuré

- tools 887 ; runner 1296 (un `.pg.test.ts` de concurrence sur Postgres réel a échoué sous
  charge, un autre à la passe précédente ; chacun passe seul — non modifiés, hors périmètre) ;
  typecheck racine 33/33 ; dependency-cruiser 0 ; lint 0 erreur (1 avertissement préexistant,
  `execute.ts:814`).
- Mutations rouges puis restaurées : M9 cibles `dir` déclarent (attach h) ; M9b idem côté
  CLI ; M10 rollback sans ancre retiré (attach i) ; M11 historique non rattaché ; M12 premier
  détenteur au hasard ; M13 compteurs confondus ; M3 `setWhere` (rejouée) ; M14 historique des
  projets déjà déclarés ignoré.
- Base dev : `registered_at` des 3 projets corrigé (dev seulement, dit dans le script), backfill
  rejoué : `registered=0 jobs_attached=5 skipped_no_marker=1 skipped_hidden=8
  skipped_already_registered=3` — vérifié par une requête directe : 3 + 1 + 1 jobs portent bien
  les trois projets.

## Questions, par priorité

### P0

1. **La transaction et le seam.** `attachProductionToProject` est appelé APRÈS l'écriture
   réussie, hors du try/catch de l'outil (execute.ts § 3.5) et depuis run-job/run-chat. Une
   transaction qui échoue est rattrapée et rendue `failed` ; mais y a-t-il un appelant qui
   passe DÉJÀ une transaction (`tx`) comme `db` — auquel cas `db.transaction` imbriquée
   ouvrirait un SAVEPOINT (drizzle) ou échouerait ? Vérifier les trois sites d'appel.
2. **`AttachRollback` levée pour `attach_registered_not_matched`** : la racine déclarée par
   `resolveProjectRoots` contient la cible par `isWithinRoot(dir, root)` puis
   `projectPath = root` ou `root/child`, tandis que `projectContaining` compare
   `normalizePath(target.path)` (chemin RÉEL de l'outil) à la racine LEXICALE déclarée. Sur
   une jonction / un `RUNNER~1`, la première recherche (lexicale) échoue, la seconde (réelle
   des deux côtés) doit réussir. Un cas où les deux échouent après une déclaration — donc un
   rollback systématique et un projet jamais déclaré ?
3. **Le rollback sans ancre** ne s'applique que si `registered.length > 0` : sans déclaration
   neuve, `conversation: 'not_found'` sans job reste une issue `attached` comme avant (le
   projet existait déjà). Voulu ; à confirmer que rien d'autre ne dépend de l'ancien ordre.

### P1

4. **`harnessEdits` sans le disque** : pour un agent à PLUSIEURS dossiers et une ligne `cli:*`
   à chemin relatif sans label, `resolveScannedPath` rend maintenant le PREMIER dossier (le
   cwd du harnais). L'onglet Code, lui, consulte le disque pour la même ligne. Divergence
   assumée (dite en commentaire) ; un cas où elle déclare un projet FAUX (un fichier du second
   dossier attribué au premier) ? Les chemins de Claude Code sont absolus ; ceux de Codex
   (`cli:file_change`) le sont-ils (vérifier `apps/runner/src/cli-runtime/codex-turn.ts` /
   `audit.ts`) ?
5. **Le rattachement de l'historique** prend `project.jobIds` de la fenêtre du scan
   (`SCAN_LIMIT = 1500` lignes `tool_calls`) : les jobs plus anciens ne sont jamais rattachés,
   et le cache 60 s du scan peut rendre une liste sans les jobs de la dernière minute — qui,
   eux, sont rattachés au fil de l'eau. Acceptable ? Le dire suffit-il ?
6. **`registered_at` corrigé sur la base dev par un script** (`apps/runner/.cache`, non suivi
   par git) : aucune migration ne le fait — vérifié : aucune autre install n'a exécuté la
   première version (jamais publiée). Un doute ?

### P2

7. `AttachRollback` étend `Error` avec un `code` — la trace `PROJECT_ATTACH_FAILED code=…`
   est émise deux fois pour la panne de `markJob` (une fois par `markJob`, une fois par le
   catch). Gênant ?

## Ce qui n'est PAS attendu

Le style, le nommage. Un constat désigne un fichier, une ligne, et ce qui casse.
