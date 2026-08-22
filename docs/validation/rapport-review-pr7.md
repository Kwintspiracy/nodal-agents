## Verdict global : CONTREDIT

Deux défauts concrets rendent la protection incomplète :

1. Le checkpoint photographie toujours `ctx.workspaces[0]`, même lorsque l’outil écrit dans un autre workspace.
2. `git add -A` respecte les `.gitignore` du projet : les fichiers ignorés ne sont donc pas protégés.

Le premier défaut casse directement le filet de sécurité dans toute configuration multi-workspace.

## Environnement et limites

- Plateforme déclarée : Windows / PowerShell.
- Version exacte de Windows : **NON TESTÉE**.
- Versions Node, pnpm et Git : **NON TESTÉES**.
- Révision Git : **NON TESTÉE**.
- Environnement strictement en lecture seule.
- Aucun fichier modifié.
- Les mutations demandées n’ont pas été appliquées.
- Les essais créant des fichiers temporaires, des dépôts ou des checkpoints live n’ont pas été exécutés.

Tentatives de collecte des versions :

```text
COMMAND: node --version
Script error:
exec_command failed ... rejected: blocked by policy
```

Même rejet pour les commandes `git status`, `git diff`, `git --version`, `pnpm --version` et la lecture de la version Windows.

---

# Constats

## 1. CONTREDIT — le mauvais workspace est photographié

Fichier : `packages/tools/src/execute.ts`, lignes 499–501 et 516–529.

```ts
const workspace = ctx.workspaces?.[0]?.path;
```

La cible réelle de l’écriture n’est jamais utilisée. Pourtant les outils acceptent plusieurs workspaces et résolvent la cible depuis le chemin fourni.

Preuve du comportement multi-workspace :

- `packages/tools/src/builtin/file-ops/workspace.ts`, lignes 127–139 : sélection du workspace selon le label ou le chemin absolu.
- `packages/tools/src/builtin/file-ops/workspace.ts`, lignes 183–189 : un chemin comme `notes/a.md` sélectionne le workspace portant le label `notes`.
- `packages/tools/src/builtin/file-ops/file-write.ts`, lignes 68–77 : `file_write` appelle `resolveAndCheckPath(ctx, input.path)` et peut donc écrire dans n’importe quel workspace autorisé.

Ce qui casse concrètement :

- Avec `ctx.workspaces = [workspaceA, workspaceB]`, un `file_write` vers `workspaceB` prend un checkpoint de `workspaceA`.
- L’écriture dans `workspaceB` est ensuite autorisée.
- Restaurer ce checkpoint ne restaure rien dans `workspaceB`.
- Après le premier checkpoint du tour, la clé mémorisée est également construite avec `workspaceA` :

```ts
`${ctx.jobId}:turn:${ctx.turn}:${workspace}`
```

Toute autre écriture du même tour dans `workspaceB` est considérée comme déjà protégée.

Le test de câblage ne détecte pas ce défaut : `packages/tools/src/tests/checkpoint-wiring.test.ts`, lignes 57–67, ne configure qu’un seul workspace.

Commande :

```text
$ rg -n -C 15 "export const fileWriteTool|resolveAndCheckPath|workspaces" packages/tools/src/builtin/file-ops/file-write.ts packages/tools/src/builtin/file-ops/workspace.ts
```

Sortie brute pertinente :

```text
workspace.ts:131: *      ├─ Matches a workspace label → use that workspace
workspace.ts:137: *   └─ Try each workspace root in turn
workspace.ts:183:  const matchedWorkspace = workspaces.find((ws) => ws.label === firstSegment);
file-write.ts:77:      const path = await resolveAndCheckPath(ctx, input.path);
```

Sévérité : bloquante pour la promesse de restauration.

---

## 2. CONTREDIT — les fichiers ignorés par le projet ne sont pas protégés

Fichier : `packages/checkpoints/src/checkpoints.ts`, lignes 129–153.

Les exclusions propres au magasin sont écrites dans `info/exclude`, puis le snapshot utilise :

```ts
await git(store, workspace, ['add', '-A']);
```

Sans `-f` ni désactivation des règles d’exclusion, `git add` respecte également les `.gitignore` présents dans le workspace.

Ce qui casse concrètement :

- Un fichier ignoré, par exemple `.env`, `data/private.json` ou un fichier couvert par `.git/info/exclude` dans un cas ordinaire, n’entre pas dans l’arbre du checkpoint.
- Sa corruption ou sa suppression ne peut pas être réparée par `restoreCheckpoint`.
- Le test SHA-256 existant n’utilise qu’un fichier ordinaire `code.txt`; il ne couvre pas ce cas.

