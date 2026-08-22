## Verdict global : CONTREDIT

Les correctifs principaux tiennent à la lecture, mais deux nouveaux défauts ont été introduits. Aucun fichier n’a été modifié.

## Constats nouveaux

### 1. CONTREDIT — la limite des checkpoints reste invisible pour l’utilisateur

Fichiers :

- `packages/checkpoints/src/checkpoints.ts:65`
- `packages/checkpoints/src/index.ts:22`
- `apps/cli/src/commands/checkpoints.ts:13`
- `apps/cli/src/commands/checkpoints.ts:26`
- `apps/cli/src/commands/checkpoints.ts:50`

Le correctif exporte `CHECKPOINT_COVERAGE_NOTE` et son commentaire affirme qu’elle est « Rendered wherever checkpoints are presented to a human ». Or la recherche globale ne trouve son utilisation que dans son export et dans son propre test. La commande CLI qui liste et restaure les checkpoints ne l’importe jamais.

Ce qui casse concrètement :

- `nodal-agents checkpoints list` continue d’annoncer des « Snapshots taken before an agent writes » sans préciser que les fichiers ignorés ne sont pas couverts.
- `nodal-agents checkpoints restore` annonce « Restored » sans préciser que `.env`, données locales et caches ignorés restent inchangés.
- Le test `checkpoints.test.ts:224-228` prouve uniquement que la constante contient certains mots, pas qu’un humain la voit.
- Le compromis présenté comme acceptable « while it is SAID » n’est donc pas satisfait dans le produit.

Preuve :

```text
$ rg -n "CHECKPOINT_COVERAGE_NOTE" . --glob "!node_modules/**"

packages/checkpoints/src/index.ts:22
packages/checkpoints/src/checkpoints.ts:65
packages/checkpoints/src/checkpoints.ts:176
packages/checkpoints/src/checkpoints.test.ts:24
packages/checkpoints/src/checkpoints.test.ts:226
packages/checkpoints/src/checkpoints.test.ts:227
```

Aucune occurrence dans `apps/cli`.

### 2. CONTREDIT — un workspace secondaire indisponible bloque les écritures dans tous les autres

Fichier : `packages/tools/src/execute.ts:501-558`.

Pour corriger la sélection du mauvais workspace, `takeCheckpointForTurn` photographie maintenant chaque entrée de `ctx.workspaces` avant toute écriture :

```ts
for (const ws of workspaces) {
  ...
  await snapshot(store, workspace, ...);
  ...
  return `checkpoint_failed: ...`;
}
```

Ce qui casse concrètement :

- Agent configuré avec `shared` et `archive`.
- `shared` est disponible et l’outil veut écrire `shared/a.txt`.
- `archive` est momentanément inaccessible, supprimé, démonté ou refuse la lecture.
- Son snapshot échoue.
- `file_write` vers `shared/a.txt` est refusé, alors que la cible réelle était disponible et avait déjà été correctement photographiée.

Le même problème augmente linéairement le coût de chaque premier outil mutant d’un tour : une écriture dans un petit workspace déclenche aussi `git add -A` dans chaque gros workspace sans rapport.

Les nouveaux tests, `packages/tools/src/tests/checkpoint-wiring.test.ts:178-235`, utilisent deux répertoires disponibles et petits. Ils vérifient que le second est couvert, mais pas qu’une cible saine reste utilisable lorsqu’un workspace non ciblé est défaillant.

## Correctifs examinés sans nouveau défaut démontré

- État Git inconnu : `dirtyCount: null` est correctement propagé et rendu comme `UNKNOWN`.
- Collision future des clés de sessions : les deux chemins runtime appellent désormais `assertRuntimeSessionKey`.
- Séparation job/cwd et reprise de session : aucune nouvelle divergence trouvée à la lecture.
- Checkpoint multi-workspace : tous les workspaces sont désormais couverts, sous réserve du nouveau refus global décrit ci-dessus.

## NON VÉRIFIÉ

- Tests Vitest, typecheck, lint et mutations : **NON VÉRIFIÉ**, l’environnement est strictement en lecture seule et les exécutions susceptibles d’écrire ont été évitées.
- SHA-256 et restauration live : **NON VÉRIFIÉ**.
- État réel de la base : **NON VÉRIFIÉ**. Le garde-fou empêche les nouvelles écritures runtime préfixées, mais aucune migration ne nettoie d’éventuelles lignes déjà contaminées. `findResumableSession`, `packages/tools/src/builtin/code-task/db.ts:262-276`, reprendrait encore une ancienne ligne collisionnée si elle existe.
- Versions Node, pnpm, Git et Windows : **NON VÉRIFIÉ**, les commandes de version ont été rejetées par la politique d’exécution.
