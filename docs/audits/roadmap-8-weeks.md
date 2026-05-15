# Roadmap immédiate 8 semaines — NodalAI

> **Plan opérationnel court terme** consolidé depuis les audits :
> - [`hermes-total-audit.md`](./hermes-total-audit.md) — audit stratégique 22 briques + recommandation §6
> - [`hermes-memory.md`](./hermes-memory.md) — audit deep mémoire
> - [`memory-roadmap.md`](./memory-roadmap.md) — roadmap tactique mémoire 13 items
>
> Ce fichier consolide UNIQUEMENT le **chemin critique 8 semaines**. Pour la stratégie macro 6 mois (Phase 1-2-3), voir `hermes-total-audit.md` §6.

---

## Pourquoi ce plan

Après plusieurs sessions d'audit comparatif Hermes Agent ↔ NodalAI, le pivot stratégique majeur est apparu : **l'auto-injection mémoire est LE moment magique** qui convertit un design partner. Elle doit arriver tôt (semaine 4-5), pas en Phase 3. Et la sanitation anti-injection doit la précéder (semaine 2-3) car la mémoire partagée entity-wide sans filtrage = vecteur prompt-injection cross-agents.

L'ordre est dependency-correct, pas arbitraire :

```
Ship npm  →  des gens peuvent tester
   ↓
Sanitation  →  on peut shipper l'auto-injection sans risque
   ↓
Auto-injection  →  on a un "wow moment" pour la demo
   ↓
MCP + tools  →  l'agent peut faire des choses utiles
   ↓
Design partners  →  on a un produit légitime à montrer
```

Inverse l'ordre et tu casses tout.

---

## La roadmap — 8 semaines

### Semaine 1 — SHIPPING (débloquer tout le reste)
- [ ] Publier `npx nodalai` sur npm
- [ ] Discord public ouvert avec lien dans README
- [ ] Demo vidéo 60s de `npx nodalai up` postée sur Twitter/LinkedIn
- **Critère de fin** : `npmjs.com/package/nodalai` existe et `npx nodalai up` fonctionne sur une machine vierge

### Semaine 2-3 — SÉCURITÉ MÉMOIRE (Memory Sprint 1)
Cf [`memory-roadmap.md`](./memory-roadmap.md) items 1.1, 1.2, 1.3.
- [ ] **1.1** Sanitation anti-injection sur `save_memory` (3 SP) — 11 regex + Unicode block + cap length
- [ ] **1.2** Déduplication via `fact_hash` (2 SP) — sha256(normalize) + check existence
- [ ] **1.3** `query_memory` utilise vraiment `searchMemories` (3 SP) — param `query` + sort
- [ ] **Bonus en parallèle** : Cost tracking $ basique (matrix prix × usage tokens persisté en DB)
- **Critère de fin** : test d'injection rejeté, doublons rejetés, search texte fonctionnel

### Semaine 4-5 — LE MOMENT MAGIQUE (Memory Sprint 2)
Cf [`memory-roadmap.md`](./memory-roadmap.md) items 1.4, 1.5, 1.6.
- [ ] **1.5** Budget tokens dur (`memoryTokenBudget` per agent, default 1500) (2 SP)
- [ ] **1.4** Auto-injection mémoire dans `buildSystemPrompt` (5 SP) — frozen snapshot style
- [ ] **1.6** Feedback loop `mark_memory_helpful` / `mark_memory_outdated` (3 SP)
- [ ] **En parallèle** : Dashboard Cost (graphes per-agent/jour) + Pino structured logs + AsyncLocalStorage
- **Critère de fin** : demo vidéo "il s'est souvenu sans que je lui demande" prête

### Semaine 6-7 — COMPOSABILITÉ (MCP + outils essentiels)
- [ ] MCP client runtime (`@modelcontextprotocol/sdk`, lit la table `mcp_servers` existante)
- [ ] Code execution sandbox (`isolated-vm`)
- [ ] File operations tool (workspace-scoped, path traversal check)
- [ ] `web_search` réel via Tavily (le stub doit disparaître)
- [ ] `sendEmail` réel via Resend (le stub doit disparaître)
- **Critère de fin** : agent NodalAI peut faire 80 % des tâches d'un agent Hermes basique

### Semaine 8 — ONBOARDING DESIGN PARTNERS
- [ ] Slack adapter (`@slack/bolt`, signing secret, allowed_channels, approval keyboards)
- [ ] `nodalai doctor` (health checks DB/runner/web/key/ports/pgvector)
- [ ] Docker Compose officiel
- [ ] Onboarding 3 design partners (équipes 3-10 humains)
- [ ] Recueil feedback structuré
- **Critère de fin** : 3 équipes testent en conditions réelles, feedback documenté

---

## Checkpoint fin S8 — 7 cases binaires

| Critère | Mesure |
|---|---|
| Publication npx nodalai | `npmjs.com/package/nodalai` existe |
| Sanitation save_memory | test d'injection rejeté |
| Auto-injection mémoire | 2e session : agent rappelle prefs sans query manuel |
| Cost dashboard | $ par agent par jour visible |
| MCP client | au moins 1 serveur MCP officiel connecté en démo |
| Code exec + file ops | agent peut écrire un script Python et l'exécuter |
| Slack adapter | agent reçoit message Slack + répond |