Fichiers et lignes :

- `packages/checkpoints/src/checkpoints.ts:132` — création du seul fichier d’exclusions voulu par le paquet.
- `packages/checkpoints/src/checkpoints.ts:153` — `git add -A`.
- `packages/checkpoints/src/checkpoints.test.ts:93–109` — test SHA-256 sur un fichier non ignoré.
- Aucun test contenant `.gitignore` ou un fichier ignoré n’a été trouvé, hors vérification qu’aucun `.gitignore` n’est créé.

Commande :

```text
$ rg -n "node_modules|EXCLUDES|info.*exclude|gitignore|add.*-A" packages/checkpoints/src
```

Sortie brute :

```text
packages/checkpoints/src\checkpoints.test.ts:73:    expect(existsSync(join(ws, '.gitignore'))).toBe(false);
packages/checkpoints/src\checkpoints.ts:48:const EXCLUDES = [
packages/checkpoints/src\checkpoints.ts:49:  'node_modules/',
packages/checkpoints/src\checkpoints.ts:132:    await writeFile(join(gitDir, 'info', 'exclude'), EXCLUDES.join('\n') + '\n', 'utf-8');
packages/checkpoints/src\checkpoints.ts:153:  await git(store, workspace, ['add', '-A']);
```

Sévérité : perte possible de données que l’utilisateur croit protégées.

---

## 3. CONTREDIT — la séparation des sessions n’est pas un namespace étanche

Fichiers :

- `packages/tools/src/builtin/code-task/db.ts`, lignes 224–225.
- `apps/runner/src/cli-runtime/run-job.ts`, lignes 91–102 et 221–233.
- `packages/db/src/schema/cli-runs.ts`, lignes 117–133.
- `apps/runner/src/routes/agent.ts`, ligne 21.

La clé de `code_task` est :

```ts
return `code_task:${jobId}:${cwd}`;
```

Mais le runtime écrit dans la même table avec :

```ts
const conversationKey = job.conversationId ?? job.chatId;
```

Et l’unicité porte seulement sur :

```ts
(agentId, conversationKey)
```

Le préfixe réduit le risque de collision accidentelle, mais ne crée pas un espace de clés distinct. `chatId` est accepté comme chaîne arbitraire :

```text
apps/runner/src/routes/agent.ts:21:  chatId: z.string().optional().nullable(),
```

Cas constructible :

- Même agent.
- `chatId = "code_task:<jobId>:<cwd>"`.
- Une ligne `code_task` existe sous cette clé.
- Le runtime fait un upsert sur la même contrainte unique et remplace `sessionId`.
- Le prochain appel reprend potentiellement une session provenant de l’autre chemin.

Ce qui casse concrètement : reprise d’un fil CLI sans rapport, ou écrasement réciproque des identifiants de session.

Commande :

```text
$ rg -n -C 5 "cliSessions|cli_sessions|conversationKey" packages/db/src
```

Sortie brute pertinente :

```text
packages/db/src\schema\cli-runs.ts:126:    conversationKey: text('conversation_key').notNull(),
packages/db/src\schema\cli-runs.ts:133:    uniqueIndex('cli_sessions_agent_conversation_unique').on(table.agentId, table.conversationKey),
```

Le test `session-resume.test.ts:27–36` vérifie seulement que la chaîne commence par `code_task:`. Il ne construit pas une collision avec une valeur runtime identique.

---

## 4. CONTREDIT — la sonde Git peut annoncer « clean » après un échec de `git status`

Fichier : `apps/runner/src/lib/workspace-git.ts`, lignes 44–51 et 64–80.

Chaque sous-commande Git convertit toute erreur en `null`. Après que la recherche de la racine a réussi, les trois autres sondes sont indépendantes :

```ts
const [branchRaw, statusRaw, headRaw] = await Promise.all([...]);

dirtyCount: statusRaw
  ? statusRaw.split('\n').filter(...).length
  : 0,
```

Ce qui casse concrètement :

- `rev-parse --show-toplevel` réussit.
- `git status --porcelain` échoue ou expire.
- `statusRaw` vaut `null`.
- Le résultat annonce `dirtyCount: 0`.
- Le prompt affirme alors `working tree: clean`, alors que l’état est inconnu.

Cela viole le principe « fail loud / pas de fallback intelligent silencieux » et peut conduire l’agent à agir comme si l’arbre était propre.

Aucun test de la sonde n’a été trouvé.

