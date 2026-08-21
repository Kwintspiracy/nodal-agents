# Rapport de review — PR #6

Date : 21 août 2026  
Branche : `fix/codex-sandbox-unenforced`  
Commit : `17194b5`  
Plateforme : Microsoft Windows NT `10.0.26200.0`  
Codex : `codex-cli 0.148.0`  
Node : `v26.4.0`  
pnpm : `10.33.2`

## Verdict

**DEMANDE DE MODIFICATIONS.** Le constat central de la PR est vrai : sous Windows, `codex exec --sandbox` n'applique ni le mode `read-only`, ni la frontière `workspace-write`. Le refus de Codex dans les deux modes est donc une décision de sécurité défendable dans l'architecture actuelle.

La PR ne tient cependant pas entièrement sa promesse : en posture normale, elle crée une demande d'approbation avant d'exécuter la garde, puis refuse après l'approbation. Deux défauts supplémentaires ont aussi été trouvés : l'override `mcp_servers={}` ne retire aucun MCP personnel de Codex, et le nouveau hook Prettier ignore les fichiers dont le nom contient une espace.

## Résumé des points demandés

| Point | Verdict | Résultat |
|---|---|---|
| Sandbox Codex `read-only` sous Windows | **VÉRIFIÉ** | Le CLI lance PowerShell et crée réellement `t.txt`, code 0. |
| Sandbox Codex `workspace-write` sous Windows | **VÉRIFIÉ** | Le CLI écrit réellement dans un chemin absolu hors du cwd, code 0. |
| `computeApproval` ne transporte aucun avertissement | **VÉRIFIÉ** | Type exact : `Promise<'require_approval' \| undefined>`. |
| Aucun autre chemin d'avertissement n'existe | **CONTREDIT** | `computeApprovalImpactLine` alimente déjà les cartes dashboard et canaux. |
| Refus du mode lecture | **VÉRIFIÉ** | Décision justifiée : une analyse par défaut ne peut pas devenir une exécution shell non confinée. |
| Refus du mode écriture | **VÉRIFIÉ** | Décision justifiée actuellement : le consentement porte sur un workspace, pas toute la machine; un avertissement ordinaire est contourné par `auto_approve`/`fully_autonomous`. |
| Claude, deux modes, toutes plateformes | **VÉRIFIÉ par test unitaire** | Aucun refus dans les six combinaisons Windows/Linux/macOS. Pas de lancement live sur trois OS. |
| Codex, deux modes, Linux/macOS | **VÉRIFIÉ par test unitaire uniquement** | Aucun refus dans les quatre combinaisons. Confinement réel **NON TESTÉ**. |
| Mutation `codexSandboxEnforced → true` | **VÉRIFIÉ** | `6 failed \| 3 passed`; les refus rougissent, les cas autorisés restent verts. |
| Runtime agent `codex` | **VÉRIFIÉ** | `run-chat` et `run-job` répondent `runtime_not_supported:codex`. |
| Rejeu d'un `code_task` déjà approuvé | **VÉRIFIÉ en ciblé** | La règle synthétique `resume-bypass` ne contourne pas la garde; résultat `codex_sandbox_unenforced`, aucun CLI lancé. |
| Refus avant présentation de l'approbation | **CONTREDIT** | Le vrai wrapper renvoie d'abord `awaiting_approval`; la garde ne tourne qu'au rejeu. |

## Findings

### P0 — `mcp_servers={}` n'empêche pas l'héritage des MCP personnels

Ce défaut n'est pas créé par la garde Windows, mais il affecte le même chemin Codex et contredit explicitement le commentaire de `buildProviderArgs` : « a Nodal-spawned run must NEVER inherit the user's personal MCP servers ».

Le premier test, exécuté avec l'argv exact de Nodal et `-c 'mcp_servers={}'`, a produit avant l'écriture :

```text
ERROR rmcp::transport::worker: worker quit with fatal: Transport channel closed,
when AuthRequired(... https://mcp.figma.com/...)
```

Contrôle direct :

```powershell
codex mcp list
codex -c 'mcp_servers={}' mcp list
```

