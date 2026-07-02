# Plan d'audit — Nodal-Agents (à destination de Fable 5)

> **But de ce document** : donner à l'auditeur une **carte logique complète** de la plateforme + un **ordre d'attaque** + la liste des **zones critiques/sensibles**, pour sonder le code de façon systématique plutôt qu'au hasard. Chaque section indique : *rôle · fichiers-clés · ce qu'il faut vérifier · criticité*.

---

## 0. Contexte plateforme

Nodal-Agents = monorepo **all-Node** (pnpm workspaces + Turborepo, TypeScript strict, Drizzle ORM, Zod, Vercel AI SDK multi-provider, Hono pour le runner, Next.js + better-auth pour le dashboard). C'est une **plateforme d'agents** : des agents configurés en DB exécutent des tâches via un LLM, avec outils (builtins + connecteurs + MCP), délégation multi-agents, skills installables, mémoire persistante, approbations et autonomie graduée, livraison multi-canal (Telegram/chat/API/cron).

**Invariants NON négociables (source : `CLAUDE.md`) — c'est la grille de lecture de tout l'audit :**
1. Aucune métadonnée d'agent hardcodée (skills, routing, sous-agents, team-block = 100 % DB).
2. Aucun texte user-facing hardcodé dans le runner (le LLM parle, ou le runner se tait).
3. Aucun band-aid spécifique-agent dans le runner (corriger au niveau agent/DB).
4. Aucun fallback « smart » silencieux (échouer bruyamment).
5. Les tests assertent le **résultat réel** (corps de requête LLM, ligne DB, contenu de tool_result), jamais des call counts.
6. Aucune valeur per-user hardcodée (IDs/URLs/tokens via mémoire ou config).
7. Toujours les SDK officiels.
8. Garde-fous anti-boucle (max 5 chaînes, 50 tool calls/tour, profondeur délégation 3).
9. Whitelist d'outils explicite par agent (aucun défaut).
10. Aucun dialogue natif navigateur (ConfirmDialog + toaster Sonner).

**Question transverse n°1 de l'audit : chaque invariant est-il réellement respecté ET réellement enforced (CI/lint/dep-cruiser) ? Où sont les contournements ?**

---

## 1. Méthodologie d'audit recommandée (ordre)