**Score** : 7/7 = bon rythme · 5-6/7 = OK identifier blocage · 0-4/7 = blocage majeur à expliciter

---

## Fichiers à créer / modifier pendant les 8 semaines

### Critique
- `apps/cli/package.json` (version, bin) — semaine 1
- `packages/tools/src/builtin/save-memory.ts` — semaine 2 (sanitation)
- `packages/memory/src/crud.ts` — semaine 2 (dedup fact_hash)
- `packages/tools/src/builtin/query-memory.ts` — semaine 2 (real search via searchMemories)
- `packages/orchestration/src/system-prompt.ts` — semaine 4 (auto-injection)
- `packages/db/src/schema/agents.ts` — semaine 4 (colonne `memoryTokenBudget`)
- `packages/memory/src/inject.ts` — semaine 4 (NOUVEAU fichier)
- `apps/runner/src/job/execute.ts` — semaine 4-5 (intégration auto-injection + cost tracking)
- `apps/web/src/app/(dashboard)/stats/` ou nouveau `/cost/` — semaine 4-5 (dashboard $)
- `apps/runner/src/mcp/` — semaine 6 (NOUVEAU, MCP client)
- `packages/tools/src/builtin/code-exec.ts` — semaine 6 (NOUVEAU)
- `packages/tools/src/builtin/file-ops.ts` — semaine 6 (NOUVEAU)
- `packages/delivery/src/channels/slack.ts` — semaine 8 (NOUVEAU)
- `apps/cli/src/commands/doctor.ts` — semaine 8 (NOUVEAU)
- `docker-compose.yml` à la racine — semaine 8 (NOUVEAU)

### Fonctions/utilitaires existants à réutiliser
- `packages/memory/src/search.ts:searchMemories` — déjà fonctionnel, à brancher dans `query_memory` (S2) et auto-injection (S4)
- `packages/memory/src/access-tracking.ts:touchMemory` — déjà utilisé par search, garder
- `packages/memory/src/filter.ts:applySkillFilter` — pur, réutilisable pour auto-injection
- `packages/secrets/src/index.ts:encrypt/decrypt` — pour toute nouvelle clé/token
- `packages/llm/src/retry.ts:withRetry` — pour les nouveaux providers
- `packages/llm/src/client.ts:createLlmClient` — pour l'auxiliary client
- `packages/runner-adapters/src/registry.ts:ADAPTER_REGISTRY` — pattern à suivre pour MCP
- `apps/cli/src/lib/llm-presets.ts` — pattern preset pour MCP servers presets

---

## Verification end-to-end

### Vérifier Semaine 1 (ship npm)
```bash
# Sur une machine vierge :
npx nodalai up
# Doit ouvrir le browser sur localhost:3000
```

### Vérifier Semaine 2-3 (sécurité mémoire)
```bash
pnpm test --filter @nodalai/tools
pnpm test --filter @nodalai/memory
# Tests : injection patterns refusés, dedup rejette doublons, query texte OK
```

### Vérifier Semaine 4-5 (auto-injection)
1. Créer un agent + 3 memories importance 5 en DB
2. POST /api/agent { task: "..." }
3. Vérifier que le system prompt rendu (loggé) contient les 3 facts
4. Test E2E : ouvrir 2e session, agent doit citer un fact sans query manuel

### Vérifier Semaine 6-7 (MCP + tools)
1. Connecter au serveur MCP filesystem officiel
2. Demander à l'agent : "List files in /tmp"
3. Vérifier que le tool MCP est appelé et que le résultat revient

### Vérifier Semaine 8 (Slack + doctor + design partners)
```bash
nodalai doctor   # tous les checks verts
```
- Configurer un bot Slack dans dashboard, envoyer un message, vérifier réponse
- Onboarder 3 design partners, recueillir 3 feedbacks structurés

---

## Règles d'engagement (non-négociables pendant les 8 semaines)

1. **Pas de nouveau plan stratégique avant le 1er septembre.** Si l'envie d'écrire un autre audit/plan apparaît, c'est un signal de procrastination, exécuter, pas planifier.
2. **Pas de pivot avant le checkpoint S8.** Si pivot en S4, tout le travail S1-S3 perd sa valeur.
3. **Un ship public chaque semaine** (commit GitHub + post Discord). Le repo doit vivre.
4. **Refuser les bonnes idées hors-scope.** "Et si on ajoutait X aussi" -> backlog post-S8.
5. **Ordre dependency-correct verrouillé** : Ship -> Sanitation -> Auto-injection -> MCP -> Design partners. Ne pas inverser.

---

## Anti-objectifs

- NON Reproduire les 24 plateformes messaging d'un agent OSS existant (Slack + Discord en S8 suffit)
- NON Reproduire 28 LLM providers (8 actuels via Vercel AI SDK suffisent)
- NON Reproduire 7 terminal backends (local + Docker exec optional = OK)
- NON Implémenter Atropos RL (hors-périmètre produit)
- NON Migrer vers Python (destruction de l'avantage architectural)
- NON Sortir une TUI Ink replica
- NON Multi-profile filesystem (entity_id intra-DB strictement supérieur)
- NON Kanban durable v1 day one (effort élevé, ROI faible avant 10+ users)
- NON Provider plugin system mémoire (skip jusqu'à demand signal explicite)