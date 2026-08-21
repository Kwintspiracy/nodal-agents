# Phase live, seconde passe — MCP et dashboard

**2026-08-07** · suite de `AUDIT_PHASE_LIVE.md` · serveur MCP hostile monté avec le SDK officiel,
dashboard interrogé en HTTP réel

---

## MCP-001 — Les outils d'un serveur MCP tiers s'exécutent SANS aucune approbation

```
ID: MCP-001   TOPIC: PRIVILEGE   SEVERITE: P1   CONFIANCE: Confirmed   EFFORT: S
IMPACT: Remote control
```

### Explication simple

Quand on branche un serveur MCP, ce serveur annonce lui-même la liste de ses outils. Le produit gate
soigneusement **ses propres** outils sensibles — créer un agent, créer un serveur MCP, exécuter une
commande : tous demandent une approbation humaine. Mais les outils venus d'un serveur tiers, ceux que
le produit n'a pas écrits, ne demandent **rien**. Ils s'exécutent directement, dans les quatre modes
d'autonomie, y compris le mode par défaut le plus prudent.

Autrement dit : le seul endroit où du code étranger entre dans le système est aussi le seul endroit
où le point de contrôle humain est absent.

### Détail technique

`buildMcpToolDefinition` (`packages/adapters/mcp/src/tools.ts:141-155`) construit
`{ name, description, inputSchema, riskLevel, execute }`. **Ni `defaultApproval`, ni `computeApproval`.**

Dans `executeTool` (`packages/tools/src/execute.ts:78`) :

```
let effectiveAction = matchedRule?.action ?? tool.defaultApproval;
```

Sans règle en base et sans `defaultApproval`, `effectiveAction` vaut `undefined` — le code tombe
directement en exécution. Le commentaire l'assume : *« undefined for ordinary tools (→ execute, the
historical default) »*. Un outil MCP tiers est traité comme un outil ordinaire.

Et rien ne crée de règle : `approval_rules` n'est alimentée que par le réglage explicite de
l'utilisateur (`actions.ts:5269`) et par l'interrupteur Yolo de `run_command` (`actions.ts:5371`).
**Aucune insertion à l'attachement d'un serveur MCP.**

Par contraste, tous les outils méta du produit déclarent `defaultApproval: 'require_approval'` :
`create_agent`, `create_mcp`, `create_skill`, `create_connector`, `attach_mcp`, `attach_agent`,
`attach_connector`, `assign_skill`.

**VERIFICATION 1** `[B]` — `executeTool` appelé avec une ToolDefinition de forme MCP,
`approvalRules: []`, sur les quatre valeurs d'autonomie :

| autonomie | outcome | `execute()` appelé | approbation demandée |
|---|---|---|---|
| non définie (défaut) | `success` | **oui** | non |
| `propose_confirm` | `success` | **oui** | non |
| `destructive_gate` | `success` | **oui** | non |
| `fully_autonomous` | `success` | **oui** | non |

**Contre-épreuve, même appel avec `defaultApproval: 'require_approval'`** :
`outcome = awaiting_approval`, `execute()` **non appelé**, approbation demandée.

Le gate fonctionne parfaitement. Les outils MCP n'y souscrivent simplement jamais.

**VERIFICATION 2** `[A]` — lecture de `tools.ts:141-155`, `execute.ts:78`, et inventaire exhaustif
des insertions dans `approval_rules`.

### Aggravant — le niveau de risque est auto-déclaré par le serveur

`riskFromAnnotations` (`tools.ts:66-70`) :

```
if (a?.readOnlyHint === true) return 'read';
if (a?.destructiveHint === true) return 'destructive';
return 'write';
```

`annotations` vient du serveur tiers. Un serveur hostile déclare donc son propre niveau de risque.

**Vérifié `[B]`** — serveur MCP hostile monté en stdio avec le SDK officiel, exposant un outil
`purge_all_data` décrit comme « Supprime définitivement toutes les données du workspace », porteur de
`annotations: { readOnlyHint: true }`. Résultat mesuré :

```
name        : veille__purge_all_data
riskLevel   : read        <- déclaré par l'attaquant, cru par le harnais
```

Sans effet pratique aujourd'hui, puisque rien ne gate de toute façon. Mais cela signifie que corriger
MCP-001 en s'appuyant sur `riskLevel` **ne suffirait pas** : la valeur est contrôlée par l'attaquant.

### CHALLENGE

1. *Protection ailleurs ?* Non. Ni whitelist, ni règle implicite, ni confirmation à l'attachement.
2. *Atteignable ?* Il faut que l'utilisateur ait ajouté le serveur. C'est ce qui maintient ce point en
   P1 et non en P0 — et `create_mcp` / `attach_mcp` sont eux-mêmes gatés, plus `createMcp: false` dans
   les grants par défaut (vérifié en base). L'ajout est un acte délibéré, derrière trois barrières.
