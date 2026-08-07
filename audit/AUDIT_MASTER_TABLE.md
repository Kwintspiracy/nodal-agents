# AUDIT_MASTER_TABLE — Nodal-Agents 0.8.1

`main` @ `144383f` · artefact testé : **le tarball du registre npm** (`nodal-agents@0.8.1`, SHA-256
vérifié identique au `pack/` local), installé proprement en environnement isolé, agent réel créé par
le wizard d'onboarding · 2026-08-07 · dépense LLM totale : **0,04 $**

Groupé par topic, trié par criticité à l'intérieur de chaque topic.

---

## Injection & privilège

| ID | Sév. | Confiance | Effort | Problème en une phrase | ★ Recommandation | Challengé ? |
|---|---|---|---|---|---|---|
| MCP-001 | **P1** | Confirmed | S | Les outils d'un serveur MCP tiers s'exécutent **sans aucune approbation**, dans les 4 modes d'autonomie — seule famille privilégiée à ne pas déclarer `defaultApproval`. | `defaultApproval: 'require_approval'` sur tout outil MCP, et règle `auto_approve` posée par serveur au moment de l'attachement. | Survived |
| INJECT-001 | P2 | Confirmed | M | Aucun contenu tiers n'est balisé comme donnée non fiable, sauf les webhooks : 17 frontières sur 18 sont sans cadre. | Généraliser d'un coup l'enveloppe du webhook à toutes les frontières, jamais par surface. | **P1→P2** après 6 tests d'injection réels |
| PRIVILEGE-003 | P2 | **Likely** | S | La carte d'approbation montre d'abord le motif écrit par l'agent, et tronque la commande réelle à 500 caractères sans le dire. | Afficher la longueur réelle tronquée ; ne pas toucher à l'ordre, choix de lisibilité assumé. | **P1→P2** (ligne d'impact déterministe) |

## Secrets & authentification

| ID | Sév. | Confiance | Effort | Problème en une phrase | ★ Recommandation | Challengé ? |
|---|---|---|---|---|---|---|
| SECRET-001 | P1 | Confirmed | M | Les transcripts de job stockent les résultats d'outils sans rédaction, et les jobs échoués les conservent intégralement. | Rédiger à l'affichage d'abord ; à l'écriture seulement après avoir prouvé que la reprise ne relit pas le transcript. | Survived |
| SECRET-002 | P2 | Confirmed | XS | Les répertoires de `~/.nodalai/` (base, journaux, pids) gardent les droits hérités ; seuls deux fichiers sont verrouillés. | Appeler la fonction de restriction existante sur les 4 répertoires dans `ensureConfigDir`. | **P1→P2** (un admin lit tout par élévation) |
| SECRET-003 | P2 | Confirmed | S | Le Postgres embarqué utilise `nodalai`/`nodalai`, codés en dur et identiques sur toute installation — tout processus local lit la base, contournant les ACL fichier. | Mot de passe aléatoire par installation, groupé avec SECRET-002. | Survived |

## Exposition réseau

| ID | Sév. | Confiance | Effort | Problème en une phrase | ★ Recommandation | Challengé ? |
|---|---|---|---|---|---|---|
| NETWORK-001 | **P0** | Confirmed | S | En configuration par défaut, n'importe quelle page web visitée peut créer et faire exécuter un job par un agent — sans authentification, sans contrôle d'`Origin` ni de `Host`. Le rebinding DNS défait aussi le dashboard. | Middleware `Origin` + validation `Host` sur le runner (via `isPrivateOrigin`, déjà écrit) **et** `serverActions.allowedOrigins` sur le dashboard. | Survived, **périmètre élargi** aux deux services |

## Chaîne de distribution

| ID | Sév. | Confiance | Effort | Problème en une phrase | ★ Recommandation | Challengé ? |
|---|---|---|---|---|---|---|
| SUPPLY-001 | **P0** | Confirmed | XS | Le tarball publié déclare `next: ^16.2.6` alors que le dashboard est pré-compilé : une installation propre aujourd'hui tire 16.3.0 et le dashboard ne démarre jamais. | Épingler toutes les dépendances de runtime du pack au patch exact, et câbler `verify-install.mjs` en CI sur les **deux** services. | Survived |
| SUPPLY-002 | P2 | Confirmed | S | Aucune analyse de vulnérabilité des dépendances en CI ; la branche Snyk dort depuis le 3 juin. | `pnpm audit --audit-level=high` non bloquant, et fusionner la branche Snyk. | **P1→P2** (le caret protège déjà les utilisateurs finaux) |

## Token & coût

| ID | Sév. | Confiance | Effort | Problème en une phrase | ★ Recommandation | Challengé ? |
|---|---|---|---|---|---|---|
| TOKEN-001 | P1 | Confirmed | M | Le « plafond en dollars réels » ne se déclenche que sur OpenRouter ; pour les 11 autres providers il ne se déclenche jamais. | Recadrer la promesse plutôt qu'inventer une table de prix qui se périmera silencieusement. | Survived |
| TOKEN-002 | P3 | Confirmed | M | Préfixe système fixe mesuré : 5 480 tk de prompt système réel, 14 589 tk de schémas d'outils, dont 6 462 tk pour les seuls 24 outils Office. | Passer les outils Office en capacité activable, via la refonte ON/OFF déjà au backlog. | **P2→P3** (cache mesuré 49→98 %) |

## Harnais LLM

*Aucun finding.* 16 des 20 contrôles restent `BLOCKED` — un seul fournisseur sur douze a été exercé.
Voir `AUDIT_HARNESSES.md` : ne rien affirmer sur les onze autres est le résultat, pas un oubli.

## Mémoire

| ID | Sév. | Confiance | Effort | Problème en une phrase | ★ Recommandation | Challengé ? |
|---|---|---|---|---|---|---|
| MEMORY-001 | P1 | Confirmed | M | Le filtre anti-injection de la mémoire — la seule surface persistante active par défaut — laisse passer **14 payloads sur 16** mesurés. | Enveloppe autour du bloc `## Persistent memory` ; garder le denylist sans lui prêter plus qu'il ne fait. | Survived |

## Canaux

*Aucun finding.* Les quatre canaux sont en **connexion sortante** (Socket Mode, gateway, long-polling,
socket Baileys) et partagent la même allowlist `channelAllowedConversations` avec confirmation du
propriétaire. Reste non testé : le comportement face à un expéditeur non autorisé.

## Skills, connecteurs & MCP

| ID | Sév. | Confiance | Effort | Problème en une phrase | ★ Recommandation | Challengé ? |
|---|---|---|---|---|---|---|
| SKILL-001 | P1 | Confirmed | S | Les descriptions d'outils MCP, écrites par un tiers, arrivent verbatim dans le contexte à chaque tour — 371 caractères mesurés, aucun plafond. | Cadrer et plafonner la description à l'import, et sortir `create_mcp` de l'auto-approbation. | `Likely`→**Confirmed** (serveur hostile réel) |
| SKILL-002 | P2 | Confirmed | M | Les skills écrites par la boucle d'apprentissage n'ont aucune sanitation de contenu et court-circuitent même le linter. | Faire passer la réflexion par `create_skill`, puis sanitation sur ce chemin unique. | **P0→P1→P2** (`skill_assignment_mode` = `approval` par défaut) |

## Orchestration

*Aucun finding.* Le claim de job est atomique (UPDATE conditionnel), la reprise après arrêt est propre,
les quatre points de refus « pas de faux succès » sont en place. 5 des 9 contrôles restent `BLOCKED`
faute d'exercice sous charge.

## Performance

| ID | Sév. | Confiance | Effort | Problème en une phrase | ★ Recommandation | Challengé ? |
|---|---|---|---|---|---|---|
| PERF-001 | P2 | Confirmed | S | Les 85 tests Playwright ne sont jamais exécutés par la CI. | Test de fumée post-build sur les **deux** services — même correctif que SUPPLY-001. | Survived |

## UX & accessibilité

*Aucun finding.* WCAG 2.1 AA reste `BLOCKED` : l'audit d'accessibilité exige un navigateur, indisponible
cette session. À ne pas lire comme « conforme ».

## Santé du code

| ID | Sév. | Confiance | Effort | Problème en une phrase | ★ Recommandation | Challengé ? |
|---|---|---|---|---|---|---|
| CODE-001 | **P3** | Confirmed | XS | `CLAUDE.md` nomme le mauvais mécanisme : les invariants #1 et #2 sont bien appliqués, par **15 fichiers de tests d'architecture** en CI, pas par ESLint. | Corriger la phrase de `CLAUDE.md`. | **RETIRÉ puis requalifié P2→P3** — l'affirmation initiale était fausse |

---

## Décomptes

**Par sévérité** — P0 : **2** · P1 : **5** · P2 : **11** · P3 : **2** · **Total : 20 findings**

*(après vagues 1 et D : +SKILL-003, +CHANNEL-001, +CONNECTOR-001, +UX-001 ; CODE-001 requalifié P2→P3)*

**Par topic** — Injection & privilège : 3 · Secrets : 3 · Réseau : 1 · Supply chain : 2 ·
Token & coût : 2 · Mémoire : 1 · Skills/MCP : 2 · Performance : 1 · Code : 1 ·
*(Harnais LLM, Canaux, Orchestration, UX : 0 finding — voir les notes de section)*

**Par confiance** — Confirmed : **15** · Likely : **1** · Unverified : **0**

**Couverture** — **57 contrôles sur 137 `COVERED` (42 %)** · 17 `PARTIAL` · 61 `BLOCKED` · 2 `N/A`

**Contrôles vérifiés qui tiennent : 23** — détaillés en fin de `AUDIT_FINDINGS.md` et dans
`AUDIT_MCP_ET_DASHBOARD.md`.

---

## Les trois à corriger en premier

1. **SUPPLY-001** — parce que le produit publié est cassé **en ce moment** pour tout nouvel
   installateur (tarball du registre vérifié, `dist-tags.latest = 0.8.1`), que c'est un caractère à
   retirer, et qu'il n'y a aucun sens à sécuriser un dashboard qui ne démarre pas.

2. **NETWORK-001** — parce que c'est le seul chemin de tout l'audit où un tiers obtient l'exécution
   d'un agent sans aucune condition préalable, dans la configuration que le wizard recommande en
   premier, et que le code du correctif existe déjà, écrit et testé, simplement non branché.

3. **MCP-001** — parce que c'est le seul endroit où une exécution privilégiée se produit sans le
   moindre point de contrôle humain, prouvé en exécution avec contre-épreuve, et que le correctif tient
   en une ligne. Il corrige aussi la moitié de SKILL-001 au passage.

---

## Findings retirés ou déclassés pendant les passes de challenge

Le protocole exige cette section : un audit qui ne déclasse rien à la relecture n'a pas appliqué son
propre standard. **12 mouvements sur 24 findings candidats.**

### Retirés (4)

| Finding | Raison |
|---|---|
| Blanchiment de privilège par délégation | `resolve-agent-tools.ts` montre que la whitelist d'un sous-agent vient de **sa propre** configuration, pas de celle du délégant. Qu'un spécialiste ait des outils que l'orchestrateur n'a pas est la définition de la délégation. Aucun mécanisme de transfert trouvé. |
| Réutilisation d'IV en GCM | `packages/secrets/src/index.ts:93` génère `randomBytes(12)` à **chaque** appel de `encrypt`. Hypothèse réfutée par lecture. |
| `constant-time.ts` présent mais inutilisé | Inventaire exhaustif : utilisé aux quatre sites de comparaison de secret, aucun `===` sur secret. L'hypothèse de départ était saine, la vérification l'a réfutée. |
| `file_list` renvoie `ok` sans workspace configuré | Suspicion de fallback silencieux (invariant #4). En réalité un workspace **partagé** est créé automatiquement (`execute.ts:883-892`) — comportement délibéré, pas un défaut. |

### Requalifiés (2)

| Finding | Raison |
|---|---|
| « `private-origin.ts` ne fonctionne pas » | Le fichier est correct et testé. Le défaut n'est pas son contenu mais son **absence de câblage** sur le runner — reformulé en NETWORK-001. |
| PRIVILEGE-005 (auto-extension ROOT) | Atténué, pas retiré : tous les `root_grants` sont à `false` et l'autonomie à `propose_confirm` sur une entité fraîche, vérifié en base. L'auto-extension exige un geste explicite. |

### Déclassés (6)

| Finding | Mouvement | Raison |
|---|---|---|
| SKILL-002 (skills apprises) | **P0 → P1 → P2** | D'abord parce que `reflection_enabled` vaut `false` par défaut ; puis parce que `skill_assignment_mode` vaut **`approval`** (schéma + base live). L'auto-assignation exige **deux** opt-ins indépendants. |
| INJECT-001 (absence de balisage) | **P1 → P2** | 6 tentatives d'injection réelles sur 2 familles de charges, **0 succès**, 1 signalement explicite à l'utilisateur. L'absence de balisage reste vraie ; l'exploitabilité que P1 sous-entendait n'est pas démontrée. |
| TOKEN-002 (coût du préfixe) | **P1 → P2 → P3** | D'abord parce que les 20 skills ne sont jamais toutes attachées ; puis parce que le cache mesuré (49 %, 89 %, 96 %, 98 %) rend le préfixe quasi gratuit dès le 2ᵉ tour. |
| PRIVILEGE-003 (UX d'approbation) | **P1 → P2** | `computeApprovalImpactLine` est déterministe et calculée par le code : le modèle piloté ne peut pas la falsifier. Reste `Likely` faute de test adversarial exécuté. |
| SECRET-002 (ACL des répertoires) | **P1 → P2** | L'objection « un administrateur lit tout par élévation » retire la moitié de l'impact. Reste le cas du second utilisateur **standard**, marginal pour un produit mono-poste. |
| SUPPLY-002 (Snyk / audit de deps) | **P1 → P2** | Le caret `^4.22.0` du tarball fait que les utilisateurs finaux résolvent déjà vers une version corrigée. Le risque se limite à l'environnement de développement, figé par le lockfile. |

**Aucun finding n'a été aggravé par la phase live.** Les deux P0 sont les seuls points que la mesure
n'a pas adoucis.
