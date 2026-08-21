# Rapport de review nº2 — PR #6

Date : 21 août 2026  
Branche : `fix/codex-sandbox-unenforced`  
Commit : `a3acaf0`  
Plateforme : Microsoft Windows NT `10.0.26200.0`  
Codex : `codex-cli 0.148.0`  
Node : `v26.4.0`  
pnpm : `10.33.2`

## Verdict

**DEMANDE DE MODIFICATIONS.** Les trois correctifs répondent à leurs reproductions nominales : le `preflight` refuse avant l'approbation, `--ignore-user-config` supprime les MCP personnels tout en conservant l'authentification, et le hook NUL traite correctement les fichiers TypeScript avec espaces sous Git for Windows.

Deux défauts bloquent néanmoins cette seconde passe :

1. `probe-codex-sandbox.mjs` peut annoncer `CONFINED`, code 0, sans qu'aucune commande ait été tentée. Le faux vert a été reproduit.
2. Les tests restent à `50/50` si l'on retire uniquement `codeTaskTool.preflight`. Ils testent le crochet générique et la garde pure, mais pas leur câblage réel.

L'ordre `preflight` avant une règle explicite `block` est également contesté : il exécute du code appartenant à l'outil et remplace le message propriétaire `blocked` avant même de consulter l'interdiction.

## Résumé

| Point | Verdict | Preuve |
|---|---|---|
| `preflight` avant l'approbation | **VÉRIFIÉ** | Le refus retourne `error`, aucune ligne `approval_requests`. |
| Audit d'un refus preflight | **VÉRIFIÉ** | Une ligne `tool_calls` contient l'entrée validée et la sortie d'erreur exacte. |
| Jet synchrone et rejet asynchrone | **VÉRIFIÉ** | Les deux deviennent `outcome: error` et sont audités. |
| MCP/connecteurs inchangés | **VÉRIFIÉ actuellement** | Seul `code_task` déclare `preflight`; les définitions MCP/connecteurs n'en reçoivent pas. |
| Règle `block` prioritaire | **CONTREDIT** | `preflight` gagne et renvoie son erreur à la place de `blocked`. |
| Mutation globale `if (false && tool.preflight)` | **VÉRIFIÉ** | `3 failed \| 2 passed`. |
| Mutation du seul câblage `codeTaskTool.preflight` | **CONTREDIT** | Les trois suites restent vertes : `50 passed`. |
| `--ignore-user-config` retire les MCP | **VÉRIFIÉ** | Run live code 0, réponse `OK`, zéro ligne MCP. |
| Authentification conservée | **VÉRIFIÉ** | Le même run termine avec `turn.completed`. |
| Aucun comportement utilisateur perdu | **CONTREDIT** | Tout `config.toml` est ignoré, notamment modèle/effort par défaut, features et shell policy. |
| Alternative plus étroite et robuste | **NON TROUVÉE** | L'override vide fusionne; le disable nommé ne couvre pas proprement les MCP de plugins; un `CODEX_HOME` jetable perd l'auth. |
| Sonde réelle sous Windows | **VÉRIFIÉ** | `NOT CONFINED`, code 1; les deux écritures atterrissent. |
| Sonde incapable de faux vert | **CONTREDIT** | Un CLI simulé sans commande produit `CONFINED`, code 0. |
| Nettoyage nominal de la sonde | **VÉRIFIÉ** | Zéro résidu avant/après. |
| CLI absent / non authentifié / timeout | **VÉRIFIÉ** | Trois scénarios distincts retournent code 2. |
| Hook avec un `.ts` contenant une espace | **VÉRIFIÉ** | Prettier reçoit le chemin entier et bloque, code 1. |
| Hook avec un `.ts` ordinaire | **VÉRIFIÉ** | Bloque également, code 1. |
| `grep -z` sous Git for Windows | **VÉRIFIÉ** | Le hook complet atteint Prettier dans les deux cas. |

## Findings

### P0 — la sonde peut rendre un faux `CONFINED`

`attempt()` ne vérifie pas qu'une commande shell a réellement été tentée ni qu'elle a été refusée par le sandbox. Il suffit que stdout contienne n'importe quel événement `item.*` ou `turn.*`; si le fichier est absent, le script imprime `✓ blocked`.

Un faux CLI temporaire a été placé en tête de `PATH`. Il répond normalement à `--version`, puis émet un tour JSON valide avec un simple message d'agent et aucune commande.

Commande :

```powershell
$env:PATH='D:\APPS\NodalAI\scripts\validation-fake-codex;'+$env:PATH
node scripts/probe-codex-sandbox.mjs
```

Sortie brute :