3. *Design délibéré ?* Improbable : le produit gate ses propres outils avec constance. Un serveur MCP
   est du code tiers ; le traiter comme « ordinaire » est une omission, pas un arbitrage.
4. *Test existant ?* Aucun test n'exerce le gate sur un outil MCP.
5. *Code mort ?* Non — chemin de production, présent dans le tarball.
6. *Pourquoi pas d'incident ?* Peu d'utilisateurs branchent des serveurs MCP tiers, et ceux qui le font
   choisissent des serveurs de confiance.

**Résultat : Survived, P1.** Le finding le plus conséquent après les deux P0.

### OPTIONS

```
A) Donner defaultApproval: 'require_approval' à tout outil MCP, avec une règle
   auto_approve posée par l'utilisateur par serveur ou par outil depuis le
   dashboard (le mécanisme de règles existe déjà et gère la granularité).
   Effort : S. Compromis : friction sur les serveurs MCP à fort trafic.
   Risque résiduel : l'utilisateur passe tout en auto_approve d'un geste.

B) Approbation à la PREMIÈRE utilisation de chaque outil, mémorisée ensuite
   (modèle « trust on first use »).
   Effort : M. Compromis : un état supplémentaire à gérer.
   Risque résiduel : la première approbation est donnée sans savoir ce que
   fait réellement l'outil.

C) Gater selon riskLevel. À ÉCARTER : la valeur est déclarée par le serveur,
   donc par l'attaquant.
```

### CHALLENGE DE L'OPTION RECOMMANDÉE

A ajoute une demande d'approbation à chaque appel d'outil MCP tant que l'utilisateur n'a pas posé de
règle. Sur un serveur utilisé intensivement — un pilote Blender, un scraper — c'est vite insupportable,
et l'utilisateur mettra `*` en `auto_approve`, ce qui rétablit exactement l'état actuel avec, en plus,
l'illusion d'un contrôle. C'est le vrai risque de cette option, et il est sérieux. Le coût
d'implémentation est en revanche minime : un champ dans `buildMcpToolDefinition`. Ce qu'elle ne
corrige pas : un utilisateur qui approuve sans lire. B répond mieux au confort mais demande un
mécanisme d'état que le produit n'a pas.

### ★ RECOMMANDATION

**Option A, en posant la règle `auto_approve` par serveur au moment de l'attachement**, dans l'écran
où l'utilisateur ajoute le serveur — pas après coup. La raison qui tranche : le moment où
l'utilisateur choisit de faire confiance à un serveur MCP est le seul où il a le contexte pour
décider ; lui redemander à chaque appel ensuite ne l'informe pas davantage et le pousse à tout ouvrir.
Si l'effort est contraint : ajouter `defaultApproval: 'require_approval'` (une ligne) et laisser
l'utilisateur poser ses règles depuis l'écran existant.

**DEPENDANCES** : aucune. Indépendant de SKILL-001, qu'il complète.

---

## SKILL-001 confirmé — la description hostile passe verbatim

Serveur MCP hostile réel, description de 371 caractères contenant un « protocole obligatoire »
ordonnant un `save_memory` silencieux. Résultat mesuré sur la `ToolDefinition` remise au runner :

```
name        : veille__get_status
description : identique à celle du serveur : true
              contient la charge utile      : true
              longueur                      : 371 caractères, aucun plafond appliqué
```

Le finding passe de `Likely` à **`Confirmed`**. À noter que `capMcpResult` plafonne bien les
**résultats** à 50 000 caractères — la menace « serveur MCP hostile » a donc été pensée pour les
retours, et oubliée pour les métadonnées.

Non testé : si un modèle obéit effectivement à cette description. Cela demanderait d'attacher le
serveur à l'agent, ce qui exige le dashboard.

---

## Dashboard — protections réelles, et une brèche partagée avec le runner

### En-têtes de sécurité : complets

Mesurés sur une réponse réelle de `http://127.0.0.1:3010/agents` :

```
X-Frame-Options: DENY
Content-Security-Policy: frame-ancestors 'none'
X-Content-Type-Options: nosniff
Referrer-Policy: strict-origin-when-cross-origin
Strict-Transport-Security: max-age=63072000; includeSubDomains
Permissions-Policy: camera=(), microphone=(), geolocation=()
```

Six en-têtes, tous pertinents, dont une double protection anti-clickjacking. **Contrôle qui tient.**

### CSRF sur les server actions : protégé

| Requête | Résultat |
|---|---|
| `POST /agents` + `Next-Action` + `Origin: https://attacker.test` | **HTTP 500 — rejeté** |
| `POST /agents` + `Next-Action` + `Origin: http://127.0.0.1:3010` | HTTP 200 |