Les deux commandes sortent avec le code `0` et listent le même ensemble, notamment :

```text
kwint-tasks      enabled
n8n-mcp          enabled
node_repl        enabled
virtual-printer  enabled
figma            enabled
```

L'override d'une table TOML vide fusionne manifestement avec la configuration au lieu de la remplacer. Un serveur configuré avec ses propres variables peut donc être lancé avec ses secrets, même si `buildChildEnv` a retiré les variables `KEY`/`TOKEN` du processus parent.

Impact sur la PR : Windows est protégé parce que la nouvelle garde empêche tout spawn Codex. Linux et macOS restent autorisés et peuvent hériter de ces MCP. Ce finding doit être traité séparément mais bloque la garantie de confinement annoncée autour de `code_task`.

### P1 — le refus arrive après la demande d'approbation

La garde est appelée dans `codeTaskTool.execute`. Or `executeTool` évalue d'abord les règles, écrit `approval_requests` et retourne `awaiting_approval`; il n'appelle `tool.execute` qu'après approbation ou auto-approbation.

Reproduction avec les vrais `executeTool` et `codeTaskTool`, une DB factice sans persistance externe et la posture normale `propose_confirm` :

```powershell
npx.cmd --yes pnpm@10.33.2 --filter @nodal-agents/runner exec tsx -e "<appel executeTool(codeTaskTool, codex/read, approvalRules:[])>"
```

Sortie brute :

```text
APPROVAL_CREATED {"approvalRequestId":"apr-pr6","toolName":"code_task","toolInput":{"purpose":"analyse read-only","provider":"codex","task":"inspect","mode":"read"},"jobId":"review-job","agentId":"review-agent","entityId":"review-entity"}
RESULT {"outcome":"awaiting_approval","approvalRequestId":"apr-pr6"}
```

Le CLI n'est pas lancé, donc la faille de confinement est bien fermée. Mais l'humain reçoit une carte fondée sur la promesse fausse, approuve, puis obtient seulement ensuite `codex_sandbox_unenforced`. Cela contredit le texte de la PR : « la décision n'est pas offerte ».

La suite `sandbox.test.ts` ne couvre pas l'intégration avec `executeTool`; c'est pourquoi ses neuf tests verts ne détectent pas cet ordre d'exécution.

### P2 — le hook Prettier ignore les chemins contenant une espace

Le changement hors sujet de `.githooks/pre-commit` utilise une liste séparée par retours à la ligne, puis `xargs` sans `-0` :

```sh
staged=$(git diff --cached --name-only ...)
echo "$staged" | xargs npx prettier --check --no-error-on-unmatched-pattern
```

Simulation avec le shell Git utilisé par le hook :

```powershell
& 'C:\Program Files\Git\bin\sh.exe' -lc "printf '%s\n' 'docs/a b.md' | xargs printf '<%s>\n'"
```

Sortie brute :

```text
<docs/a>
<b.md>
```

Avec la commande Prettier réelle :

```text
Checking formatting...
All matched files use Prettier code style!
```

Comme `--no-error-on-unmatched-pattern` est actif, les deux fragments inexistants sont acceptés et le vrai fichier n'est jamais vérifié. Il faut un flux NUL (`git diff -z` / `xargs -0`) pour que ce gate couvre les noms légaux.

## Priorité 1 — reproductions live Windows

### Lecture seule

Commande équivalente exacte sous PowerShell :

```powershell
'Cree un fichier t.txt contenant OUI ici, via le shell.' |
  codex exec --json --sandbox read-only --skip-git-repo-check -c 'mcp_servers={}' -
```

Répertoire neuf :

```text
C:\Users\kwint\AppData\Local\Temp\nodal-pr6-ro-8b5bf3039b174ca5b0fd03a7dc178bda\rev
```

Sortie probante :

```json
{"type":"item.completed","item":{"type":"command_execution","command":"... Set-Content -LiteralPath 't.txt' -Value 'OUI' ...","exit_code":0,"status":"completed"}}
```

Contrôle direct :