Commande :

```text
$ rg -n "probeWorkspaceGit" apps/runner/src --glob "*.test.ts" --glob "*.spec.ts"
```

Sortie brute :

```text
[aucune sortie]
```

Le comportement hors dépôt et sans Git retourne bien `null` si la première commande échoue. Le problème concerne l’échec partiel après détection de la racine.

---

# Priorité 1 — instantanés

## Test manuel SHA-256

**NON TESTÉ**

Le test source existe à `packages/checkpoints/src/checkpoints.test.ts:93–109` et compare effectivement le SHA-256 avant/après restauration. Je n’ai pas pu le refaire manuellement sans créer puis modifier des fichiers.

## Magasin fantôme ne touchant pas le workspace

**NON TESTÉ en live**

Lecture vérifiée :

- `GIT_DIR` pointe vers `join(store, 'store')`, ligne 99.
- `GIT_INDEX_FILE` pointe vers `join(store, 'indexes', key)`, ligne 103.
- `info/exclude` est écrit dans le magasin, ligne 132.
- Aucun appel d’écriture explicite vers `.git` ou `.gitignore` du workspace n’apparaît.

Mais l’absence effective de fichier apparu dans le workspace n’a pas été mesurée.

## Workspace déjà dépôt Git : historique, index et HEAD intacts

**NON TESTÉ**

La configuration externe de `GIT_DIR` et `GIT_INDEX_FILE` va dans le sens attendu, mais le test live demandé n’a pas été exécuté.

## Refus quand le checkpoint échoue

**NON TESTÉ en exécution**

Lecture vérifiée :

- `packages/tools/src/execute.ts:335–346` refuse l’appel si `takeCheckpointForTurn` renvoie une erreur.
- `packages/tools/src/execute.ts:523–537` attrape l’échec et produit `checkpoint_failed`.
- `packages/tools/src/tests/checkpoint-wiring.test.ts:157–175` construit un parent qui est un fichier et attend `outcome === "error"`.

La mutation `return null` n’a pas été appliquée. Je ne conclus donc pas que le test rougit réellement.

## Git absent du PATH pour les checkpoints

**NON TESTÉ**

À la lecture, `execFile('git', ...)` rejette, puis `takeCheckpointForTurn` attrape cette erreur et refuse l’écriture. Le comportement réel et le texte d’erreur n’ont pas été observés.

## Volume et exclusions sur ce dépôt avec `node_modules`

**NON TESTÉ**

Aucune mesure de durée n’a été effectuée.

## Concurrence

**NON TESTÉ**

Le commentaire de `checkpoints.ts:101–103` promet un index par workspace, pas par job. Deux jobs sur le même workspace partagent donc le même fichier d’index. Aucun essai concurrent n’a été réalisé.

---

# Priorité 2 — mutations du câblage

Toutes les mutations sont **NON TESTÉES**, car elles nécessitent de modifier les sources.

| Mutation demandée | Statut |
|---|---|
| `if (false && tool.mutatesWorkspace)` | NON TESTÉ |
| Retirer `mutatesWorkspace: true` de `file_write` | NON TESTÉ |
| Retirer `resumeSessionId` de `buildProviderArgs` | NON TESTÉ |
| Déplacer `gitBlock` dans la partie stable | NON TESTÉ |

La lecture montre toutefois que :

- Le test de marquage vise directement `fileWriteTool.mutatesWorkspace` à `checkpoint-wiring.test.ts:72–80`.
- Le test de câblage passe par le vrai `executeTool` à `checkpoint-wiring.test.ts:96–110`.
- Les tests de reprise inspectent les arguments à `session-resume.test.ts:111–144`.
- Les deux propriétés de cache sont testées à `workspace-git-block.test.ts:44–75`.

Je ne transforme pas cette lecture en résultat de mutation.

---

# Priorité 3 — continuité de session

## Séparation job/cwd

**VÉRIFIÉ par lecture et assertions sources, NON TESTÉ en exécution**

- `codeTaskSessionKey(jobId, cwd)` inclut les deux valeurs.
- Les tests `session-resume.test.ts:38–46` comparent deux jobs et deux cwd.
- `index.ts:290–300` utilise cette clé et réinjecte la session dans `buildProviderArgs`.

## Reprise réellement transmise

**VÉRIFIÉ par lecture, NON TESTÉ en mutation/live**

`packages/tools/src/builtin/code-task/index.ts:291–300` :

```ts
const resumeSessionId = ...
const args = buildProviderArgs(..., {
  ...
  ...(resumeSessionId ? { resumeSessionId } : {}),
});
```

