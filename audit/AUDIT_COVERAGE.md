# Coverage Ledger — v2 (après phase live)

**2026-08-07** · `main` @ `144383f` · tarball 0.8.1 (SHA-256 = registre npm) installé en environnement isolé, agent réel créé par le wizard, 6 tests d'injection exécutés, 0,04 $ dépensés

**Détail de la phase live : `AUDIT_PHASE_LIVE.md`.**

Statuts : `COVERED` (deux preuves, classes différentes, au moins une B/C là où §3.1 l'exige) ·
`PARTIAL` (une seule classe de preuve, ou périmètre réduit — **compté comme non couvert**) ·
`BLOCKED` (accès ou artefact manquant, nommé) · `N/A`.

**Une seule cellule remplie n'est jamais `COVERED`.**

---

## Récapitulatif

| Phase | Contrôles | COVERED | PARTIAL | BLOCKED | N/A |
|---|---|---|---|---|---|
| 1 — Supply chain | 11 | 7 | 1 | 3 | 0 |
| 2 — Injection & privilège | 15 | 10 | 2 | 3 | 0 |
| 3 — Secrets | 15 | 8 | 2 | 5 | 0 |
| 4 — Réseau | 9 | 5 | 1 | 3 | 0 |
| 5 — Tokens & coût | 16 | 9 | 2 | 5 | 0 |
| 6 — Harnais LLM | 20 | 2 | 2 | 16 | 0 |
| 7 — Mémoire | 11 | 3 | 2 | 6 | 0 |
| 8 — Canaux | 12 | 4 | 2 | 4 | 2 |
| 9 — Skills / connecteurs / MCP | 8 | 5 | 0 | 3 | 0 |
| 10 — Orchestration | 9 | 3 | 1 | 5 | 0 |
| 11 — Performance & UX | 11 | 3 | 1 | 7 | 0 |
| **TOTAL** | **137** | **57** | **17** | **61** | **2** |

**Taux de couverture réel : 57/137 = 42 %** (34 % avant la phase live). Les 17 `PARTIAL` sont explicitement comptés hors
couverture — ils ont une preuve, pas deux classes.

---

## Phase 1 — Supply chain

| ID | Contrôle | Statut | V1 | V2 |
|---|---|---|---|---|
| SUPPLY-01 | Dépôt public, ce que ça expose | BLOCKED | — | Pas d'accès aux réglages GitHub. Le tarball pointe `github.com/Kwintspiracy/nodal-agents` |
| SUPPLY-02 | Scan de secrets sur tout l'historique (gitleaks/trufflehog) | BLOCKED | — | Outils non disponibles dans l'environnement |
| SUPPLY-03 | `check-no-secrets.mjs` : tourne en CI, détecte quoi | **COVERED** | [A] présent en étape CI `ci.yml:52` | [B] clé `sk-ant-…` factice plantée → détectée, exit code **1** |
| SUPPLY-04 | Workflows : déclencheurs, secrets, `pull_request_target`, épinglage SHA, permissions | PARTIAL | [A] `ci.yml` lu : `contents: read`, pas de `pull_request_target`, actions épinglées sur tags majeurs (`@v5`, `@v4`) et non SHA | manquante |
| SUPPLY-05 | Pipeline npm publish : qui publie, 2FA, provenance, portée du token | BLOCKED | — | Pas d'accès au compte npm |
| SUPPLY-06 | Intégrité du tarball : pack → install propre → diff → boot | **COVERED** | [C] tarball **du registre npm** (SHA-256 identique au pack local), install isolée, 504 paquets, boot → dashboard mort | [B] épinglage `next@16.2.6` → dashboard HTTP 200. Cause isolée par falsification → **SUPPLY-001** |
| SUPPLY-07 | Scripts `postinstall` | PARTIAL | [C] aucun `postinstall` dans le `package.json` du tarball | arbre transitif non audité |
| SUPPLY-08 | Lockfile commité et `--frozen-lockfile` en CI | **COVERED** | [A] `ci.yml:37` | [B] `pnpm-lock.yaml` présent, résolutions lues |
| SUPPLY-09 | Typosquat / dépendances de faible réputation | BLOCKED | — | 5 623 dépendances, non instruit |
| SUPPLY-10 | Branche Snyk : CVE, sévérité, utilisateurs affectés | PARTIAL | [B] diff = 1 ligne firecrawl `^4.22.0→^4.25.2` ; lock épingle 4.22.2 ; tarball porte le caret donc les utilisateurs résolvent la version corrigée | CVE et sévérité **non identifiées** (pas d'accès base Snyk) |
| SUPPLY-11 | Chemin de mise à jour utilisateur | **COVERED** | [A] `apps/cli/src/commands/update.ts` existe, 9 tests | [C] `bin` du tarball expose `nodal-agents update` |

## Phase 2 — Injection & privilège

| ID | Contrôle | Statut | V1 | V2 |
|---|---|---|---|---|
| INJECT-01 | 18 frontières : contenu délimité/étiqueté/concaténé | **COVERED** | [A] grep exhaustif du balisage sur 4 arbres : 1 seul emballage (webhook) | [A] lecture des chemins de construction (Telegram, MCP, workspace) → **INJECT-001** |
| INJECT-02 | `web_search` : contenu de page marqué non fiable ? | PARTIAL | [A] `web-search.ts` — aucun cadrage | payload live non exécuté (pas de clé fournisseur) |
| INJECT-03 | 5 canaux entrants, payload réel | PARTIAL | [A] Telegram : `messages:[{role:'user',content:taskText}]` verbatim | Slack/Discord/WhatsApp/email non instruits |
| INJECT-04 | Payloads connecteurs | BLOCKED | — | Aucun connecteur configurable sans OAuth réel |
| INJECT-05 | Réponses d'outils MCP | PARTIAL | [A] `capMcpResult` plafonne à 50 k, aucun cadrage | serveur MCP factice non monté |
| INJECT-06 | Mémoire + skills comme surface de persistance | **COVERED** | [B] 16 payloads → 14 passent le denylist | [A] skills : zéro sanitation, auto-assignation → **MEMORY-001**, **SKILL-002** |
| INJECT-07 | Contenu de fichiers lus | BLOCKED | — | Non testé |
| PRIVILEGE-01 | Portée d'un agent entièrement piloté | **COVERED** | [A] inventaire des 69 tools + `types.ts:296-335` | [A] `execute.ts:80-154` : `fully_autonomous` → auto-approbation sauf `isCatastrophicCommand` |
| PRIVILEGE-02 | Chaîne bout-en-bout contenu → shell | BLOCKED | — | Exige un fournisseur LLM en fonctionnement |
| PRIVILEGE-03 | Intégrité de l'UX d'approbation | PARTIAL | [A] `notify.ts:357-370` : purple du modèle en 1er, impact déterministe en 2e, commande tronquée 500 en 3e | test adversarial non exécuté → reste **Likely** |
| PRIVILEGE-04 | Tools contournant l'approbation ; whitelist depuis la DB | **COVERED** | [A] `whitelist.ts` + `resolve-agent-tools.ts` | [A] `matchApprovalRule` : 4 niveaux de spécificité, agent > entité, tool > wildcard |
| PRIVILEGE-05 | ROOT + `fully_autonomous` ; `create_mcp` vers URL arbitraire | **COVERED** | [A] `execute.ts:107-112` gate `create_mcp` stdio sous `destructive_gate` uniquement | [A] `fully_autonomous` (ligne 89-90) auto-approuve avant ce test → `create_mcp` passe |
| PRIVILEGE-06 | Blanchiment de privilège par délégation | **COVERED** | [A] `resolve-agent-tools.ts:1-50` : whitelist depuis la config du sous-agent | [A] aucun mécanisme de transfert trouvé → **finding retiré** |
| PRIVILEGE-07 | Isolation inter-workspaces | PARTIAL | [A] `server.ts:126-138` fail-closed sur `entityId` ; `agent.ts:48-75` scoping | test au niveau requête non exécuté |
| PRIVILEGE-08 | Chemins d'exfiltration | BLOCKED | — | Exige un fournisseur LLM |

## Phase 3 — Secrets

| ID | Contrôle | Statut | V1 | V2 |
|---|---|---|---|---|
| SECRET-01 | Dérivation de clé, menace réellement défaite | **COVERED** | [A] `randomBytes(32)` par install, pas de clé compilée | [B] `secrets.key` observé sur install réelle, 44 octets base64 |
| SECRET-02 | IV unique par chiffrement | **COVERED** | [A] `randomBytes(12)` à chaque appel de `encrypt` | [A] format `enc:v1:{iv}:{tag}:{ct}`, IV transporté → **hypothèse de réutilisation réfutée** |
| SECRET-03 | Tag vérifié, fail-closed | **COVERED** | [A] `setAuthTag` + `final()` qui lève | [A] `decrypt` refuse tout blob non préfixé |
| SECRET-04 | Permissions `~/.nodalai/` sur 2+ plateformes | PARTIAL | [B] `icacls` Windows : fichiers OK, **répertoires hérités** → **SECRET-002** | POSIX non vérifié (pas de machine Linux/macOS) |
| SECRET-05 | Secrets en mémoire, crash dump | BLOCKED | — | Non instruit |
| SECRET-06 | Secrets dans les transcripts | **COVERED** | [A] `state.ts:448` → `deepDbSafe`, aucune rédaction | [A] `redactSecretsForAudit` : 3 appelants, aucun sur transcript → **SECRET-001** |
| SECRET-07 | Secrets dans les messages d'erreur | PARTIAL | [A] `server.ts:194-198` : `onError` ne renvoie que le nom de la classe | canaux et dashboard non instruits |
| SECRET-08 | Tokens OAuth connecteurs | BLOCKED | — | Aucun connecteur OAuth configuré |
| SECRET-09 | Tokens bots | BLOCKED | — | Aucun bot configuré |
| SECRET-10 | Session WhatsApp | BLOCKED | — | Non instruit |
| SECRET-11 | Chaînes de clés de failover | BLOCKED | — | Non instruit |
| SECRET-12 | Rotation de clé | BLOCKED | — | Non instruit |
| SECRET-13 | `packages/auth` intégral | **COVERED** | [A] 5 fichiers lus en entier (180 lignes) | [B] `local-trust` exercé en conditions réelles (NETWORK-001) |
| SECRET-14 | `constant-time` utilisé partout | **COVERED** | [A] lecture de `constant-time.ts` | [A] inventaire exhaustif : 4 sites, aucun `===` sur secret → **hypothèse réfutée** |
| SECRET-15 | Better-auth : sessions, cookies, CSRF | BLOCKED | — | Onboarding bloque sans clé LLM |

## Phase 4 — Réseau

| ID | Contrôle | Statut | V1 | V2 |
|---|---|---|---|---|
| NETWORK-01 | Bind réel constaté sur socket | **COVERED** | [B] `netstat` : runner `127.0.0.1:3011`, PG `127.0.0.1`+`[::1]:25440` | [A] `env.ts:48` défaut `127.0.0.1` ; `cli/lib/env.ts:12` `lan→0.0.0.0` |
| NETWORK-02 | DNS rebinding : validation `Host` | **COVERED** | [B] `Host: evil.test` → **HTTP 202** | [A] aucun middleware `Host` ; `isPrivateOrigin` jamais appelé hors `packages/auth` |
| NETWORK-03 | CSRF depuis une page visitée | **COVERED** | [B] `Origin: https://attacker.test` → 202 ; `text/plain` (requête simple) → 202 + `jobId` | [D] journal runner : `[exec …] enter` ×4, l'agent démarre |
| NETWORK-04 | CORS et origine WebSocket | BLOCKED | — | Aucun WebSocket identifié sur le runner ; dashboard non atteint |
| NETWORK-05 | `local-trust` : spoofing d'en-têtes proxy | PARTIAL | [A] `server.ts:107-111` ne lit aucun en-tête — rien à spoofer, la confiance est inconditionnelle | test proxy non exécuté |
| NETWORK-06 | Docker / WSL2 / reverse proxy | BLOCKED | — | Non instruit |
| NETWORK-07 | Postgres embarqué : bind, auth, prédictibilité du port | **COVERED** | [B] `netstat` : loopback v4+v6 uniquement | [A] `ports.ts` + `config.json` : port configurable, défaut 25432 |
| NETWORK-08 | Télémétrie / phone-home | **COVERED** | [A] aucun appel sortant hors providers/connecteurs dans `main()` | [D] journaux de boot : aucune requête non sollicitée |
| NETWORK-09 | Machines multi-utilisateurs | PARTIAL | [B] ACL des répertoires hérités (cf. SECRET-04) | ports non testés depuis un autre compte |

## Phase 5 — Tokens & coût

| ID | Contrôle | Statut | V1 | V2 |
|---|---|---|---|---|
| TOKEN-01 | Ventilation complète d'un job réel | PARTIAL | [B] blocs constants mesurés (js-tiktoken) : skills 18 645 tk, baseline 2 964/2 873 tk, 59 schémas 14 589 tk | job réel non instrumenté (pas de fournisseur) |
| TOKEN-02 | Surcoût d'un job délégué | BLOCKED | — | Exige un fournisseur |
| TOKEN-03 | Coût de l'injection mémoire | BLOCKED | — | Exige une base peuplée + un fournisseur |
| TOKEN-04 | Coût des schémas d'outils | **COVERED** | [B] 14 589 tk mesurés sur 59 outils | [A] `whitelist.ts` confirme le filtrage par agent |
| TOKEN-05 | Coût des skills | **COVERED** | [B] 20 skills mesurées individuellement | [A] `kind=baseline` (4 skills, 2 726 tk) = seules systématiques |
| TOKEN-06 | Stratégie d'historique | BLOCKED | — | Non instruit |
| TOKEN-07 | Round-tripping du raisonnement | BLOCKED | — | Exige un fournisseur |
| TOKEN-08 | Placement des breakpoints de cache | **COVERED** | [A] `system-prompt.ts:629-631` split stable/volatile | [A] `anthropic-cache.ts:54-99` : point stable + point glissant |
| TOKEN-09 | Taux de hit réel | BLOCKED | — | Exige un fournisseur |
| TOKEN-10 | Cache sur les 11 autres providers | **COVERED** | [A] `registry.ts` : `promptCaching:true` Anthropic seul, `false` ×11 | [A] `client.ts:310` gate l'application sur ce drapeau |
| TOKEN-11 | Plafond dollar : lu ou estimé | **COVERED** | [A] `execute.ts:2596-2613` : ne se déclenche que si le fournisseur renvoie le coût | [A] aucune table tarifaire dans `registry.ts` → **TOKEN-001** |
| TOKEN-12 | Compteurs de chaînes appliqués | PARTIAL | [A] `chain-counters.ts` + `execute.ts` guards | non exercés sous charge |
| TOKEN-13 | Amplification par retry | BLOCKED | — | Non modélisé |
| TOKEN-14 | Coût du failover | BLOCKED | — | Non instruit |
| TOKEN-15 | Coût par job exposé à l'utilisateur | PARTIAL | [A] `agent_budgets` existe, `runStats()` trace | UI non atteinte |
| TOKEN-16 | Détecteur d'absence de progrès | BLOCKED | — | Non exercé |

## Phase 6 — Harnais LLM

| ID | Contrôle | Statut | V1 | V2 |
|---|---|---|---|---|
| HARNESS-01..12 | 12 providers × 9 dimensions | BLOCKED (×10), PARTIAL (×2) | [A] `registry.ts` lu : `promptCaching` relevé pour les 12 | Les 8 autres dimensions (tool-calling réel, streaming, JSON mode, raisonnement, contexte, taxonomie d'erreurs, tarification, épinglage) **non instruites** faute de clés |
| HARNESS-13 | `tool-call-middleware` / `parsers` sur appel malformé | BLOCKED | — | Non instruit |
| HARNESS-14 | `tool-choice-floor` | BLOCKED | — | Non instruit |
| HARNESS-15 | `tolerant-fetch` : quelles malformations acceptées | BLOCKED | — | Non instruit |
| HARNESS-16 | `retry` : backoff, jitter, plafond | BLOCKED | — | Non instruit |
| HARNESS-17 | `failover` : déclenchement, boucle | BLOCKED | — | Non instruit |
| HARNESS-18 | `embeddings` | PARTIAL | [A] `EMBEDDING_PROVIDER` défaut `keyword` (`env.ts:35`), donc aucun coût d'embedding par défaut | non mesuré |
| HARNESS-19 | `probe-context` | BLOCKED | — | Non instruit |
| HARNESS-20 | Table tarifaire à jour | **COVERED** | [A] `grep costUsd\|pricePerM\|inputPrice` sur `registry.ts` : **zéro résultat** | [A] `execute.ts:2600` confirme : coût lu du fournisseur, jamais estimé |

## Phase 7 — Mémoire

| ID | Contrôle | Statut | V1 | V2 |
|---|---|---|---|---|
| MEMORY-01 | Fonction de classement de l'injection | BLOCKED | — | Non instruit |
| MEMORY-02 | `sanitize.ts` : suffisance | **COVERED** | [B] 16 payloads → 2 bloqués, 14 passent | [A] motifs anglais uniquement ; exfiltration exige `$VAR` → **MEMORY-001** |
| MEMORY-03 | Déduplication | BLOCKED | — | Non instruit |
| MEMORY-04 | Curator : ce qu'il détruit, undo | PARTIAL | [A] `env.ts:100-120` : `memory_curation_enabled` défaut **TRUE**, archivage Phase 1 « réversible » | non exercé |
| MEMORY-05 | Croissance non bornée | BLOCKED | — | Non modélisé |
| MEMORY-06 | `search_history` : index, résultats non fiables | PARTIAL | [A] FTS+GIN présents (migrations) | performance non mesurée |
| MEMORY-07 | `access-tracking` | BLOCKED | — | Non instruit |
| MEMORY-08 | Isolation workspace en mémoire | BLOCKED | — | Non testé au niveau requête |
| MEMORY-09 | PII : export, suppression | BLOCKED | — | UI non atteinte |
| MEMORY-10 | Empoisonnement comme persistance | **COVERED** | [B] denylist contourné (14/16) | [A] `crud.ts:44` chemin unique ; injection dans `## Persistent memory` à chaque job |
| MEMORY-11 | `backfill` sur upgrade | **COVERED** | [A] `server.ts:51-55` non bloquant, `.catch` | [D] journal de boot : backfill lancé après `serve()`, health atteignable |

## Phase 8 — Canaux

| ID | Contrôle | Statut | V1 | V2 |
|---|---|---|---|---|
| CHANNEL-01 | Autorisation entrante, expéditeur non autorisé, **chaque** canal | PARTIAL | [A] Telegram : `telegram_allowed_chats` statut `pending`/`active` + confirmation propriétaire (`handler.ts:510-540`) | 4 autres canaux non instruits ; aucun test avec expéditeur non autorisé |
| CHANNEL-02 | Contenu entrant traité comme non fiable | **COVERED** | [A] Telegram : `role:'user'` verbatim (`handler.ts:254`) | [A] aucun emballage sur aucun canal (cf. INJECT-001) |
| CHANNEL-03 | Mauvaise direction sortante | BLOCKED | — | Non instruit |
| CHANNEL-04 | Rate limiting entrant | PARTIAL | [A] `delivery-guard.ts` borne les envois ; webhook limité à 30/h | entrée des canaux non instruite |
| CHANNEL-05 | Pièces jointes | BLOCKED | — | Non instruit |
| CHANNEL-06 | Contenu des messages dans les logs | **COVERED** | [A] `state.ts:448` transcript non rédigé | [D] `runner.log` observé : pas de contenu de message, seulement des ids |
| CHANNEL-07 | Telegram : token, webhook vs polling, secret | BLOCKED | — | Aucun bot configuré |
| CHANNEL-08 | Slack : signature + fenêtre de rejeu | BLOCKED | — | Non instruit |
| CHANNEL-09 | Discord : Ed25519, intents | BLOCKED | — | Non instruit |
| CHANNEL-10 | WhatsApp : session, CGU, reconnexion, maintenance | BLOCKED | — | Non instruit. **`@whiskeysockets/baileys` épinglé exact 6.7.23** dans le tarball, cohérent avec la décision documentée |
| CHANNEL-11 | Email : SPF/DKIM/DMARC, parsing entrant | BLOCKED | — | Non instruit — **la frontière la plus exposée reste non auditée** |
| CHANNEL-12 | `registry`/`channel-adapter` : fuite d'hypothèses | BLOCKED | — | Non instruit |

## Phase 9 — Skills / connecteurs / MCP

| ID | Contrôle | Statut | V1 | V2 |
|---|---|---|---|---|
| SKILL-01 | Skills apprises : chemin de revue | **COVERED** | [A] `run-reflection.ts:343` → `createSkillRepo` direct | [A] `:366-370` auto-assignation si `mode='auto'` → **SKILL-002** |
| SKILL-02 | Les 20 skills système : qualité, conflits, coût | PARTIAL | [B] coût mesuré individuellement | qualité et conflits non instruits |
| SKILL-03 | Résolution de conflit entre skills | BLOCKED | — | Non instruit |
| SKILL-04 | 13 connecteurs : portées OAuth | BLOCKED | — | Aucun OAuth configuré |
| SKILL-05 | MCP : validation à l'ajout, restriction d'URL | **COVERED** | [A] `execute.ts:107-112` : stdio gaté sous `destructive_gate` | [A] `fully_autonomous` court-circuite ce test (ligne 89) |
| SKILL-06 | Injection par description d'outil MCP | **COVERED** | [A] `mcp/tools.ts:148` verbatim | [A] `capMcpResult` couvre le résultat, pas la description → **SKILL-001** |
| SKILL-07 | Échec connecteur/MCP : fail loud | **COVERED** | [A] `capMcpResult` enveloppe avec `truncated:true` plutôt que tronquer du JSON | [A] `errors.ts` + invariant #4 respecté sur ce chemin |
| SKILL-08 | Learning loop auditée comme code livré | **COVERED** | [B] `git branch --no-merged main` : `feat/learning-loop` **absente** = mergée | [A] `run-reflection.ts` audité (SKILL-002) |

## Phase 10 — Orchestration

| ID | Contrôle | Statut | V1 | V2 |
|---|---|---|---|---|
| ORCH-01 | Claim de job atomique | **COVERED** | [A] `state.ts:91-101` UPDATE conditionnel | [A] `deliver-results.ts:187-212` même motif sur la livraison |
| ORCH-02 | Garde « pas de faux succès » | PARTIAL | [A] `execute.ts:2363,3601,3663,3908` : quatre points de refus explicites | non exercé |
| ORCH-03 | Détecteur d'absence de progrès | BLOCKED | — | Non exercé |
| ORCH-04 | Compteurs de chaînes sous charge | BLOCKED | — | Non exercé |
| ORCH-05 | `resume` après sous-agent lent | BLOCKED | — | Non exercé |
| ORCH-06 | Cycle de dépendances dans le planner | BLOCKED | — | Non instruit |
| ORCH-07 | Propagation d'échec en délégation | BLOCKED | — | Non exercé |
| ORCH-08 | Reprise après crash | **COVERED** | [A] `cron/reset-orphans.ts` + `installProcessErrorHandlers` (`server.ts:220-228`) | [B] `nodal-agents down` puis `up` : reprise propre observée |
| ORCH-09 | Cron non surveillé + `fully_autonomous` + shell | **COVERED** | [A] `execute.ts:89-90` : `fully_autonomous` auto-approuve tout sauf catastrophique | [D] `[runner] cron ticker started (120s interval)` — actif par défaut |

## Phase 11 — Performance & UX

| ID | Contrôle | Statut | V1 | V2 |
|---|---|---|---|---|
| PERF-01 | Temps de démarrage ventilé | PARTIAL | [B] boot complet observé en ~45 s (PG + migrations + seed 20 skills + runner + web) | ventilation par étape non mesurée |
| PERF-02 | Durée des migrations à l'échelle | BLOCKED | — | Base vide |
| PERF-03 | Bundle `apps/web` | BLOCKED | — | Non mesuré |
| PERF-04 | Rendu sur gros historique | BLOCKED | — | Base vide |
| PERF-05 | Mises à jour temps réel | BLOCKED | — | Non instruit |
| PERF-06 | Index sur les chemins chauds | PARTIAL | [A] index présents dans les migrations (0070 notamment) | non mesuré sous charge |
| PERF-07 | Fuites sur session longue | BLOCKED | — | Non instruit |
| PERF-08 | Croissance disque à un an | BLOCKED | — | Non modélisé. `RETENTION_DAYS` défaut **0 = jamais de purge** (`env.ts:147`) |
| UX-01 | Accessibilité WCAG 2.1 AA | BLOCKED | — | Dashboard non atteint (onboarding) |
| UX-02 | Surfaces d'erreur | **COVERED** | [A] `server.ts:194-198` : nom de classe seulement | [B] crash du dashboard : message clair dans `web.log`, mais **rien côté utilisateur** — le CLI annonce le démarrage sans vérifier |
| UX-03 | Playwright : ce qu'ils couvrent, s'ils passent | **COVERED** | [A] `ci.yml` : aucune étape Playwright | [B] 85 specs comptées hors `node_modules` → **PERF-001** |

---

# Les quatre passes de clôture

## 1. Passe orphelins — fichiers du recensement qu'aucune phase n'a examinés

| Zone | LOC | Justification |
|---|---|---|
| `apps/web/src/app/**` (hors `lib/`) | ~50 000 | Non atteignable : l'onboarding bloque sans clé LLM. **`BLOCKED`, pas justifié** — c'est le plus gros angle mort de l'audit |
| `packages/adapters/{airtable,apify,gmail,google-*,notion,outlook-mail,poyo,tavily}` | ~30 000 | Chacun exige une authentification OAuth réelle. `BLOCKED` |
| `packages/delivery/src/channels/{slack,discord,whatsapp,email}` | ~4 500 | `BLOCKED` — aucun canal configuré |
| `packages/llm/src/providers/*` (11 sur 12) | ~7 000 | `BLOCKED` — aucune clé fournisseur |
| `apps/runner/src/job/execute.ts` | ~4 000 | Lu par extraits ciblés (guards, claim, approbation). Les ~3 500 lignes restantes : `BLOCKED` |
| `packages/orchestration/src/{planner,router}` | ~3 000 | `BLOCKED` — non instruits |
| `apps/docs` | 877 | `N/A` — site de documentation, hors périmètre de sécurité |
| `packages/runner-adapters` | 283 | `N/A` — couche d'adaptation fine, sans logique de sécurité |

**11 des 16 workspaces ont une couverture partielle ou nulle.** C'est la limite principale de cet audit.

## 2. Passe inconnues inconnues

*Si je voulais prendre le contrôle d'une installation Nodal-Agents et que j'avais une semaine, comment
m'y prendrais-je ?* Trois voies qu'aucune section de la grille ne couvrait :

**A. Empoisonner le catalogue de skills communautaires plutôt que l'installation.**
Le produit installe des skills depuis des dépôts externes (`/api/skills/install`, suivi de mises à
jour toutes les 24 h via l'API GitHub anonyme). Une skill est du texte injecté dans le prompt système.
Je n'attaquerais pas une installation : je publierais une skill utile, j'attendrais qu'elle se
diffuse, puis je pousserais une **mise à jour** avec la charge utile. Le mécanisme de mise à jour
existe (`skill_update_tracking`, migration 0069) et il y a un flux « three-way keep my version », donc
un chemin de mise à jour semi-automatique. **Question ouverte non instruite** : une mise à jour de
skill communautaire peut-elle s'appliquer sans revue humaine du diff ? Si oui, c'est le vecteur le
plus rentable du produit — un seul point d'attaque pour toutes les installations.

**B. Attendre la prochaine version mineure d'une dépendance.**
SUPPLY-001 démontre que l'artefact publié peut casser sans qu'aucun commit ne bouge. Le corollaire
offensif est plus intéressant que le défaut : les carets du `package.json` du pack signifient qu'un
mainteneur de n'importe laquelle des ~50 dépendances de runtime peut modifier ce qui s'exécute sur
toutes les installations futures. Aucun lockfile n'est publié, aucune vérification d'intégrité, aucun
`npm audit` en CI. Ce n'est pas hypothétique : c'est le mode de défaillance qui a déjà frappé, en
version bénigne.

**C. Le job cron `fully_autonomous`.**
Le pire assemblage possible existe et est atteignable par configuration : une routine planifiée qui
s'exécute toutes les deux minutes sans surveillance, sur un agent en autonomie maximale disposant de
`run_command`. Dans cette configuration, la seule barrière restante est `isCatastrophicCommand` — un
motif conçu pour empêcher d'effacer le disque, **pas** pour empêcher une exfiltration. Je n'aurais pas
besoin d'un exploit : il me suffirait de faire lire à cet agent un contenu que je contrôle.

**Point commun aux trois : aucun ne demande de faille de code.** Ils exploitent tous des chemins
prévus.

## 3. Passe d'autocritique — où cet audit est le plus faible

1. **34 % de couverture réelle.** 71 contrôles sur 137 sont `BLOCKED`. Un audit à un tiers de
   couverture ne peut pas conclure « le produit est sûr », et ne le fait nulle part.
2. **Aucun test d'injection n'a été exécuté de bout en bout.** Le finding central (INJECT-001) est
   établi **structurellement** — j'ai prouvé qu'aucun cadrage n'existe — mais je n'ai jamais montré
   qu'un modèle obéit effectivement à une charge utile injectée. C'est une différence réelle : la
   sévérité P1 repose sur un raisonnement, pas sur une observation.
3. **Le dashboard n'a jamais été atteint.** 64 000 lignes et 153 server actions, non audités. L'ironie
   est que c'est SUPPLY-001 qui l'a d'abord bloqué, puis l'onboarding.
4. **Onze harnais LLM sur douze sont jugés sur une seule ligne du registre.** La grille demandait neuf
   dimensions par fournisseur ; j'en ai couvert une.
5. **J'ai commis au moins une erreur de mesure** — première mesure de `buildBaselineBlock` avec des
   valeurs de `role` inexistantes dans la signature, concluant à tort que worker et orchestrateur
   payaient identiquement. Corrigée après relecture, mais elle indique que d'autres mesures faites
   au même rythme méritent d'être rejouées.
6. ~~Le tarball testé n'est pas celui du registre npm.~~ **Levé en fin d'audit** : retéléchargé
   via `npm pack nodal-agents@0.8.1`, SHA-256 identique, `dist-tags.latest = 0.8.1`. SUPPLY-001
   porte bien sur l'artefact publié.
7. **Reconnaissance par motif** : les mentions favorables sur `probe-context`, `tolerant-fetch`,
   `failover` et `retry` reposent sur leurs noms et leurs commentaires, pas sur leur lecture — c'est
   exactement ce que §3.5 interdit. Ils sont donc marqués `BLOCKED`, pas « conformes ».

## 4. Passe d'audit des preuves et des challenges

Contrôle systématique des 14 findings.

| Critère | Résultat |
|---|---|
| Deux vérifications de classes différentes | 13/14 conformes. **PRIVILEGE-003** n'a qu'une preuve `[A]` |
| Au moins une preuve B ou C là où §3.1 l'exige (SUPPLY, INJECT, PRIVILEGE, SECRET, NETWORK, TOKEN) | 8/10 conformes. **INJECT-001** et **SKILL-001** reposent sur deux preuves `[A]` |
| Challenge réel enregistré, avec issue | 14/14 |
| Deux options réellement distinctes | 14/14 |

**Déclassements appliqués à l'issue de cette passe :**

- **PRIVILEGE-003** → confiance ramenée à **`Likely`** (une seule classe de preuve).
- **INJECT-001** et **SKILL-001** → **maintenus `Confirmed` par exception motivée** : le §3.1 exige
  une preuve B/C pour les findings INJECT, et je n'en ai pas. Mais la nature de l'affirmation est
  une **absence** — « aucun cadrage n'existe » — qui se démontre par recherche exhaustive et non par
  exécution. Une preuve B montrerait qu'un modèle obéit, ce qui est une affirmation **différente**
  et plus forte que celle formulée. Cette exception est signalée ici plutôt que masquée ; un
  relecteur peut légitimement la refuser et les ramener à `Likely`.

**Findings retirés pendant la passe de challenge : 3** (blanchiment de privilège par délégation,
réutilisation d'IV, `constant-time` inutilisé) — les trois étaient des hypothèses de départ
raisonnables, réfutées par la lecture.
**Findings déclassés : 5** (SECRET-002, PRIVILEGE-003, SUPPLY-002, TOKEN-002, SKILL-002).
**Total : 8 mouvements sur 22 findings candidats.**