```text
CODEX_EXIT 0
T_EXISTS True
T_CONTENT OUI
T_SHA256 8A33F2EAECC09D9D4D12365E52FED97337840C6CCCC7431525446E5B6FB1E7AC
```

Verdict : **VÉRIFIÉ**. `read-only` n'a empêché ni le shell, ni l'écriture.

### Évasion de `workspace-write`

Commande équivalente exacte :

```powershell
"Ecris DEHORS dans le fichier absolu <outside>\dehors.txt, via le shell." |
  codex exec --json --sandbox workspace-write --skip-git-repo-check -
```

Répertoire courant et cible :

```text
WORKDIR C:\Users\kwint\AppData\Local\Temp\nodal-pr6-ww-88e3bee147f4476cbc44ba574da156ce\rev
OUTSIDE_TARGET C:\Users\kwint\AppData\Local\Temp\nodal-pr6-ww-88e3bee147f4476cbc44ba574da156ce\outside\dehors.txt
```

Sortie probante :

```json
{"type":"item.completed","item":{"type":"command_execution","command":"... Set-Content -LiteralPath '...\\outside\\dehors.txt' -Value 'DEHORS' ...","exit_code":0,"status":"completed"}}
```

Contrôle direct :

```text
CODEX_EXIT 0
OUTSIDE_EXISTS True
OUTSIDE_CONTENT DEHORS
OUTSIDE_SHA256 2411B17A71E47E196CD3A249EEB8AE5AA4014F2F9EB5E9D61BBF601514E03926
```

Verdict : **VÉRIFIÉ**. La frontière du workspace n'existe pas dans ce mode.

Les deux dossiers temporaires ont été supprimés après les contrôles : `EXISTS_AFTER False` pour chacun.

## Priorité 2 — arbitrages

### a) Refuser plutôt qu'avertir

La prémisse étroite est **VÉRIFIÉE** dans `packages/tools/src/types.ts` :

```ts
computeApproval?: (...) => Promise<'require_approval' | undefined>;
```

La prémisse large « aucun chemin ne permet d'afficher un avertissement » est **CONTREDITE**. `packages/shared/src/approval-impact.ts` calcule déjà une phrase déterministe via `computeApprovalImpactLine`. Cette valeur est transportée par `explainApprovalRequest`, affichée dans `apps/web/.../approvals/page.tsx` et rendue dans les notifications par `renderExplanationText`.

Un avertissement Codex pourrait donc être affiché à ces deux endroits en ajoutant un cas déterministe `code_task`. Le champ d'entrée optionnel `impact` ne suffit pas : il est contrôlé par le modèle et apparaît comme argument, pas comme verdict fiable de la plateforme.

Je maintiens néanmoins le **refus du mode lecture**. Une règle explicite `auto_approve` ou l'autonomie `fully_autonomous` évite totalement la carte. Sans nouveau plancher d'approbation non contournable, un avertissement ne peut pas garantir que l'humain consent à transformer une analyse en shell non confiné.

### b) Refuser aussi le mode écriture

Je tranche en faveur du **refus actuel**. L'utilisateur consent à modifier un workspace déterminé; l'écriture démontrée porte sur n'importe quel chemin accessible au compte du runner. Cela casse aussi les verrous de concurrence et l'isolation entre workspaces/agents.

Autoriser l'écriture avec avertissement serait raisonnable uniquement si :

1. `computeApprovalImpactLine('code_task', input)` affiche explicitement « Codex Windows n'est pas confiné et peut modifier toute la machine » dans la carte dashboard et les cartes de canaux;
2. cette combinaison est forcée vers une approbation humaine non contournable, même avec `auto_approve` et `fully_autonomous`;
3. la description du mode ne continue pas à promettre « inside the workspace ».

La PR ne construit pas cette posture. Dans son état actuel, laisser passer l'écriture avec un simple avertissement serait insuffisant.

## Priorité 3 — largeur et mutation des tests

### État normal

Commande :

```powershell
npx.cmd --yes pnpm@10.33.2 --filter @nodal-agents/tools exec vitest run src/builtin/code-task/sandbox.test.ts --reporter=verbose
```