1. **Socle** : lire `CLAUDE.md` + les enforcers (`.dependency-cruiser.cjs`, `eslint.config.js`, `.github/workflows/ci.yml`). Établir la grille invariants.
2. **Modèle de données** : comprendre les tables et le scoping multi-tenant AVANT le runtime (tout en dépend).
3. **Tracer un job de bout en bout** : `routes/agent.ts` → `job/execute.ts` → outils → délégation → livraison. C'est le chemin chaud.
4. **Sonder chaque sous-système** (sections A→N ci-dessous) contre les invariants + les préoccupations transverses (§3).
5. **Zones sensibles en priorité max** (§4) : sécurité, isolation multi-tenant, exécution d'outils, approbations, secrets.
6. **Qualité des tests** : les tests prouvent-ils un résultat réel (invariant #5) ou juste des call counts ?

---

## 2. Décomposition logique de la plateforme

### A. Contrats & invariants — le socle · **CRITIQUE**
- **Rôle** : règles d'architecture censées être garanties par la CI.
- **Fichiers** : `CLAUDE.md`, `.dependency-cruiser.cjs`, `eslint.config.js`, `.github/workflows/ci.yml`, `apps/web/eslint.config.mjs` (règle `no-restricted-globals` pour dialogues natifs).
- **Vérifier** : chaque invariant a-t-il un enforcer ? Les règles dep-cruiser empêchent-elles réellement `pg`/`postgres`/`drizzle-orm` hors de `packages/db` ? Y a-t-il des `// eslint-disable` ou `@ts-ignore` non justifiés ? Des invariants « déclarés mais non testés » ?

### B. Modèle de données & isolation multi-tenant (`packages/db`) — **CRITIQUE (intégrité + fuite inter-tenant)**
- **Rôle** : Drizzle, 22 fichiers de schéma, **53 migrations**. Entité = tenant.
- **Fichiers** : `packages/db/src/schema/*` (entities, agents, jobs, tasks, memory, skills, connectors, credentials, llm_keys, approvals, chat-messages, webhooks, users, auth, mcp, agent-workspaces, agent-connector-assignments, schedules, tool_calls, app-settings, misc, enums) ; `migrations/` + `migrations/meta/_journal.json` ; `packages/db/src/tests/helpers.ts`.
- **Vérifier** :
  - **Scoping `entityId` sur CHAQUE requête** (lecture ET écriture). Une requête sans filtre entité = fuite inter-tenant → c'est LE risque n°1.
  - Intégrité des migrations (journal cohérent, ordre, colonnes générées `search_tsv`, GIN, `pgvector`→texte fallback).
  - Cascades `onDelete`, FKs, contraintes CHECK (importance 1-5, source, category).
  - Le helper de test recrée-t-il fidèlement le schéma réel (drift possible) ?

### C. Cœur d'exécution runtime (`apps/runner/src/job`) — **LE PLUS CRITIQUE**
- **Rôle** : la boucle LLM ↔ outils, le cycle de vie d'un job.
- **Fichiers** : `execute.ts` (énorme, ~3000+ lignes : boucle de tours, exécution d'outils, compaction de contexte, comptage coût/tokens, capture de résultat, livraison, garde-fous), `chain.ts`, `state.ts`, `thread-history.ts` (reset d'inactivité, budget), `resolve-llm.ts`, `transcript-text.ts`, `deployment.ts`.
- **Vérifier** :
  - Boucle de tours : appariement `tool_use` ↔ `tool_result` (pas d'`unmatched_tool_use`), pas de double `return_result`.
  - **Garde-fous anti-boucle** (invariant #8) réellement appliqués (max chaînes/tools/profondeur) — détection de non-progrès.
  - **Compaction de contexte** : éviction des vieux tool-results avant overflow (seuil, N derniers gardés) — cf. jobs à 130-150K tokens.
  - **Honnêteté fail/block** : jamais de faux `completed` ; `result` rempli sur tout échec ; raison propagée en délégation.
  - Round-trip du raisonnement (modèles à reasoning) : correct mais **duplique le reasoning** dans le message persisté (`providerMetadata` + `providerOptions` + `text`) → gonfle contexte/tokens rejoués (déjà repéré, à évaluer).
  - Comptage coût/tokens (OpenRouter `usage.cost`, coercition NaN).

### D. Orchestration & délégation (`packages/orchestration`) — **CRITIQUE**
- **Rôle** : assemblage du system prompt, délégation, planification.
- **Fichiers** : `system-prompt.ts` (assemblage des blocs), `team-block.ts` (liste des sous-agents, 100 % DB), `agent-baseline.ts` (couches baseline/channel/discoverability), `planner/`, `router/`, `orchestrator-mode.ts`, `chain-counters.ts`, `errors.ts`.
- **Vérifier** :
  - **Invariant #1** : team-block/skills/sous-agents 100 % dérivés de la DB, zéro hardcode.
  - Délégation : `assign_<slug>` vs `create_task` fan-out, profondeur, task board détaché vs inline, finalisation (pas de re-run infini).
  - **Poids du system prompt** : baseline ~13K chars injecté à CHAQUE agent + team-block + bloc canal ; sur un fan-out, coût multiplié par N enfants (déjà mesuré : job orchestrateur ≈ 34K chars de system prompt). Y a-t-il un moyen de réduire le plancher pour tâches triviales ?
  - Planner : cycle par-job, garde reaper parent-en-attente.

### E. Abstraction LLM multi-provider (`packages/llm`) — **CRITIQUE (fiabilité + coût)**
- **Rôle** : client unifié, failover, retry, providers natifs.
- **Fichiers** : `client.ts`, `failover.ts`, `retry.ts`, `message-structure.ts`, `tool-choice-floor.ts`, `errors.ts`, `embeddings.ts`, `providers/`.
- **Vérifier** :
  - Failover multi-provider (sticky après bascule, ordre, `AllProvidersFailedError`).
  - Retry-hardening (heuristiques réseau, pas de tempête de retry, timeout/watchdog stale-stream).
  - `message-structure.ts` : validité de structure (Anthropic/OpenAI), reasoning round-trip, `tool-choice-floor`.
  - Classification d'erreurs (`describeLlmError`) — pas d'erreur opaque (invariant #4).
  - Extraction coût par provider ; embeddings (opt-in, dégradation en keyword).

### F. Outils & sécurité d'exécution (`packages/tools`) — **CRITIQUE (surface d'exécution du code)**
- **Rôle** : builtins exposés aux agents.
- **Fichiers** : `builtin/` — `run-command.ts`, `run-skill-script.ts`, `file-ops/`, `meta-ops/` (create_skill/create_agent/attach_*), `skill-ops/`, `office-ops/`, `web-search.ts`, `save-memory.ts`, `query-memory.ts`, `search-history.ts`, `dashboard-publish.ts`, `return-result.ts`, `index.ts` (`ALWAYS_ON_TOOL_DOCS`).
- **Vérifier** :
  - **Whitelist par agent (invariant #9)** : calculée depuis la DB, aucun défaut ; un outil non-whitelisté est-il vraiment inexécutable ?
  - `run_command` : gating skill `command-execution` + approbation safe-by-default + master-switch runtime LAN Yolo (le web ne gatait que la création de règle, pas l'exécution — vérifier que le runtime override).
  - **Sandboxing des chemins** (`file-ops`, workspace-scoped `resolveAndCheckPath`) : traversal, écriture hors workspace.
  - Install de skills communautaires : **zip-slip guard, magic-byte sniff, allowlist anti-SSRF** (le runner n'exécute JAMAIS les scripts).
  - Meta-tools ROOT : gatés par `entities.rootGrants` + niveau d'autonomie.

### G. Skills, catalogue & boucle d'apprentissage (`packages/catalog`, `apps/runner/src/skills`, `apps/runner/src/reflection`) — **SENSIBLE**
- **Rôle** : skills baseline/channel/capability, install communautaire, learning loop.
- **Fichiers** : `packages/catalog/src/skills/*`, `apps/runner/src/skills/*`, `apps/runner/src/reflection/*` (reflection Tier-1, curator Tier-2, `run-memory-curator.ts`).
- **Vérifier** :
  - Provenance gating (`created_by='agent'` sandboxé), anti-sur-génération (la reflection a déjà sur-généré 15 skills en 2j).
  - Curator : dedup, gating par-entité (`reflection_enabled`) vs le nouveau `memory_curation_enabled` (découplé, ON par défaut).
  - Sécurité de fetch (GitHub tar.gz / ClawHub zip, normalisation, allowlist).

### H. Approbations & autonomie (`apps/runner/src/approvals`, `entities.rootGrants`) — **CRITIQUE (contrôle utilisateur)**
- **Rôle** : gates d'approbation suspend/resume, niveaux d'autonomie, désignation ROOT.
- **Fichiers** : `apps/runner/src/approvals/{resolve.ts,notify.ts}`, `schema/approvals.ts`, `schema/entities.ts` (rootGrants, autonomie, lanCommandYolo), `routes/approve.ts`.
- **Vérifier** :
  - Un agent peut-il **contourner** un gate d'approbation ? Le resume **exécute-t-il fidèlement l'action approuvée** (bug historique : le resume n'exécutait pas vraiment) ?
  - Niveaux `fully_autonomous` / `destructive_gate` / propose-confirm : sémantique réelle vs déclarée.
  - Master-switch LAN Yolo : le runtime override-t-il bien les règles `auto_approve` si le workspace n'a pas opt-in ?

### I. Secrets & authentification (`packages/secrets`, `packages/auth`) — **CRITIQUE (sécurité)**
- **Rôle** : chiffrement des credentials, auth dashboard.
- **Fichiers** : `packages/secrets/src/*` (clé `~/.nodalai/secrets.key`, chiffrement), `packages/auth/src/*` (better-auth, providers, helpers), `schema/credentials.ts`, `schema/llm_keys.ts`, `schema/auth.ts`.
- **Vérifier** :
  - Stockage/chiffrement des secrets, rotation, refresh OAuth (Google) — pas de fuite en clair.
  - **Aucun secret dans les logs / transcripts / mémoire** (fuite PII/token).
  - Modes auth : local (no-auth) vs local-auth vs LAN ; `WORKER_SECRET` sur LAN (route worker) ; scoping de session.
  - `AUTH_MODE` proxy (régression connue : throw sur chemins cron sans runnerEnv).

### J. Intégrations externes (`packages/adapters`, `packages/runner-adapters`) — **SENSIBLE**
- **Rôle** : connecteurs tiers + MCP.
- **Fichiers** : `packages/adapters/{gmail,google-calendar,google-docs,google-drive,google-sheets,notion,airtable,apify,firecrawl,tavily,poyo,mcp}`, `packages/runner-adapters/src/{registry.ts,index.ts}`.
- **Vérifier** :
  - SDK officiels (invariant #7).
  - **MCP** : gestion du `structuredContent` (2ᵉ canal de payload — un oubli a déjà fait brûler 2,4M tokens sur du faux-vide) ; `CallToolResult`.
  - Auth des connecteurs, gestion d'erreur/rate-limit, discipline stop-sur-vide.

### K. Livraison & canaux (`packages/delivery`, `apps/runner/src/telegram`, `apps/runner/src/chat`) — **SENSIBLE**
- **Rôle** : livraison channel-aware, Telegram, chat dashboard.
- **Fichiers** : `packages/delivery/src/*`, `apps/runner/src/telegram/{poller.ts,manager.ts,...}`, `apps/runner/src/chat/*`, `schema/chat-messages.ts`.
- **Vérifier** :
  - **Contrat de livraison** : anti-spam, no-silent-drop, gating sur destinataire résoluble (`job.chatId`) → pas de Telegram fantôme sur jobs api/cron/internal.
  - Split de messages Telegram (4096), images entrantes (workspace partagé).
  - **Couplage Telegram** : le code est ~80 % telegram-hardcodé — évaluer la dette avant le multi-canal (Discord/Slack).

### L. Surfaces API & Web (`apps/runner/src/routes`, `apps/web`) — **SENSIBLE**
- **Rôle** : API Hono du runner + dashboard Next.
- **Fichiers** : `apps/runner/src/routes/{agent,worker,chat,cron,approve,skills,health}.ts`, `apps/runner/src/server.ts` ; `apps/web/src/lib/actions.ts` (server actions, gros fichier), `apps/web/src/app/**`.
- **Vérifier** :
  - Authz/validation de chaque route (Zod aux frontières), `WORKER_SECRET` sur `/api/worker`.
  - **Server actions** : chaque action est-elle scopée à `session.entityId` ? (fuite inter-tenant possible ici aussi).
  - Aucun dialogue natif (invariant #10), validation d'input, gestion d'erreur user-facing.

### M. Cron & scheduling (`apps/runner/src/cron`, `schema/schedules.ts`) — **SENSIBLE**
- **Rôle** : ticks cron, curator/reflection, rétention.
- **Fichiers** : `apps/runner/src/cron/{run-curator.ts,...}`, `schema/schedules.ts`, `schema/webhooks.ts`, `routes/cron.ts`.
- **Vérifier** :
  - Fiabilité cron → orchestrateur → fan-out N agents → résumé (chemin fragile historiquement : task board détaché, deliverCompletedRoots qui n'envoyait pas).
  - Timezone, gating curator, le proxy env qui throw sur chemins cron, rétention (`RETENTION_DAYS` off par défaut).

### N. CLI & cycle de vie opérationnel (`apps/cli`) — **SENSIBLE (opérationnel)**
- **Rôle** : `up/down/init/reset/update/logs`, Postgres embarqué, pack.
- **Fichiers** : `apps/cli/src/commands/*`, `apps/cli/src/lib/{postgres.ts,config.ts,ports.ts,seed.ts,env.ts}`, `scripts/{build-pack.mjs,verify-install.mjs,refresh-model-vision.mjs}`.
- **Vérifier** :
  - Boot : Postgres embarqué (data dir **partagé fixe** `~/.nodalai/pg-data` → une seule instance), migrations appliquées, seed, orphan cleanup, findFreePort.
  - Intégrité du pack publié (bundledDependencies, `verify-install`), version single-source (`apps/cli/package.json`).
  - Le check de version au boot (bug cosmétique connu : « vX available » sans vrai semver-gt).

---

## 3. Préoccupations transverses (à traquer dans CHAQUE section)

1. **Isolation multi-tenant** : `entityId` sur toute requête DB et toute server action. *Priorité sécurité n°1.*
2. **Fail-loud (invariant #4)** : aucun catch qui avale, aucun fallback silencieux, aucune garde conditionnelle no-op.
3. **Honnêteté de résultat** : jamais de faux `completed` ; toute erreur remplit `result`/`error` et remonte à l'utilisateur.
4. **Coût & fenêtre de contexte** : comptage tokens/coût fiable, compaction avant overflow, plancher de prompt raisonnable.
5. **Garde-fous ressources** : anti-boucle (chaînes/tools/profondeur), budget-tokens/job, détection non-progrès.
6. **Fuite de secrets/PII** : jamais dans logs/transcripts/mémoire injectée.
7. **Qualité des tests (invariant #5)** : assertions sur résultat réel, pas call counts ; tests en isolation (pas juste en parallèle) ; régression écrite avant le port.
8. **Zéro hardcode** : métadonnées d'agent (invariant #1) et valeurs per-user (invariant #6) 100 % DB/config.

---

## 4. Zones les plus sensibles — priorité MAX pour l'auditeur

Par ordre de risque × impact :

1. **`apps/runner/src/job/execute.ts`** — cœur runtime ; bugs de boucle, garde-fous, honnêteté fail/block, coût. Le fichier le plus dense et le plus critique.
2. **Isolation multi-tenant** — scoping `entityId` transversal (db queries + `apps/web/src/lib/actions.ts` + routes). Une seule requête non-scopée = fuite.
3. **Surface d'exécution de code** — `run-command`, `run-skill-script`, `file-ops` (sandbox chemins), install de skills communautaires (SSRF/zip-slip).
4. **Approbations & autonomie** — contournement de gate, fidélité du resume, master-switch LAN Yolo.
5. **Secrets & auth** — chiffrement, refresh OAuth, `WORKER_SECRET` LAN, fuite dans logs/transcripts.
6. **LLM : failover / reasoning / coût** — bascule correcte, structure de message, comptage coût, retry storms.
7. **MCP `structuredContent`** — payload structuré ignoré = faux-vide + brûlage de tokens.

---

## 5. Livrables attendus de l'auditeur

Pour chaque finding : **fichier:ligne**, description du défaut, **scénario de reproduction concret** (inputs → mauvais output/crash), invariant violé le cas échéant, et **verdict** (confirmé/reproductible vs plausible). Classer par sévérité. Distinguer bug de correctness, faille de sécurité, violation d'invariant, dette/perf.

---

*Carte établie le 2026-07-02 à partir de la structure réelle du repo (12 packages, 4 apps, 22 tables, 53 migrations). Les mentions d'incidents historiques viennent du contexte projet — l'auditeur doit les re-vérifier contre le code courant, pas les prendre pour argent comptant.*