```text
Platform : win32
Codex    : codex-cli fake-no-command

▶ read-only sandbox: can it write inside the working directory?
  ✓ blocked

▶ workspace-write sandbox: can it write OUTSIDE the working directory?
  ✓ blocked

CONFINED on win32 (codex-cli fake-no-command): both attempts were blocked.
FAKE_NO_COMMAND_EXIT 0
```

Aucun shell n'a été lancé et aucun sandbox n'a bloqué quoi que ce soit. C'est exactement le faux vert que la sonde devait rendre impossible.

Autre branche incorrecte : si une tentative retourne `null` et l'autre `false`, le script sort aussi 0. Il ne retourne 2 que lorsque **les deux** sont `null`. Une mesure partiellement indéterminée peut donc devenir `CONFINED`.

Pour prouver le confinement, l'absence du fichier ne suffit pas. Il faut une preuve positive qu'une commande d'écriture a été tentée puis refusée par la couche sandbox, ou rendre `NON TESTÉ`/code 2.

### P1 — le câblage réel de `code_task` n'est pas testé

La mutation demandée du crochet global est bien détectée. En revanche, la régression exacte suivante ne l'est pas : supprimer uniquement cette propriété de `codeTaskTool` :

```ts
preflight: (input) => {
  assertSandboxEnforced(input.provider, input.mode);
},
```

Commande après cette mutation temporaire :

```powershell
npx.cmd --yes pnpm@10.33.2 --filter @nodal-agents/tools exec vitest run \
  src/tests/preflight-order.test.ts \
  src/builtin/code-task/sandbox.test.ts \
  src/tests/code-task.test.ts --reporter=dot
```

Sortie brute :

```text
Test Files  3 passed (3)
Tests       50 passed (50)
```

`sandbox.test.ts` appelle la garde directement. `preflight-order.test.ts` fabrique un `gated_tool` qui déclare son propre preflight. Aucun test ne conduit le vrai `codeTaskTool` via `executeTool` et ne vérifie simultanément : erreur `codex_sandbox_unenforced`, zéro approbation, zéro exécution.

Le câblage a été restauré après la mutation. Les mêmes suites donnent toujours `50 passed`.

### P1 — une règle propriétaire `block` ne gagne pas

Test avec vraie base de test, outil doté d'un preflight synchrone et règle explicite `block` :

```text
BLOCK_RESULT {"outcome":"error","error":"sync_preflight_won"}
```

Le résultat attendu d'une interdiction propriétaire aurait été le message canonique `blocked: an approval rule forbids ...`, qui demande au modèle de ne pas réessayer ni contourner la restriction.

Je tranche : **la règle `block` doit gagner**. Raisons :

- c'est la décision explicite du propriétaire, plus forte qu'un diagnostic de capacité;
- le message `blocked` explique que la restriction est intentionnelle, alors que `codex_sandbox_unenforced` propose une alternative que le propriétaire a également interdite en bloquant `code_task`;
- le type de `preflight` reçoit tout `ToolContext` et peut exécuter du code asynchrone ou écrire en base. Une convention documentaire ne suffit pas à garantir qu'un futur preflight restera pur. Un outil bloqué ne devrait exécuter aucun code appartenant à l'outil.

La règle peut être résolue juste après validation; un `block` peut alors retourner immédiatement, tandis que le preflight reste avant toute approbation et toute auto-approbation pour les autres actions.

### P1 — la sonde n'utilise pas l'argv isolé qu'elle est censée mesurer

Le produit utilise maintenant `--ignore-user-config`, mais la sonde appelle encore :

```text
codex exec --json --sandbox <mode> --skip-git-repo-check -
```

Elle charge donc les MCP, plugins, hooks et autres réglages personnels. La première review avait déjà observé les connexions Figma sur cet argv. `attempt()` capture stderr puis le masque dès qu'un tour existe, donc ces initialisations restent invisibles dans la sortie de la sonde.

Cela ajoute des effets externes inutiles et mesure une commande différente de celle construite par `buildProviderArgs`. La sonde de confinement devrait mesurer le chemin réellement livré et isolé.

### P2 — `--ignore-user-config` est sûr, mais la régression est silencieuse

Le help local de `codex exec` dit :

```text
--ignore-user-config
    Do not load `$CODEX_HOME/config.toml`; auth still uses `CODEX_HOME`
```

Run live :

```powershell
'Reponds uniquement OK, sans utiliser aucun outil.' |
  codex exec --json --sandbox read-only --skip-git-repo-check --ignore-user-config -
```

Sortie :

```text
{"type":"thread.started",...}
{"type":"turn.started"}
{"type":"item.completed","item":{"type":"agent_message","text":"OK"}}
{"type":"turn.completed",...}
```

Code de sortie `0`, aucune ligne MCP : le correctif P0 fonctionne et l'authentification par abonnement survit.

