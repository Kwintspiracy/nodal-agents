# Rapport de validation — installation / mise à jour 0.8.5

Date d'exécution : 21 août 2026  
Branche : `feat/code-task-etape-b`  
Commit testé : `e01175f`  
Plateforme : Windows, Node `v26.4.0`, pnpm `10.33.2`

## Verdict synthétique

| Étape | Verdict | Preuve principale |
|---|---|---|
| Pré-requis | PASSÉ | Node `v26.4.0`, pnpm `10.33.2`, environ 2,7 TiB libres sur `D:`. |
| 0 — construction | PASSÉ avec écart de protocole | Build code 0, `38 chunks`, `34 entries`, `46` dépendances épinglées. Le tarball n'existe toutefois pas à la sortie de `pack:build`; il est créé par `pack:smoke`. |
| 1 — installation neuve | PASSÉ | Code 0, `46/46 healthy`, `runner /api/health`, `web /api/health`, `web page render`. |
| 2 — upgrade 0.8.1 → 0.8.5 | PASSÉ | Code 0, services sains, dashboard rendu, clé maître inchangée, `pg-data` préservé. |
| 3a — Ctrl+C puis relance | ÉCHOUÉ | La relance affiche `Found 1 orphan process ... web on :3000 (pid 57924)`. |
| 3b — port étranger | PASSÉ | Code 1 attendu; le CLI nomme le PID 56980, refuse de le tuer, puis `PORT_HOLDER_ALIVE True`. |

Conclusion : les parcours d'installation neuve et de mise à jour sont fonctionnels, mais la validation complète n'est pas verte. Le bug B4 de processus Next survivant à Ctrl+C est reproduit.

## Pré-requis et état initial

Commandes exécutées :

```powershell
node --version
npx.cmd --yes pnpm@10.33.2 --version
git branch --show-current
git rev-parse --short HEAD
```

Sortie utile :

```text
v26.4.0
10.33.2
feat/code-task-etape-b
e01175f
```

Une instance Nodal préexistante répondait sur `http://localhost:3000/api/health` avec le statut `200`. Les scripts isolés ne l'ont pas perturbée : après `pack:smoke` puis `pack:upgrade`, le statut était encore `200`.

## Étape 0 — construire le paquet

### Installation des dépendances

Commande exacte :

```powershell
npx.cmd --yes pnpm@10.33.2 install
```

Code de sortie : `0`.

```text
Scope: all 32 workspace projects
Lockfile is up to date, resolution step is skipped
Already up to date
Done in 53.1s using pnpm v10.33.2
```

pnpm a aussi signalé neuf scripts de build ignorés. Ce n'est pas devenu bloquant pour les scénarios suivants.

### Construction

Commande exacte :

```powershell
npx.cmd --yes pnpm@10.33.2 pack:build
```

Code de sortie : `0`.

```text
✔ Web chunk integrity: 38 chunks, 34 entries, none missing
✔ Pinned 46 runtime deps to their exact installed versions (next@16.3.0)
✔ bundledDependencies staged in pack/node_modules
✔ Pack assembled at D:\APPS\NodalAI\pack
  cli.js    0.59 MB
  runner.js 22.21 MB
  web/server.js 0.01 MB
```

Contrôle de `pack/package.json` : `46` dépendances runtime, `0` caret, `0` tilde, `next` exactement à `16.3.0`.

Le build a affiché plusieurs avertissements Next `Failed to copy traced files ... ENOENT`, notamment vers des chemins mal formés du type :

```text
D:\APPS\NodalAI\apps\web\.next\standalone\C:\Users\kwint\.codex
D:\APPS\NodalAI\apps\web\.next\standalone\C:\Users\kwint\.nodalai\workspaces\...
```

Ils n'ont pas fait échouer le build et le contrôle d'intégrité des chunks a réussi. Conformément au protocole, ce n'est donc pas classé comme bloquant, mais l'écart est signalé.

### Écart du protocole

Immédiatement après `pack:build` :

```text
TARBALL_EXISTS False
```

La sortie du script indique elle-même :

```text
Next steps:
  cd pack && npm pack       # produce nodal-agents-0.8.5.tgz
```

