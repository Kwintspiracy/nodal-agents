# Demande de review — PR #46 « Vérifier & Corriger — PR① » (passe 1)

Branche `feat/verifier-corriger-pr1`, base `main`. Diff : `git diff main...HEAD`.
Plan : `docs/plans/verifier-corriger.md` (sections « Le modèle central », « La primitive
terminale typée », « La livraison est une action sortante — outbox », « Décisions PR① »,
« Progression de PR① »). Découpage : `docs/validation/pr1-decoupage-tickets.md`.

## Ce que la PR affirme

1. **Intention de mutation** (`packages/tools/src/verification/intent.ts`, seam dans
   `packages/tools/src/execute.ts` `takeMutationIntent`, et `apps/runner/src/cli-runtime/run-job.ts`
   + `run-chat.ts`) : posée AVANT toute écriture, sur les cinq surfaces ; surface décochée ⇒ trace
   `agent_jobs.verification_skipped_surfaces`, jamais silencieux ; job terminal ⇒ refus d'écriture ;
   transaction courte FOR UPDATE job puis `code_projects` par clé croissante.
2. **Primitive terminale** (`apps/runner/src/job/finalize.ts`) : tx1 (FOR UPDATE, statut seul dit
   terminal, RÉCLAMATION `finalizing_at` libre/périmé/`input.claim`, capture de G, `loadConfig` sous
   verrou) → COMMIT → preuve hors transaction → tx2 (garde terminale, relecture epoch/manifeste ⇒
   `VERIFY_STALE_EPOCH`, `UPDATE état WHERE dirty_generation = G`, `completeJob`, `prepareDelivery`).
   Garde NON branchée : un projet rouge finit `completed` ; `verification_runs` best-effort.
3. **Registre de vérificateurs** (`apps/runner/src/verification/*`) : la primitive ne connaît aucun
   type de livrable.
4. **Outbox** (`apps/runner/src/delivery/outbox.ts`) : claim `UPDATE … RETURNING` avec
   `attempts < 3` et bail 2 × timeout d'envoi (240 s), reçu vide ⇒ confirmed, tout `rejected` alerte
   le propriétaire sur le canal réel, sweep ; `resolveDeliveryTarget` refuse `channel_inactive`.
5. **Bascules** : `execute.ts` (deux chemins de succès, sans livraison), `run-job.ts` (target +
   prepared + drain immédiat, envoi direct retiré), `cron/deliver-results.ts` (marqueur, payload figé,
   primitive/failJob/cancelRootJob, drain), `tick.ts` phase 7b (drain + sweep).
6. **Migrations 0088-0091** (`packages/db/migrations`) : `project_key` canonique + fusion des doublons,
   `job_deliverable_verification_state`, `verification_runs`, `job_deliveries`, `finalizing_at`,
   `verification_surfaces`, `verification_skipped_surfaces`.
7. **Web** : actions owner-only (`setCodeProjectVerifyCommandsAction`,
   `approveCodeProjectVerifyManifestAction` avec hash recalculé au serveur et jeton de concurrence,
   `setVerificationSurfacesAction`, `getCodeTabOwnerAction`), lecture des runs par `pipelineJobIds`
   et de la trace D8 (jamais du réglage courant), panneau `ProjectVerificationPanel`, section
   `VerificationSection`, réglage `VerificationSurfacesSection`.
8. **Tests d'architecture** (`packages/test-kit/src/architecture.ts`) : rien n'écrit hors du seam,
   status=completed hors primitive, aucun appelant de `completeJob` hors finalize.ts, send* hors
   outbox, primitive sans type de livrable.

## Questions, par priorité

P0 — correction et sûreté
- La séquence tx1 → preuve → tx2 laisse-t-elle un cas où un job finit `completed` avec un état
  `green` qui ne correspond pas à l'arbre courant ? (écritures d'un autre job, config changée,
  réclamation périmée reprise à tort après 10 min alors que le premier finaliseur est encore en
  preuve).
- Le claim de l'outbox peut-il produire deux envois (bail, `now` injecté, `attempts`, sweep) ? Une
  livraison peut-elle rester `prepared` à jamais ?
- L'intention : un chemin d'écriture existe-t-il encore SANS intention (outils mutants, runtime
  CLI, scripts de skill, MCP) ? Le refus `already_terminal` peut-il bloquer un cas légitime ?
- Migrations : la fusion des doublons de `code_projects` (0088) peut-elle perdre une préférence
  ou une approbation ? Le `DROP CONSTRAINT` par `pg_constraint` est-il sûr sur une base 0086 ?
- Web : une session non propriétaire peut-elle écrire ou lire hors de son espace via ces actions
  (IDOR sur `projectPath`, `jobId`, `pipelineJobIds`) ? L'approbation par jeton de hash peut-elle
  approuver un manifeste que le serveur n'a pas relu ?

P1 — invariants du dépôt
- Invariant #2 (aucun texte utilisateur dans tools/runner) et #4 (aucun repli silencieux) : cite
  toute phrase ou tout repli que les scanners ne voient pas.
- Les tests prouvent-ils le CÂBLAGE (exécution réelle, lignes relues) et non la fonction ? Cite un
  test qui passerait encore si le branchement était retiré.
- Les règles d'architecture peuvent-elles être contournées trivialement (motif évité, skipFiles
  trop large) ?

P2
- Performance : le drain du tick sans LIMIT, la relecture `loadConfig` FOR UPDATE en tx2, le
  readdir de l'intention sur les racines attachées.
- Cohérence des codes journalisés et des noms.

## Hors périmètre
- Le style, le nommage, la longueur des commentaires.
- Ce qui est explicitement reporté en ② (garde active, libellés de décision, extrait v5-B).

## Ce qui est attendu
Des constats tracés `fichier:ligne`, chacun avec « tient » ou « faux » et ce qui casse. Un constat
DÉDUIT sans exécution est dit comme tel. Pas de « ça a l'air bien ».
