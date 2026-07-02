# Audit Nodal-Agents — Rapport de findings (2026-07-02)

Audit multi-agents (5 streams parallèles) + vérification adversariale ligne-à-ligne par l'orchestrateur. Chaque finding : **verdict** (✅ Confirmé par lecture / 🟡 Plausible), sévérité, complexité de fix, impact, **préconditions** d'exploitation. Aucune modification de code (read-only). Base live sondée en lecture seule.

**Verdict global** : plateforme globalement saine et bien défendue (voir §Signaux positifs). Les findings sérieux se concentrent sur **(1) la surface HTTP du runner qui authentifie mais n'autorise pas par entité**, **(2) l'asymétrie du master-switch d'exécution de code sur LAN**, **(3) la garde de profondeur de délégation inopérante**, et **(4) des faux-`completed` qui mentent sur l'échec**.

---

## 1. Tableau maître — priorité (criticité × impact, complexité en départage)

| # | Finding | Sévérité | Complexité fix | Verdict | Précondition |
|---|---|---|---|---|---|
| **1** | Master-switch LAN Yolo asymétrique : `run_skill_script`/`skill_file_write` s'auto-exécutent (RCE d'un skill autorisé) | 🔴 Élevé | Moyen | ✅ | non-local-trust + destructive_gate/fully_autonomous + skill-à-scripts autorisé |
| **2** | Garde profondeur délégation = no-op → récursion non bornée (DoS/stack/coût) | 🔴 Élevé | **Faible** | ✅ | cycle/chaîne d'assignments (constructible) |
| **3** | IDOR résolution d'approbation cross-tenant (`resolveApprovalDecision` load-by-id) | 🔴 Élevé | **Faible** | ✅ | multi-user (web action) OU bearer-token |
| **4** | Runner authentifie mais n'autorise pas par entité (racine de #3, #5) | 🔴 Élevé | Moyen | ✅ | bearer-token (/api/chat,/api/agent) ; multi-user (/api/approve) |
| **5** | `/api/chat` prend entityId+agentId du body → run cross-tenant (mémoire + clé LLM victime) | 🔴 Élevé | Faible-Moy | ✅ | bearer-token |
| **6** | `updateAgentAction` insère subAgentIds sans check entité (asymétrie vs create) | 🟠 Moy-Élevé | **Faible** | ✅ | connaître l'UUID d'un agent victime + re-scoping team-block absent |
| **7** | Root « toutes tâches échouées » marqué `completed` (faux succès) | 🟠 Moyen | Moyen | ✅ (corroboré live) | fan-out cron où tout échoue |
| **8** | `env: process.env` hérité → exfiltration secrets via run_command/run_skill_script | 🟠 Moyen | Faible-Moy | ✅ | une commande approuvée qui lit l'env |
| **9** | Plancher catastrophic gaté `run_command` seul (pas run_skill_script) | 🟠 Moyen | Faible | ✅ | script destructif sous Yolo |
| **10** | Approbation Telegram par n'importe quel membre d'un groupe | 🟠 Moyen | Moyen | 🟡 | bot dans un groupe |
| **11** | local-trust + bind LAN non gardé (footgun RCE non-auth) | 🟠 Moyen | Moyen | ✅ | config manuelle auth.mode=local-trust + bind=lan |
| **12** | Coût cumulé sous-compté aux suspend/resume → cap $ contournable | 🟠 Moyen | Faible | 🟡 | job à suspensions/délégations répétées |
| **13** | `'rate limit exceeded'` traité comme quota fatal → échec sans retry | 🟠 Moyen | Faible | 🟡 | 429 transitoire OpenRouter/Groq |
| **14** | Dép planner blocked/cancelled → dépendante figée `todo` → root jamais livré (stall) | 🟠 Moyen | Moyen | 🟡 | workflow planner avec dép qui bloque |
| **15** | Délégation planner imbriquée : parent coincé `awaiting_delegation` | 🟠 Moyen | Moyen | 🟡 | A→B où B create_task |
| **16** | Approbations concurrentes ré-appariées par toolName pas toolCallId | 🟠 Moyen | Moyen | 🟡 | tour reads + ≥2 appels d'un read gaté |
| **17** | Invariants sémantiques #1-6/8/9 non enforced par la CI | 🟠 Moyen | Moyen | ✅ | — (risque de dérive) |
| **18** | Test-helper plus strict que la prod (UNIQUE droppées en prod 0016/0017) → drift | 🟠 Moyen | **Faible** | ✅ | tests multi-instance |
| **19** | Garde erreur-sœur contournée si erreur outil >50K chars → faux completed | 🟡 Faible-Moy | Faible | 🟡 | erreur d'outil volumineuse + return_result même tour |
| **20** | fetch archive : buffer entier avant cap (OOM) + redirect follow (SSRF open-redirect) | 🟡 Faible | Moyen | 🟡 | hôte allowlisté compromis/redirect |
| **21** | `create_task assigned_to` par slug sans check entité | 🟡 Faible | Faible | 🟡 | LLM fournit un slug étranger |
| **22** | Schedules inline bloquent le tick cron (latence + chevauchement) | 🟡 Faible-Moy | Moyen | 🟡 | schedule long |
| **23** | Cap coût $ (Guard 1e) ne marche que pour OpenRouter | 🟡 Faible | Moyen | ✅ (dette) | clé provider natif |
| **24** | `streamText` contourne le failover | 🟡 Faible | Moyen | ✅ | chemin streaming porteur |
| **25** | `deliverCompletedRoots` re-scanne toute `agent_tasks` par tick | 🟡 Faible | Faible-Moy | 🟡 | historique volumineux |
| **26** | Comparaison token bearer non constant-time | 🟡 Faible | Trivial | ✅ | side-channel théorique |
| **27** | Lectures jobs enfants non re-scopées (défense en profondeur) | 🟡 Faible | Faible | 🟡 | — |
| **28** | run_command catastrophique approuvé → jamais exécuté, erreur opaque | 🟡 Faible | Faible | ✅ | approbation d'une commande catastrophique |
| **29** | Version-check sans semver-gt → suggère un downgrade | 🟡 Faible | Trivial | ✅ | version locale > npm |