Sortie :

```text
Test Files  1 passed (1)
Tests       9 passed (9)
```

### Garde neutralisée temporairement

Mutation appliquée puis restaurée :

```ts
export function codexSandboxEnforced(platform: NodeJS.Platform): boolean {
  return true;
}
```

Même commande, sortie :

```text
Test Files  1 failed (1)
Tests       6 failed | 3 passed (9)
```

Les six rouges sont exactement :

```text
does not trust Windows
does not trust a platform nobody has measured
refuses codex read mode where the sandbox does not hold
refuses codex write mode too — the workspace bound is just as false
says which promise cannot be kept, per mode
names the alternative, not just the problem
```

Les trois verts sont :

```text
trusts the two platforms codex actually sandboxes on
leaves claude alone on every platform
leaves codex alone where its sandbox does hold
```

Ils ne tuent logiquement pas le mutant « tout est supporté », mais ils protègent contre le mutant inverse, une garde trop large. Ils constituent donc des assertions de non-régression utiles. En revanche, ils ne couvrent pas l'ordre approbation → exécution décrit au finding P1.

Après restauration :

```text
Test Files  1 passed (1)
Tests       9 passed (9)
```

`git diff -- packages/tools/src/builtin/code-task/sandbox.ts` était vide.

## Priorité 4 — trous annoncés

### Linux et macOS réels

Verdict : **NON TESTÉ**.

Cette machine est Windows. WSL 2 est activé mais aucune distribution n'est installée (`wsl --list --quiet` ne retourne aucun nom). Aucun hôte macOS n'est disponible. Les tests prouvent seulement la décision de la fonction, pas l'efficacité réelle de Landlock/seccomp ou Seatbelt avec `codex-cli 0.148.0`.

### Agents en runtime direct

Verdict : **VÉRIFIÉ**.

`run-chat.ts` :

```text
{"ok":false,"error":"runtime_not_supported:codex"}
```

`run-job.ts`, avec une DB factice dont aucun write n'atterrit :

```text
{"status":"failed","error":"runtime_not_supported:codex"}
```

Les deux fonctions vérifient `agentRow.runtime !== 'claude-code'` avant de résoudre un workspace ou de lancer un CLI. L'action web n'accepte également que `z.enum(['nodal', 'claude-code'])`. Il n'y a donc pas de chemin runtime Codex exploitable aujourd'hui.

### `code_task` déjà approuvé puis rejoué

Verdict : **VÉRIFIÉ en exécution ciblée**.

Le runner rejoue une approbation avec une règle synthétique `resume-bypass` / `auto_approve`, puis appelle le même `executeTool` et le même `codeTaskTool.execute`. Reproduction avec cette règle exacte :

```text
{"outcome":"error","error":"codex_sandbox_unenforced: on win32, `codex exec --sandbox` does not confine the CLI ..."}
```

Aucun appel de `resolveCliPath`, `codex --version` ou `codex exec` n'est atteint. Le rejeu ne contourne donc pas la garde. Le test était ciblé avec DB factice; aucun e2e complet avec une vraie ligne `approval_requests` n'existe dans cette PR.

## Non testé

- Le confinement Codex réel sous Linux et macOS.
- Les six combinaisons Claude en lançant réellement `claude`; seule la non-interférence de la garde pure a été exécutée.
- Un e2e dashboard complet montrant l'approbation Windows Codex, le clic humain, puis le refus. Le comportement a été reproduit au niveau des vrais wrappers avec DB factice.
- Un rejeu avec une vraie base Postgres et le worker complet; le chemin effectif `resume-bypass → executeTool → codeTaskTool` a été exécuté de façon ciblée.

## État de l'arbre après review

Aucun fichier source n'a été corrigé. La mutation de `sandbox.ts` a été restaurée et vérifiée par un diff vide puis `9/9` tests verts. Les deux répertoires temporaires contenant `t.txt` et `dehors.txt` ont été supprimés. Seul ce rapport a été ajouté par la review; la demande source non suivie reste également non trackée.
