# Demande de review — PR #46 « Vérifier & Corriger — PR① » (passe 2)

Branche `feat/verifier-corriger-pr1`, base `main`. Diff : `git diff main...HEAD`.
La passe 1 est dans `docs/validation/rapport-review-pr46-passe1.md` ; son traitement est dans le
dernier commit (`git log -1 -p` pour le diff exact) et dans la table « Progression de PR① » de
`docs/plans/verifier-corriger.md` (ligne « PR #46 ouverte, codex review passe 1 »).

## Ce que la passe 1 a obtenu

- **P0 outils Office** : hook partagé `officeMutationTargets` (packages/tools/src/builtin/office-ops/index.ts),
  surface `fileOps` étendue aux vingt écrivains (packages/shared/src/verification-surfaces.ts), test
  d'énumération vérifiant l'IDENTITÉ du hook + docx_create au seam (intent-wiring.test.ts).
- **P0 outbox** : horloge relue par ligne (`clock()`), issue gardée par `stillOurs` (attempted +
  claimed_by + attempts) avec le code `DELIVERY_CLAIM_LOST`, drain de reprise borné
  (`DRAIN_BATCH_LIMIT = 20`) — apps/runner/src/delivery/outbox.ts, tests ajoutés.
- **Trouvé en CI** : canon `realpath` des racines et des cibles dans
  packages/tools/src/verification/intent.ts (forme 8.3 du tmpdir GitHub Windows), test par lien.

## Ce qui a été REFUSÉ ou ASSUMÉ, à contester si tu as un argument neuf

- L'alerte owner `DELIVERY_REJECTED …` reste : c'est une notification système, comme
  apps/runner/src/approvals/notify.ts, pas la voix de l'agent.
- L'envoi orphelin après timeout puis reprise après bail peut doubler : aucun adaptateur
  n'accepte d'annulation ni d'idempotence ; assumé et dit.
- Les règles d'architecture sont lexicales, comme tous les scanners du dépôt ; les tests de câblage
  (intent-wiring, intent, run-job-delivery, deliver-results) complètent.

## Questions pour cette passe

P0
- Les correctifs de la passe 1 introduisent-ils un défaut ? En particulier : `clock()` par ligne
  avec `opts.now` injecté (les tests de bail restent-ils justes ?), `stillOurs` face au sweep
  (`sweepExhaustedDeliveries` ne passe pas par `stillOurs` : un sweep concurrent d'un envoi en
  cours peut-il rejeter une ligne réclamée ? avec `attempts >= 3` et bail expiré seulement) ;
  la borne de 20 peut-elle affamer une livraison (ordre `created_at`) ?
- Le canon `realpath` : une racine qui n'existe pas encore, un lien vers l'extérieur du
  workspace, une casse différente sur Windows — la clé produite est-elle la même que celle de
  `projectKey` côté web (apps/web/src/lib/code-projects.ts) ?
- Le hook Office : un outil Office dont `input.path` cible un fichier HORS des racines attachées
  (refusé par resolveAndCheckPath) — rend `[]`, donc `no_targets`, et l'écriture est refusée par
  execute ensuite : y a-t-il un chemin où l'écriture PASSE sans intention ?
P1
- Reste-t-il un écrivain de fichier dans packages/tools ou apps/runner sans `mutatesWorkspace`
  (skill_file_write, create_mcp, dashboard_publish, media, MCP stdio) ? Nomme-le, avec le fichier.
- Un constat de la passe 1 marqué TIENT qui ne tient plus après les correctifs ?

## Ce qui est attendu
Des constats tracés `fichier:ligne`, TIENT/FAUX, ce qui casse ; déduit vs vérifié. Une passe qui ne
trouve rien de neuf le dit en une ligne.