Le document affirme que `pack/nodal-agents-0.8.5.tgz` est attendu après cette étape, mais `pack:build` ne le produit pas. Le tarball est produit au début de `pack:smoke`. C'est un défaut du protocole, pas un échec du paquet.

## Étape 1 — installation neuve

Commande exacte :

```powershell
npx.cmd --yes pnpm@10.33.2 pack:smoke
```

Code de sortie : `0`.

Sortie probante :

```text
▶ Creating tarball
nodal-agents-0.8.5.tgz
  nodal-agents-0.8.5.tgz (version 0.8.5)

✅ Web build: 38 server chunks, 34 entries, none missing
46/46 healthy
✅ Every module is installed and loads.

✔ runner /api/health
✔ web /api/health
✔ web page render

✅ A clean install of nodal-agents@0.8.5 boots and serves.
```

Artefact final :

```text
Path   D:\APPS\NodalAI\pack\nodal-agents-0.8.5.tgz
Bytes  25215691
SHA256 FFCB438021787FF8B5F1CEED35219856FA504852BA277134706D18AA9AFA324A
```

À l'arrêt, le script a affiché :

```text
postgres (pid 56552) is STILL RUNNING after a graceful stop
```

Une vérification effectuée juste après la fin du script a donné `POSTGRES_56552_ALIVE False`. Il ne s'agit donc pas d'un processus durablement orphelin, mais le diagnostic est trompeur et mérite d'être signalé.

## Étape 2 — mise à jour depuis 0.8.1

Commande exacte :

```powershell
npx.cmd --yes pnpm@10.33.2 pack:upgrade -- --from 0.8.1
```

Code de sortie : `0`.

Sortie probante :

```text
✔ installed 0.8.1
⚠ 0.8.1 did NOT become healthy — continuing, the upgrade is the point
✔ present: ~\.nodalai\config.json
✔ present: ~\.nodalai\secrets.key
✔ present: ~\.nodalai\pg-data\PG_VERSION

✔ now on 0.8.5
✔ runner + web healthy
✔ dashboard renders
✔ master key unchanged (encrypted rows stay readable)
✔ pg-data preserved
√ All services healthy

✅ 0.8.1 → 0.8.5: an existing install upgrades, boots, serves, and keeps its data.
```

L'avertissement sur la santé de 0.8.1 est explicitement autorisé par le protocole.

À l'arrêt, le script a également affiché `postgres (pid 51180) is STILL RUNNING after a graceful stop`, puis une vérification après la fin a donné `PID_51180_ALIVE False`. Même diagnostic transitoire trompeur qu'à l'étape 1.

## Étape 3a — Ctrl+C puis relance

Commande exacte, premier démarrage :

```powershell
npx.cmd --yes pnpm@10.33.2 --filter nodal-agents exec tsx src/index.ts --dev
```

Sortie avant interruption :

```text
√ Runner started (pid 29400)
√ Web started (pid 56604)
√ All services healthy
Nodal-Agents ready at http://localhost:3000
Ctrl+C to stop all services
```

Un vrai Ctrl+C a été envoyé au terminal. Sous `cmd.exe`, la confirmation `Terminate batch job (Y/N)?` a reçu `Y`. Le wrapper a terminé avec le code `1`.

Deux secondes après l'interruption :

```text
PORT_3000_LINES
TCP  0.0.0.0:3000  0.0.0.0:0  LISTENING  57924
PORT_3001_LINES
TCP  127.0.0.1:3001  0.0.0.0:0  LISTENING  53544
PORT_25440_FREE
PID_29400_ALIVE False
PID_56604_ALIVE False
```

Le PID 53544 s'est terminé avant la lecture CIM. Le survivant durable était :

```text
ProcessId       : 57924
ParentProcessId : 26256
Name            : node.exe
ExecutablePath  : C:\Program Files\nodejs\node.exe
CommandLine     : "C:\Program Files\nodejs\node.exe" D:\APPS\NodalAI\node_modules\.pnpm\next@16.3.0_@babel+core@7.2_8db03515ebb71a36552c0951dda56954\node_modules\next\dist\server\lib\start-server.js
```

