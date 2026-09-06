# Demande de review — PR #46, passe 34 (les deux P1 de la passe 33 sur P5b)

Périmètre : **un commit**, `934091d4`, qui répond à la passe 33
(`docs/validation/rapport-review-pr46-passe33.md`). L'arbre de travail contient le chantier
P10a (`ask_user`) NON committé, d'un autre agent : relire l'état COMMITTÉ (`git show
934091d4`, `git show HEAD:<chemin>`), pas l'arbre.

- `apps/runner/src/cli-runtime/run-job.ts` : `auditWrites` (les promesses des insertions
  `tool_calls` de `onEvent`, toujours lancées sans attente) ; `await Promise.allSettled(auditWrites)`
  juste avant `harnessEdits`. Test : `intent-cli-runtime.test.ts`, bloc « passe 33 » — un Proxy
  de la base retarde de 80 ms les insertions dans `tool_calls` seulement, le binding factice
  appelle le VRAI `onEvent` (tool_use puis tool_result de `Write`), et `alpha` doit être déclaré.
- `packages/tools/src/projects/markers.ts` : `realPathOf` d'un chemin absent remonte à
  l'ancêtre EXISTANT le plus proche (`realpathSync.native`), rappend le reste ; `C:` seul est
  sondé comme `C:/`. Test neuf `markers.test.ts` (existant, feuille disparue, plusieurs segments
  absents, `..` sous un ancêtre existant, rien n'existe → tel quel ; `hasMarker`).
- `apps/runner/src/bootstrap/backfill-registered-projects.ts` : en-tête — l'historique
  rattaché est BORNÉ à la fenêtre du scan (commentaire seulement).

## Réponses aux constats de la passe 33

| Constat 33 | Réponse |
|---|---|
| P1 — course audit CLI / `harnessEdits` | `auditWrites` + `allSettled` avant la lecture ; échec journalisé, jamais bloquant |
| P1 — alias + cible disparue → `attach_registered_not_matched` | `realPathOf` remonte à l'ancêtre existant : la cible disparue sous un alias retombe sous la racine réelle, dans la déclaration (`rebaseOntoLexicalRoots`) COMME dans le second passage du rattachement |
| P1 — chemins Codex relatifs, plusieurs dossiers | INCHANGÉ côté résolution (premier dossier = cwd) ; un chemin `../app-b/src/x.ts` relatif au cwd se résout maintenant par `realPathOf` (le `..` est résolu par le disque tant qu'un ancêtre existe) ; le cas « `src/index.ts` relatif à un dossier secondaire » reste indécidable pour quiconque — dit dans la demande, pas dans le code |
| P1 — fenêtre du scan | dit dans l'en-tête du backfill et dans le plan |
| P2 — double journalisation | inchangé (non bloquant) |

## Mesuré

- tools : projects + intent 67 tests (markers 6) ; runner : CLI + backfill 19 ; typecheck des
  deux paquets ; lint des fichiers touchés 0.
- Mutations rouges puis restaurées : M15 `allSettled` retiré → le test de la course rougit
  (80 ms) ; M16 `realPathOf` sans remontée → « `..` sous un ancêtre existant » rougit.

## Questions, par priorité

### P0

1. **`Promise.allSettled(auditWrites)` attend AUSSI les insertions d'un tour qui a échoué
   ou dépassé son délai** (`binding.run` rend `isError`/`timedOut`) : peut-il rester une
   promesse qui ne se règle jamais (une insertion bloquée sur un verrou) et geler le tour après
   la CLI ? `createClient` pose `lock_timeout`/`idle_in_transaction_session_timeout` (30 s) —
   suffisant ?
2. **Le test de la course prouve-t-il la course ?** Sans le `allSettled`, `harnessEdits` lit
   AVANT l'insertion retardée de 80 ms — mais entre `binding.run` et la lecture, run-job fait
   d'autres `await` (recordCliRun, releaseHeld…). Si ces `await` prenaient > 80 ms sur une
   machine lente, le test resterait VERT sous mutation : est-ce plausible sur la CI, et
   faut-il un délai plus long ou un signal explicite (une promesse que le test résout lui-même
   APRÈS avoir observé la lecture) ?

### P1

3. **`realPathOf` et la casse Windows** : l'ancêtre existant est résolu (casse réelle du
   disque) mais le reste est rappendu TEL QUEL (casse de l'appelant) ; `isWithinRoot` replie la
   casse sur un chemin Windows, `projectKey` aussi. Un cas où la partie rappendue casse une
   comparaison ?
4. **`realPathOf('C:')`** → sondé comme `C:/` ; et un chemin UNC (`//serveur/part/...`) ?
   `normalizePath` les garde-t-il en `//` et la remontée s'arrête-t-elle proprement (`idx <= 0`)
   sans sonder `/` ou `//serveur` ?
5. **Le Proxy de test** intercepte `insert` et rend, pour `tool_calls`, un objet `{ values }`
   qui n'a plus `.returning()` : si `run-job.ts` enchaînait un jour `.returning()` sur cette
   insertion, le test casserait pour une raison étrangère à la course. Acceptable, ou le
   test doit-il déléguer tout sauf le délai ?

## Ce qui n'est PAS attendu

Le style. Un constat désigne un fichier, une ligne, et ce qui casse.