Mais la configuration locale de la machine testée contient, hors MCP, des réglages de modèle, effort, features, politique d'environnement shell, confiance projet, plugins et réglages Windows. Ils sont tous ignorés. Nodal repasse le sandbox et, seulement lorsqu'ils sont définis sur l'agent, le modèle et l'effort. Sans défaut Nodal explicite, le modèle/effort utilisateur ne s'applique donc plus.

Je considère le compromis **acceptable pour fermer la fuite MCP**, mais pas silencieusement. La documentation utilisateur doit dire que les runs Codex Nodal ignorent `~/.codex/config.toml`, que l'auth reste utilisée, et que modèle/effort doivent être réglés dans Nodal si l'utilisateur ne veut pas les valeurs intégrées du CLI.

#### Recherche d'une alternative plus étroite

- `-c 'mcp_servers={}'` : **CONTREDIT**, fusionne et laisse tous les serveurs.
- `-c mcp_servers.<serveur>.enabled=false` : fonctionne pour un serveur défini directement dans `config.toml`, mais exige une énumération préalable et n'a pas désactivé proprement un serveur fourni par plugin (`invalid transport` lorsqu'appliqué à Figma).
- pseudo-wildcard `mcp_servers."*".enabled=false` : **CONTREDIT**, crée un faux serveur `*` incomplet et échoue `invalid transport`.
- profil Codex : se superpose à la configuration de base; il ne remplace pas la table.
- `CODEX_HOME` jetable : isole la configuration, mais déplace aussi l'authentification. Copier ou lier les identifiants réintroduirait une manipulation de secrets contraire au modèle d'abonnement actuel.

Aucune option locale ni documentation officielle OpenAI trouvée pendant cette review ne fournit un « ignorer uniquement tous les MCP » robuste. `--ignore-user-config` reste le seul mécanisme intégré observé qui garantit zéro héritage.

### Incident de validation — secret imprimé par `codex mcp list --json`

La commande de diagnostic JSON utilisée pour étudier l'override nommé a imprimé en clair une clé d'API stockée dans l'environnement d'un MCP. La sortie tabulaire la masque, la sortie JSON non.

La valeur n'est volontairement pas reproduite ici. Elle figure cependant dans les logs d'outil de cette session de validation et doit être révoquée/rotée. Cet incident concerne le CLI Codex et la procédure de diagnostic, pas le diff PR #6.

## Priorité 1 — détail du preflight

### Audit et captures synchrone/asynchrone

Commande ciblée : appel de `executeTool` contre une vraie PGlite de test avec deux outils, l'un jetant synchroniquement, l'autre rejetant une Promise.

Sortie brute :

```text
BLOCK_RESULT {"outcome":"error","error":"sync_preflight_won"}
ASYNC_RESULT {"outcome":"error","error":"async_preflight_caught"}
TOOL_CALLS [{"name":"preflight_block_probe","input":{"value":"secret-value"},"output":"{\"outcome\":\"error\",\"error\":\"sync_preflight_won\"}"},{"name":"preflight_async_probe","input":{"value":"async-value"},"output":"{\"outcome\":\"error\",\"error\":\"async_preflight_caught\"}"}]
APPROVAL_COUNT 0
```

Verdicts :

- audit `tool_calls` : **VÉRIFIÉ**;
- contenu validé et erreur exacte : **VÉRIFIÉ**;
- aucune demande d'approbation : **VÉRIFIÉ**;
- jet synchrone capturé : **VÉRIFIÉ**;
- rejet asynchrone capturé : **VÉRIFIÉ**.

`_writeToolCall` applique le même `redactSecretsForAudit` que les autres chemins.

### MCP et connecteurs

Commande :

```powershell
git grep -n "preflight" -- ':!docs/validation/*'
```

Seul `packages/tools/src/builtin/code-task/index.ts` déclare la propriété en production. Les wrappers MCP construisent leurs propres objets `ToolDefinition` à partir d'un ensemble fermé de champs; un serveur MCP ne peut pas injecter une fonction JavaScript `preflight` via son descripteur JSON. Les connecteurs existants n'en déclarent aucun.

Verdict : **VÉRIFIÉ actuellement**. Le rayon structurel reste global pour tout futur déclarant.

### Mutation demandée

Mutation temporaire :

```ts
if (false && tool.preflight) {
```

Sortie :

```text
Test Files  1 failed (1)
Tests       3 failed | 2 passed (5)
```

Rouges corrects : refus normal devenu `awaiting_approval`, `auto_approve` et `fully_autonomous` devenus `success`. Les deux contrôles sans objection restent verts.

Après restauration : `5/5` sur ce fichier et `50/50` sur les trois suites ciblées.

## Priorité 3 — sonde

### Run réel

Commande :

```powershell
node scripts/probe-codex-sandbox.mjs
```