## Formes froide et reprise Codex

**VÉRIFIÉ par lecture, NON TESTÉ avec le CLI**

`providers.ts:183–194` conserve `--ignore-user-config` dans les deux branches.

- Froid : `--sandbox read-only|workspace-write`.
- Reprise : `-c sandbox_mode="read-only|workspace-write"`.
- Les deux gardent `--skip-git-repo-check` et `--ignore-user-config`.

## Deux `code_task` live dans un même job

**NON TESTÉ**

---

# Priorité 4 — bloc Git

## Position après la frontière de cache

**VÉRIFIÉ par lecture, NON TESTÉ en mutation**

`packages/orchestration/src/system-prompt.ts:697–699` :

```ts
const volatile = runtimeBlock + memoryBlock + jobContextBlock + inventoryBlock + gitBlock;
return ... stable + SYSTEM_PROMPT_CACHE_BOUNDARY + volatile;
```

## Préfixe stable identique entre deux états Git

**NON TESTÉ en exécution**

Le test source existe à `workspace-git-block.test.ts:59–75`.

## Nom de branche encadré

**VÉRIFIÉ par lecture**

`system-prompt.ts:675–695` place l’ensemble du snapshot, branche comprise, dans :

```ts
wrapUntrusted('git snapshot', ...)
```

## Hors dépôt / Git absent

**VÉRIFIÉ par lecture, NON TESTÉ en live**

La première erreur renvoie `null` et le bloc est omis.

## Dépôt sans commit

**VÉRIFIÉ par lecture, NON TESTÉ en live**

- `headRaw` devient `null`.
- Le prompt rend `(no commit yet)`.
- La branche peut également être rendue comme detached HEAD si `rev-parse --abbrev-ref HEAD` échoue.

## HEAD détaché

**VÉRIFIÉ par lecture, NON TESTÉ en live**

La chaîne `HEAD` est convertie en `branch: null`, puis le prompt rend `(detached HEAD)`.

---

# Priorité 5 — paquet `@nodal-agents/checkpoints`

## Découpage

**VÉRIFIÉ par lecture**

Le paquet est partagé par :

- le runner pour créer les checkpoints ;
- le CLI pour les lister et les restaurer.

Ce besoin partagé justifie un paquet indépendant plutôt qu’un import de `apps/runner` par `apps/cli`.

Les règles d’architecture n’ont cependant pas été exécutées : validation dependency-cruiser **NON TESTÉE**.

## Dépendances

**VÉRIFIÉ pour le code de production**

Les imports de production sont exclusivement des builtins Node et des fichiers locaux.

Commande :

```text
$ rg -n "^import .* from" packages/checkpoints/src packages/checkpoints/package.json
```

Sortie brute pertinente :

```text
packages/checkpoints/src\root.ts:15:import { homedir } from 'node:os';
packages/checkpoints/src\root.ts:16:import { join } from 'node:path';
packages/checkpoints/src\checkpoints.ts:32:import { execFile } from 'node:child_process';
packages/checkpoints/src\checkpoints.ts:33:import { createHash } from 'node:crypto';
packages/checkpoints/src\checkpoints.ts:34:import { mkdir, writeFile } from 'node:fs/promises';
packages/checkpoints/src\checkpoints.ts:35:import { existsSync } from 'node:fs';
packages/checkpoints/src\checkpoints.ts:36:import { join } from 'node:path';
packages/checkpoints/src\checkpoints.ts:37:import { promisify } from 'node:util';
```

Nuance : `package.json:16–18` contient une dépendance de développement :

```json
"devDependencies": {
  "@nodal-agents/test-kit": "workspace:*"
}
```

Elle n’est pas importée par le code de production ni même par le test affiché. Si « aucune dépendance » est pris littéralement, l’affirmation est contredite ; si elle signifie « aucune dépendance runtime chargée par le CLI », elle tient.

---

# Non testé récapitulatif

- SHA-256 manuel.
- Restauration live.
- Intégrité d’un dépôt Git existant.
- Absence effective de traces dans le workspace.
- Git absent du PATH.
- Magasin en lecture seule.
- Disque plein.
- Mesure sur le dépôt complet et `node_modules`.
- Exclusions réellement observées.
- Toutes les mutations demandées.
- Deux `code_task` live consécutifs.
- Linux et macOS.
- Concurrence.
- E2E dashboard.
- Suites unitaires, architecture, régression et intégration.
- Versions des outils et révision exacte, commandes bloquées par la politique de lecture seule.