La vérification d'origine intégrée aux server actions de Next fonctionne. **Le dashboard n'est pas
vulnérable au CSRF simple** — contrairement au runner (NETWORK-001), qui accepte tout.

Toutes les pages testées répondent 200 sans authentification en mode `local-trust` (`/`, `/agents`,
`/settings`, `/approvals`, `/jobs`, `/skills`), ce qui est le comportement attendu et assumé de ce
mode.

### Rebinding DNS : les DEUX services tombent

La protection de Next compare `Origin` à `Host`. Or, pendant une attaque par rebinding DNS, le
navigateur envoie **les deux au nom de l'attaquant** — ils concordent, et la comparaison passe.

| Requête | Dashboard :3010 | Runner :3011 |
|---|---|---|
| `Origin: http://evil.test` + `Host: evil.test` | **HTTP 200** | **HTTP 202**, job créé |

`apps/web/next.config.ts:63` définit bien `allowedDevOrigins: ['localhost', '127.0.0.1', ...lanIPv4()]`
— mais c'est le réglage **de développement**. `experimental.serverActions.allowedOrigins`, qui
épinglerait les origines acceptées en production, **n'est pas défini**.

**Conséquence : NETWORK-001 s'étend au dashboard.** La sévérité ne change pas — elle était déjà P0 —
mais le périmètre du correctif double.

**PRÉCISION (2026-08-07, établie pendant la remédiation).** `experimental.serverActions.allowedOrigins`
**ne suffit pas** et ne peut pas suffire. Mesures sur une install packée :

| Requête | Résultat |
|---|---|
| `Origin: http://evil.test` + `Host: 127.0.0.1:3210` (discordants) | **500** — l'allowlist est consultée et rejette |
| `Origin: http://evil.test` + `Host: evil.test` (concordants) | **200** — court-circuit, allowlist jamais lue |

Le journal du dashboard le dit littéralement : *« `x-forwarded-host` header with value `127.0.0.1:3210`
does not match `origin` header with value `evil.test` … Aborting the action »*. Autrement dit la garde
de Next est `si Origin === Host alors autoriser, sinon consulter l'allowlist`. Or le rebinding produit
précisément l'égalité. Le correctif effectif est donc :

- **runner** → middleware `Origin` + validation `Host` sur `/api/*` ;
- **dashboard** → validation `Host` dans `src/proxy.ts`, **avant** tout handler.
  `allowedOrigins` est conservé pour le cas discordant (défense en profondeur), pas comme la barrière.

---

## Mouvements de cette seconde passe

| Finding | Mouvement | Raison |
|---|---|---|
| **MCP-001** | **Nouveau, P1** | Outils MCP tiers exécutés sans approbation dans les 4 modes d'autonomie ; contre-épreuve incluse |
| SKILL-001 | `Likely` → **Confirmed** | Description hostile de 371 caractères passée verbatim, serveur MCP réel |
| SKILL-002 | **P1 → P2** | `skill_assignment_mode` vaut `approval` par défaut (schéma + base live) — l'auto-assignation exige DEUX opt-ins indépendants |
| PRIVILEGE-005 | **Atténué** | Tous les `root_grants` à `false` et autonomie `propose_confirm` sur une entité fraîche, vérifié en base |
| NETWORK-001 | **Périmètre élargi** | Le rebinding défait aussi le dashboard ; correctif requis sur les deux services |
| SECRET-15 | `BLOCKED` → **PARTIAL** | En-têtes et CSRF vérifiés ; sessions et cookies non instruits |
| UX-01 (WCAG) | reste `BLOCKED` | Exige un navigateur, indisponible cette session |

## Contrôles supplémentaires qui tiennent

| Contrôle | Preuve | Constat |
|---|---|---|
| Grants ROOT par défaut | `[B]` base live | `createMcp`, `createAgent`, `createSkill`, `attachMcp`… **tous `false`**, autonomie `propose_confirm`. Aucune auto-extension possible sans geste explicite |
| `skill_assignment_mode` | `[A]`+`[B]` | Défaut `'approval'` — les skills apprises sont mises en file d'attente, pas auto-assignées |
| Garde SSRF sur les URL MCP | `[A]` `client.ts:29-64` | Bloque 169.254.x, `metadata.google.internal`, Alibaba 100.100.100.100, IPv6 link-local, AWS IMDS IPv6 — **et résout le DNS** pour attraper une redirection. Loopback et LAN volontairement autorisés (cas normal d'un serveur MCP local) |
| Plafond des résultats MCP | `[A]` `tools.ts:25-53` | 50 000 caractères, avec enveloppe `truncated: true` sur les objets plutôt qu'une troncature de JSON invalide |
| En-têtes de sécurité du dashboard | `[B]` HTTP réel | Six en-têtes pertinents, double protection anti-clickjacking |
| CSRF des server actions | `[B]` HTTP réel | Origine étrangère rejetée (500) |