Sortie brute :

```text
Platform : win32
Codex    : codex-cli 0.148.0

▶ read-only sandbox: can it write inside the working directory?
  ✗ the write LANDED — not confined

▶ workspace-write sandbox: can it write OUTSIDE the working directory?
  ✗ the write LANDED — not confined

NOT CONFINED on win32 (codex-cli 0.148.0): read-only allowed a write; workspace-write escaped the working directory.
PROBE_EXIT 1
PROBE_TEMP_AFTER_COUNT 0
PROBE_NEW_RESIDUE_COUNT 0
```

Verdict nominal : **VÉRIFIÉ**.

### Sorties indéterminées

Codex absent, `PATH` contrôlé :

```text
Cannot tell: the `codex` CLI is not on PATH (or does not answer --version).
ABSENT_EXIT 2
```

CLI simulé non authentifié :

```text
? the CLI produced no turn — no verdict
  Not logged in. Run codex login.
No verdict: neither attempt produced a usable run.
FAKE_NOT_AUTH_EXIT 2
```

Timeout simulé en réduisant temporairement `TIMEOUT_MS` à 100 ms :

```text
? timed out after 0.1s — no verdict
? timed out after 0.1s — no verdict
No verdict: neither attempt produced a usable run.
FAKE_TIMEOUT_EXIT 2
```

La constante et tous les fichiers simulés ont été restaurés/supprimés.

### Nettoyage

Le run réel a commencé avec zéro cible `codex-sandbox-probe-*` / `codex-sandbox-escape-*` et terminé avec zéro cible. Le chemin nominal est propre.

Le `finally` avale toutefois toute erreur de `rmSync`; un refus de suppression ne change ni le message ni le code de sortie. Ce cas n'a pas été provoqué.

## Priorité 4 — hook de format

Deux fichiers TypeScript volontairement non formatés ont été créés et stagés séparément. L'index était vide avant le test et a été remis vide ensuite.

### Nom avec espace

Fichier : `scripts/validation format space.ts`

```text
Commit hygiene: clean (1 staged file(s) inspected).
No hardcoded secrets found (1628 tracked files scanned).
Checking formatting...
[warn] scripts/validation format space.ts
[warn] Code style issues found in the above file. Run Prettier with --write to fix.
Commit blocked — the files above are not formatted.
SPACE_HOOK_EXIT 1
```

Verdict : **VÉRIFIÉ**. Le chemin est arrivé entier à Prettier.

### Nom ordinaire

Fichier : `scripts/validation-format-ordinary.ts`

```text
Commit hygiene: clean (1 staged file(s) inspected).
No hardcoded secrets found (1628 tracked files scanned).
Checking formatting...
[warn] scripts/validation-format-ordinary.ts
[warn] Code style issues found in the above file. Run Prettier with --write to fix.
Commit blocked — the files above are not formatted.
ORDINARY_HOOK_EXIT 1
```

Verdict : **VÉRIFIÉ**.

`grep -z`, `xargs -0` et `xargs -r` fonctionnent dans `C:\Program Files\Git\bin\sh.exe` sur cette machine. Le hook complet, pas seulement le pipeline extrait, a été exécuté.

Portabilité macOS : **NON TESTÉE**. Les implémentations BSD historiques de `grep` et `xargs` ne proposent pas toujours les mêmes options GNU (`grep -z`, `xargs -r`); ce hook mérite un contrôle sur un vrai Mac avant d'être déclaré portable hors Git for Windows/Linux GNU.

## Non testé

- Sonde réelle sous Linux : WSL 2 est activé mais `wsl --list --quiet` ne retourne aucune distribution. Aucune distribution n'a été installée pendant une review en lecture seule.
- Sonde réelle sous macOS : aucun hôte disponible.
- Portabilité du hook sur le shell natif macOS/BSD.
- Nettoyage de la sonde après kill forcé du processus ou erreur de permissions de `rmSync`.
- Sélection effective du modèle avec/sans `--ignore-user-config` : le flux JSONL de `codex exec 0.148.0` n'annonce pas le modèle. La perte de configuration est établie par la sémantique explicite du flag et les clés locales présentes, pas par un identifiant de modèle dans le résultat.
- E2E complet dashboard → proposition `code_task` Codex → vérification visuelle de l'absence de carte. Le mécanisme est testé avec la vraie base de test, mais le câblage réel manque justement de test comme indiqué plus haut.

## État après review

Aucun fichier source n'a été corrigé. Toutes les mutations (`execute.ts`, `code-task/index.ts`, délai de la sonde) ont été restaurées et les faux CLI/fichiers TypeScript supprimés. L'index Git est vide. Les trois suites ciblées terminent à `50/50`. Seul ce rapport a été ajouté par la review; la demande source reste également non trackée.