## 2. Quick wins — impact élevé, fix Faible/Trivial (à faire en premier)

- **#2** garde profondeur délégation : comparer `job.delegationDepth` au max près du check chainCount (execute.ts:~629). **Ferme un DoS pour ~5 lignes.**
- **#3** IDOR approbation : exiger `approval.entityId === entité appelant` (resolve.ts) + scoper la web action. **Ferme une faille cross-tenant réelle en multi-user.**
- **#6** subAgentIds : répliquer le check `inArray(entityId)` de `createAgentRepo` dans `updateAgentAction`.
- **#8** secrets : passer un env allowlisté au lieu de `process.env` entier aux 2 spawns.
- **#18** test-helper : retirer les 2 `UNIQUE(entity_id, slug)` obsolètes.
- **#26 / #29** : `timingSafeEqual` pour le bearer token ; `semver.gt` pour la notice de version.

---

## 3. Findings par section

### C — Cœur runtime (`apps/runner/src/job`)
| Réf | Finding | file:line | Sév | Verdict |
|---|---|---|---|---|
| RT-1 (#2) | Garde profondeur délégation jamais appliquée (ChainCounters recréé à 0, `job.delegationDepth` non comparé) | execute.ts:1248,2419 · chain-counters.ts:195 | Élevé | ✅ |
| RT-2 (#12) | `totalCostUsd` omis aux saveCheckpoint de suspension → sous-comptage | execute.ts:1475,1552,2400,2886 | Moyen | 🟡 |
| RT-3 (#16) | Pré-pass parallèle + ré-appariement par toolName | execute.ts:2201,1456 | Moyen | 🟡 |
| RT-6 (#19) | isToolErrorBlock rate une erreur tronquée en text (>50K) → faux completed | execute.ts:2628,1318 | Faible-Moy | 🟡 |

### D — Orchestration (`packages/orchestration`)
| Réf | Finding | file:line | Sév | Verdict |
|---|---|---|---|---|
| OR-4 (#14) | Dép blocked/cancelled → dépendante figée todo → root jamais complété | planner/dependencies.ts:139 · completion.ts:31 | Moyen | 🟡 |
| OR-5 (#15) | Délégation imbriquée : maybeResumeParent non appelé par la finalisation cron | execute.ts:2511,507 | Moyen | 🟡 |
| OR-7 (#21) | create_task assigned_to sans check entité | planner/task-tools.ts:92 | Faible | 🟡 |
| — | **CLEAN** : invariant #1 (zéro hardcode), #2 (textes runner = codes), appariement tool_use↔result, gardes maxTurns/tools/chains/tokens/cost RÉELLEMENT appliquées, compaction structure-safe | — | ✅ positif |

### B — Modèle de données & multi-tenant (`packages/db`)
| Réf | Finding | file:line | Sév | Verdict |
|---|---|---|---|---|
| DB-5 (#18) | Test-helper déclare des UNIQUE droppées en prod (0016/0017) → drift | tests/helpers.ts:220,406 | Moyen | ✅ |
| — | Slugs uniques GLOBAUX cross-tenant (agents/entities/skills/webhooks) : pas une fuite mais squat + résolution globale (voir L-3) | schema/agents.ts:25 | Info | ✅ |
| — | **CLEAN** : journal migrations 53=53 sans trou ; cascades entités correctes ; credentials scopé ownerUserId (by design, vérifié) | — | ✅ positif |

### L — Surfaces API & Web
| Réf | Finding | file:line | Sév | Verdict |
|---|---|---|---|---|
| L-1 (#3) | `/api/approve` IDOR (load-by-id sans entité) | approvals/resolve.ts:44 · routes/approve.ts | Élevé | ✅ |
| L-2 (#5) | `/api/chat` entityId+agentId du body | routes/chat.ts:16 · run-chat-turn.ts:107 | Élevé | ✅ |
| L-3 (#4) | `requireRunnerAuth` : auth sans autorisation-par-entité (racine) ; bearer-token accepte toute session | server.ts:60-99 | Élevé | ✅ |
| L-4 (#6) | `updateAgentAction` subAgentIds sans check entité | actions.ts:767 (vs repos/agents.ts:57) | Moy-Élevé | ✅ |
| L-6 (#27) | Lectures jobs enfants non re-scopées | actions.ts:1558,1464 | Faible | 🟡 |
| — | **CLEAN** : toute la couche server-actions du web est disciplinée (fetch-then-check-by-entityId) SAUF L-4/L-6 | — | ✅ positif |

### F — Outils & exécution de code
| Réf | Finding | file:line | Sév | Verdict |
|---|---|---|---|---|
| EX-1 (#1) | Master-switch LAN Yolo ne couvre que run_command | execute.ts(runner):1210 · execute.ts(tools):88-101 | Élevé | ✅ |
| EX-2 (#8) | `env: process.env` hérité | run-command.ts:138 · run-skill-script.ts:208 | Moyen | ✅ |
| EX-3 (#9) | Plancher catastrophic gaté run_command | tools/execute.ts:110 | Moyen | ✅ |
| EX-4 (#20) | fetch archive OOM + redirect SSRF | skills/fetch.ts:41,51 | Faible | 🟡 |
| — | **CLEAN** : whitelist RÉELLEMENT enforced (pas cosmétique), sandbox chemins solide, zip-slip/SSRF install couverts, meta-tools ROOT gatés, reflection provenance-gated | — | ✅ positif |

### H — Approbations & autonomie
| Réf | Finding | file:line | Sév | Verdict |
|---|---|---|---|---|
| AZ-3 (#28) | run_command catastrophique approuvé jamais exécuté, erreur opaque | tools/execute.ts:110 · execute.ts:1410 | Faible | ✅ |
| AZ-5 | entityId nullable + `?? ''` (affaiblit l'attribution, compose avec L-1) | schema/approvals.ts:15 | Info | ✅ |
| — | **CLEAN** : master-switch enforced à l'EXÉCUTION, resume fidèle (présenté=exécuté), pas de builtin « approve » pour agents | — | ✅ positif |

### I — Secrets & auth
| Réf | Finding | file:line | Sév | Verdict |
|---|---|---|---|---|
| AZ-2 (#11) | local-trust + bind LAN non gardé | server.ts:65 · cli/env.ts:52 | Moyen | ✅ |
| AZ-4 (#26) | Comparaison token bearer non constant-time | auth/providers/bearer-token.ts:30 | Faible | ✅ |
| — | **CLEAN** : AES-256-GCM (IV/op, tag vérifié, fail-loud), refresh OAuth rotatif sans fuite, WORKER_SECRET timing-safe, state OAuth HMAC+PKCE | — | ✅ positif |

### E — LLM
| Réf | Finding | file:line | Sév | Verdict |
|---|---|---|---|---|
| LL-1 (#13) | `'rate limit exceeded'` → quota fatal | llm/retry.ts:26 | Moyen | 🟡 |
| LL-5 (#23) | Cap coût $ OpenRouter-only | execute.ts:1853 | Faible | ✅ dette |
| LL-6 (#24) | streamText sans failover | llm/failover.ts:98 | Faible | ✅ |
| — | **CLEAN** : message-structure valide, embeddings fail-loud, heartbeat neutralise le reaper sur appel lent, reasoning round-trip correct | — | ✅ positif |

### J — Connecteurs & MCP
| — | **CLEAN** : MCP `structuredContent` correctement géré (faux-vide historique FIXÉ), SDK officiels partout | adapters/mcp/tools.ts:84 | ✅ positif |

### K — Livraison & canaux
| Réf | Finding | file:line | Sév | Verdict |
|---|---|---|---|---|
| DL-2 (#7) | Root all-failed → completed (faux succès) | cron/deliver-results.ts:88 | Moyen | ✅ live |
| DL-3 (#10) | Approbation Telegram par tout membre d'un groupe | telegram/approval-callback.ts:103 | Moyen | 🟡 |
| — | **CLEAN** : split 4096, redaction bot-token dans erreurs, gating anti-fantôme (pas de chatId = pas d'envoi) | — | ✅ positif |

### M — Cron
| Réf | Finding | file:line | Sév | Verdict |
|---|---|---|---|---|
| CR-4 (#22) | Schedules inline bloquent le tick + chevauchement | cron/run-schedules.ts:148 · tick.ts:97 | Faible-Moy | 🟡 |
| CR-7 (#25) | deliverCompletedRoots re-scanne toute agent_tasks | cron/deliver-results.ts:34 | Faible | 🟡 |
| — | **CLEAN** : claims idempotents + gardes parent-en-attente solides | — | ✅ positif |

### A — Enforcement des invariants
| Réf | Finding | Sév | Verdict |
|---|---|---|---|
| INV-A (#17) | Invariants #1,2,3,4,6,8,9 sans enforcer CI (seuls structurels + no-any + native-dialogs le sont) | Moyen | ✅ |
| — | **CLEAN** : qualité des tests excellente (4542 assertions-résultat vs 201 call-counts, 0 fichier call-count-only → invariant #5 respecté) | — | ✅ positif |

### N — CLI
| Réf | Finding | file:line | Sév | Verdict |
|---|---|---|---|---|
| CLI-1 (#29) | Version-check `!==` au lieu de semver-gt → suggère downgrade | cli/commands/up.ts:377 | Faible | ✅ |

---

## 4. Thèmes transverses

1. **Modèle de confiance runner ↔ web** : le runner délègue TOUT le scoping-entité au web (supposé de confiance). Cette hypothèse casse dès qu'on active `bearer-token` (accepte des sessions end-user arbitraires) — c'est la racine de #3/#4/#5. Recommandation : autorisation per-request côté runner (lier session→entité, asserter que les ids du body appartiennent à l'entité).
2. **Exécution de code sous-gardée sur LAN** : le master-switch (#1), le plancher catastrophic (#9) et l'héritage d'env (#8) traitent `run_command` comme le seul vecteur, alors que `run_skill_script`/`skill_file_write` sont aussi capables. Les trois se composent en RCE+exfiltration non surveillée.
3. **Honnêteté du statut** (invariant #4) globalement bien tenue MAIS trois angles morts : root all-failed→completed (#7), erreur tronquée→completed (#19), stalls planner silencieux (#14/#15).
4. **Signaux positifs nombreux** : chiffrement, whitelist, sandbox chemins, install communautaire, MCP, resume, gardes runtime cœur, qualité des tests — tous vérifiés solides.

*Audit produit par orchestration multi-agents (Fable 5) + vérification adversariale. Findings 🟡 = à reproduire par un test/POC avant fix. Préconditions à lire attentivement : plusieurs findings « Élevé » ne sont exploitables qu'en mode `bearer-token` ou multi-user, pas sur un poste local mono-utilisateur.*