Commande exacte de relance :

```powershell
npx.cmd --yes pnpm@10.33.2 --filter nodal-agents exec tsx src/index.ts --dev
```

Sortie d'échec du critère, reproduisant B4 :

```text
(node:57156) [DEP0205] DeprecationWarning: `module.register()` is deprecated.
Found 1 orphan process on configured ports:
  - web on :3000 (pid 57924)
Cleaning up before starting…
Orphans cleaned up.
- Starting embedded Postgres…
[nodalai] pgvector extension not available — semantic memory search disabled.
√ Postgres ready on port 25440
- Applying database migrations…
√ Migrations applied
- Seeding default user and agent…
√ Seed complete
- Starting runner…
√ Runner started (pid 28940)
- Starting web (dev — HMR)…
√ Web started (pid 43940)
- Waiting for services to be healthy…
√ All services healthy
```

Verdict : **ÉCHOUÉ — défaut produit**. Le second démarrage récupère la situation, mais l'attendu était précisément qu'il ne trouve aucun orphelin.

## Étape 3b — processus étranger sur le port 3000

Serveur étranger créé pour le test :

```text
PORT_HOLDER_READY pid=56980
TCP 127.0.0.1:3000 0.0.0.0:0 LISTENING 56980

ProcessId       : 56980
ParentProcessId : 54700
Name            : node.exe
ExecutablePath  : C:\Program Files\nodejs\node.exe
CommandLine     : "C:\Program Files\nodejs\node.exe" scripts/validation-port-holder.mjs
```

Commande exacte testée :

```powershell
npx.cmd --yes pnpm@10.33.2 --filter nodal-agents exec tsx src/index.ts --dev
```

Code de sortie : `1`, attendu puisque le démarrage doit être refusé.

Sortie probante :

```text
Error: Port conflict with a process that is not ours:
  - :3000 is held by pid 56980, which Nodal-Agents did not start
  Nodal-Agents will not kill a process it did not start — it could be your own
  work. Stop it yourself, or change the port in ~/.nodalai/config.json.
ERR_PNPM_RECURSIVE_EXEC_FIRST_FAIL Command failed with exit code 1: tsx src/index.ts --dev
```

Contrôle immédiatement après :

```text
PORT_HOLDER_ALIVE True
```

Verdict : **PASSÉ**. Le processus étranger a ensuite été arrêté explicitement par le validateur et les fichiers temporaires de test ont été supprimés.

## Défauts produit

### Bloquant de validation — B4 reproduit

Ctrl+C après `All services healthy` tue les wrappers annoncés, mais laisse le serveur enfant Next PID 57924 sur le port 3000. La relance affiche exactement `Found 1 orphan process on configured ports`. Le protocole n'est donc pas entièrement passé.

### À signaler — faux diagnostic Postgres transitoire

Les arrêts de `pack:smoke`, `pack:upgrade` et un `down` manuel ont annoncé qu'un Postgres survivait et devait être tué de force. Dans les trois cas observés, le PID avait déjà disparu lors du contrôle quelques secondes plus tard. Le produit finit par nettoyer, mais le message rouge et la commande de kill sont prématurés.

### À signaler — avertissements de trace Next sous Windows

Les deux constructions ont produit de nombreux `Failed to copy traced files ... ENOENT` visant des chemins absolus Windows concaténés sous `.next\standalone`. Le build, l'intégrité des chunks et les deux installations ont néanmoins réussi.

## Défaut du protocole

L'étape 0 annonce que le tarball est attendu après `pnpm pack:build`. En réalité, `build-pack.mjs` assemble `pack/` seulement; `smoke-pack.mjs` exécute ensuite `npm pack` et crée le tarball. Le protocole devrait soit ajouter `cd pack && npm pack` à l'étape 0, soit annoncer que `pack:smoke` produit l'artefact.

## État après validation

Le serveur étranger temporaire a été supprimé. Aucun processus n'écoutait sur les ports `3000`, `3001`, `25440`, `3210`, `3211`, `25640`, `3310`, `3311` ou `25740` au contrôle final. Aucun fichier source du produit n'a été modifié par la validation; seul ce rapport a été ajouté.
