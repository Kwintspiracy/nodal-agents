# Memory Roadmap — NodalAI

> **Source** : audit deep `hermes-memory.md` (2026-05-13) + audit global `hermes-total-audit.md` §13.
> **Status** : tactical plan — 13 items priorisés P1-P4, dépendances explicites, sprint plan sur 6 semaines.

---

## TL;DR

NodalAI a une fondation mémoire DB-first **rigoureuse mais passive** : Postgres + pgvector, 2 tools (`save_memory` / `query_memory`), 0 auto-injection, 0 sanitation, 3 colonnes mortes (`fact_hash`, `valid_from/to`, `memory_layer`).

> *"Une mémoire qui n'est jamais lue est inutile. L'agent doit appeler `query_memory` au début de chaque tour, il oubliera."*

**Bonne nouvelle** : 80 % de l'écart d'efficacité opérationnelle avec Hermes peut être fermé en **moins de 2 semaines** via 3 patterns simples — auto-injection budgétée, sanitation, déduplication.

**3 sprints sur 6 semaines** suffisent à passer d'une mémoire CRUD à une mémoire **active, sûre, et qui se densifie toute seule**.

---

## Diagnostic court

### Ce que NodalAI fait déjà bien ✅
- Postgres + pgvector embedding 1536d
- Hybrid search : cosine ≥0.5 + ILIKE fallback
- Multi-tenant `entity_id` enforced en DB (FK cascade)
- Importance scoring (1-5), category enum, skill_tags[], archived flag
- Access tracking automatique (`last_accessed_at`, `access_count`)
- Audit trail (`source`, `agent_id`, timestamps)
- Dashboard Next.js (list/filter/archive/restore)
- Schema rigoureux (Zod + Drizzle + CHECK)

### Ce qui manque structurellement ❌
- **Auto-injection** dans le system prompt (la mémoire est passive)
- **Budget tokens** sur ce qui rentre dans le prompt
- **Sanitation** anti-prompt-injection (vecteur d'attaque entity-wide)
- **Déduplication** via `fact_hash` (colonne+index existent, jamais utilisés)
- **Real search** : `query_memory` n'utilise pas `searchMemories` (gâchis pgvector)
- **Extraction post-session** (dépend uniquement de la discipline du LLM)
- **Prefetch async** (chaque query = round-trip DB synchrone)
- **Gestion temporelle** (`valid_to` / TTL — colonnes mortes)
- **Hooks lifecycle** (impossible d'attacher des effects sans patcher le runner)
- **Feedback loop** (l'agent ne peut pas marquer un fact obsolète)
- **Détection contradictions**

### Dette technique nette (3 colonnes mortes)
| Colonne | Statut |
|---|---|
| `fact_hash` | Existe + index existe, **jamais calculée** |
| `valid_from` / `valid_to` | Existent avec default, **jamais lues ni écrites** |
| `memory_layer` | Existe, **jamais peuplée** |

→ Décision à prendre : activer ou supprimer. Le faire vite avant qu'une migration future les fige.

---

## Les 13 items priorisés

Légende effort en story-points (1 SP ≈ 0,5 j-h). Total = **78 SP ≈ 40 j-h**.

### P1 — Sprint 1 (1 semaine, gains immédiats critiques)

#### 1.1 — Sanitation anti-injection sur `save_memory`
- **Effort** : 3 SP
- **Fichier** : `packages/tools/src/builtin/save-memory.ts`
- **Quoi** : porter 11 regex patterns de Hermes (`tools/memory_tool.py:_scan_memory_content`) + blocage Unicode invisible (U+200B, U+202E, BOM…) + cap `fact.length > 5000`
- **Pourquoi** : la mémoire est **partagée entity-wide** → un agent compromis empoisonne tous les autres agents de l'équipe. Trou sécurité critique.
- **Dépendances** : aucune
- **Acceptance** : test qui injecte "ignore previous instructions" → rejet avec `MemorySanitationError`

#### 1.2 — Déduplication via `fact_hash`
- **Effort** : 2 SP
- **Fichiers** : `packages/memory/src/crud.ts` (calcul) + `packages/db/migrations/` (constraint si pas déjà)
- **Quoi** : `fact_hash = sha256(normalize(fact))` où `normalize = lowercase + strip + collapse whitespace`. À l'insertion : check existence pour `entity_id + fact_hash + archived=false` → throw `MemoryDuplicateError` si match
- **Pourquoi** : empêche pollution par boucle. Colonne et index **déjà en DB** — c'est gratuit.
- **Dépendances** : aucune
- **Acceptance** : insérer "user is Quentin" 2× → 2e jet rejeté

#### 1.3 — `query_memory` utilise vraiment `searchMemories`
- **Effort** : 3 SP
- **Fichier** : `packages/tools/src/builtin/query-memory.ts`
- **Quoi** : ajouter `query?: string` à `QueryMemoryInputSchema`. Si fourni → route vers `searchMemories` (embedding+cosine ou ILIKE fallback). Sinon → comportement actuel. Ajouter `sort?: 'relevance' | 'importance' | 'recent'`
- **Pourquoi** : `searchMemories` premium dort. L'agent ne peut pas demander "qu'est-ce que je sais sur X ?" — il télécharge 200 lignes et filtre côté LLM (gaspillage tokens)
- **Dépendances** : aucune
- **Acceptance** : `query_memory({ query: "typescript", limit: 5 })` retourne les 5 plus pertinents par cosine

---

### P1 — Sprint 2 (2 semaines, cœur du système — la transformation)

#### 1.4 — Auto-injection mémoire dans `buildSystemPrompt`
- **Effort** : 5 SP
- **Fichier** : `packages/orchestration/src/system-prompt.ts` + nouveau helper `packages/memory/src/inject.ts`
- **Quoi** : étendre `buildSystemPrompt` pour appeler un nouveau `selectMemoriesForInjection(entityId, agentId, db, budgetTokens)`. Insertion d'un bloc :
  ```
  ## Persistent memory (your durable knowledge — auto-loaded, do NOT re-query for these)
  [N items, sorted by importance × recency]
  - (preference, 5★) user prefers TypeScript strict, no any
  - (context, 4★) project NodalAI uses pnpm workspaces + Turborepo
  ```
- **Heuristique sélection** : top N par `importance DESC, last_accessed_at DESC`, filtré par `skill_tags ∩ agentSkillAssignments`
- **Pourquoi** : **transforme NodalAI** d'une mémoire passive en mémoire active. Le LLM voit la mémoire pertinente automatiquement, sans tool call. Gain de tour, gain latence, gain signal.
- **Dépendances** : 1.5 (budget)
- **Acceptance** : créer un agent + 3 memories importance 5 → `executeJob` → vérifier que le system prompt contient les 3 facts

#### 1.5 — Budget tokens dur sur l'injection mémoire
- **Effort** : 2 SP
- **Fichiers** : `packages/db/src/schema/agents.ts` (nouvelle colonne `memoryTokenBudget int default 1500`) + `packages/memory/src/inject.ts`
- **Quoi** : config par agent, helper `selectMemoriesUnderBudget(memories, maxChars)` qui tronque les moins importants quand on dépasse. Estimation tokens via `length / 4`.
- **Pourquoi** : sans budget, 1.4 devient un footgun. Hermes plafonne à 800+500 tokens — on vise 1 500 default.
- **Dépendances** : aucune, mais doit être livré **avec** 1.4
- **Acceptance** : 20 memories de 200 chars chacune, budget 1500 → seules ~7 injectées

#### 1.6 — Feedback loop : `mark_memory_helpful` + `mark_memory_outdated`
- **Effort** : 3 SP
- **Fichier** : `packages/tools/src/builtin/` (2 nouveaux tools)
- **Quoi** : deux tools légers exposés au LLM. `mark_helpful({ memoryId })` → `importance = min(5, importance+1)`. `mark_outdated({ memoryId })` → `archived=true` + `valid_to=now()`.
- **Pourquoi** : self-tuning. La mémoire se nettoie toute seule au fil du temps. Sans ça, les facts dépassés persistent éternellement.
- **Dépendances** : 1.4 (sans auto-injection, l'agent ne *voit* pas les facts donc ne peut pas les marquer)
- **Acceptance** : agent appelle `mark_outdated(id)` → `archived=true` en DB, fact disparaît des prochains `query_memory`

---

### P2 — Sprint 3 (3 semaines, intelligence émergente)

#### 2.1 — Extraction automatique post-job
- **Effort** : 8 SP
- **Fichier** : `apps/runner/src/job/execute.ts` + nouveau `packages/memory/src/extract.ts`
- **Quoi** : avant `completeJob`, appel LLM auxiliaire (Haiku — cheap) avec les `messages` du job + prompt système : *"Extract 0-5 durable facts in JSON {fact, category, importance, skill_tags}. Skip task-specific outcomes."*. Insérer le résultat via `createMemory` avec `source='reflection'`.
- **Garde-fous** :
  - Skip si `status != 'completed'`
  - Skip si `messages.length < 3`
  - Skip si entity a `extraction_enabled = false`
- **Coût** : ~1 appel Haiku par job (~$0.0001). Largement rentable.
- **Pourquoi** : aujourd'hui tout dépend du LLM principal qui appelle `save_memory` au bon moment — il oubliera systématiquement. Mem0 server-side fait ça, OpenViking à `session commit` aussi.
- **Dépendances** : 1.1 (sanitation appliquée à toutes les `createMemory` y compris source='reflection')
- **Acceptance** : job qui apprend "user prefers dark mode" → après completion, fact présent en DB avec `source='reflection'`

#### 2.2 — Prefetch asynchrone
- **Effort** : 5 SP
- **Fichier** : `apps/runner/src/job/execute.ts`
- **Quoi** : au début de `executeJob`, lancer `searchMemories(job.task)` non-bloquant (Promise sans await). Au tour suivant, await le résultat et merger avec l'auto-injection. Pattern Hermes `queue_prefetch_all`.
- **Pourquoi** : élimine la round-trip DB synchrone (~50ms × N tours = jusqu'à 500ms gagnés). Surtout utile pour les LLMs lents (Opus, o3).
- **Alternative simple** : un seul prefetch initial sur `job.task` injecté dans le system prompt — recoupe avec 1.4.
- **Dépendances** : 1.4 (mécanisme d'injection)
- **Acceptance** : trace OTel montre `searchMemories` qui démarre avant le premier `generateText`

#### 2.3 — Colonnes temporelles actives
- **Effort** : 5 SP
- **Fichiers** : `packages/memory/src/{crud,search,list}.ts` + nouveau tool `invalidate_memory`
- **Quoi** :
  - `valid_to` set automatiquement quand `update_memory({invalidate: true})`
  - `searchMemories` / `listMemories` excluent par défaut `valid_to < now()` (paramètre `includeExpired?: boolean`)
  - Tool `invalidate_memory({ memoryId, reason })` exposé au LLM
- **Pourquoi** : "User uses PostgreSQL 14" devient faux après migration. Aujourd'hui rien ne purge.
- **Dépendances** : 1.4 (agent doit voir les facts pour décider qu'ils sont obsolètes — recouvre 1.6 mais à un grain plus fin avec raison)
- **Acceptance** : `invalidate_memory(id)` → `valid_to = now()`, fact n'apparaît plus dans search

---

### P3 — Backlog (à priorisier ad hoc)

#### 3.1 — Hook `on_pre_compress`
- **Effort** : 5 SP
- **Dépend de** : système de compression de messages (n'existe pas encore)
- **Quoi** : quand on compactera `agent_jobs.messages` pour les long jobs, hook qui extrait des facts avant le discard
- **Note** : pas pertinent tant que les jobs plafonnent à ~50 tool calls

#### 3.2 — Détection de contradictions
- **Effort** : 8 SP
- **Quoi** : à chaque `save_memory`, `searchMemories(fact)` ; si match > 0.9 cosine + contradicte (heuristique LLM ou embedding-based) → flag review
- **Note** : effort élevé pour un détecteur fiable. Peut être un tool opt-in `check_contradiction` plutôt qu'automatique

#### 3.3 — Trajectory compression au niveau jobs
- **Effort** : 13 SP
- **Dépend de** : jobs longs en pratique
- **Quoi** : équivalent du `trajectory_compressor.py` Hermes sur `agent_jobs.messages` — protège system + first user + last N tours, compresse le milieu via Haiku

---

### P4 — Hors-scope (à NE PAS faire avant signal demand)

#### 4.1 — Provider plugin system (`MemoryProvider` ABC)
- **Effort** : 21 SP
- **Recommandation** : **skip pour l'instant**. La force de NodalAI est la consolidation Postgres ; la fragmenter prématurément multiplie la surface d'API sans bénéfice produit clair. Hermes a 8 plugins parce qu'historiquement les utilisateurs voulaient Honcho XOR Mem0 XOR Hindsight — pas notre contexte.

---

## Graphe de dépendances

```
                  ┌─────────────────────────────────────┐
                  │   1.1 Sanitation anti-injection     │ ◄── SPRINT 1
                  │   (3 SP, 0 deps)                    │
                  └─────────────────────────────────────┘
                                  │
                  ┌───────────────┴─────────────────────┐
                  ▼                                     ▼
       ┌─────────────────────┐               ┌─────────────────────┐
       │ 1.2 Dedup fact_hash │               │ 1.3 query_memory    │
       │ (2 SP, 0 deps)      │               │ utilise search      │
       └─────────────────────┘               │ (3 SP, 0 deps)      │
                                             └─────────────────────┘

                  ┌─────────────────────────────────────┐
                  │   1.5 Budget tokens injection       │ ◄── SPRINT 2
                  │   (2 SP, 0 deps)                    │
                  └─────────────────────────────────────┘
                                  │
                                  ▼
                  ┌─────────────────────────────────────┐
                  │   1.4 Auto-injection system prompt  │
                  │   (5 SP, deps: 1.5)                 │
                  └─────────────────────────────────────┘
                                  │
                                  ▼
                  ┌─────────────────────────────────────┐
                  │   1.6 Feedback loop (helpful/old)   │
                  │   (3 SP, deps: 1.4)                 │
                  └─────────────────────────────────────┘

                  ┌─────────────────────────────────────┐
                  │   2.1 Extraction post-job           │ ◄── SPRINT 3
                  │   (8 SP, deps: 1.1)                 │
                  └─────────────────────────────────────┘

                  ┌─────────────────────────────────────┐
                  │   2.2 Prefetch async                │
                  │   (5 SP, deps: 1.4)                 │
                  └─────────────────────────────────────┘

                  ┌─────────────────────────────────────┐
                  │   2.3 Colonnes temporelles actives  │
                  │   (5 SP, deps: 1.4)                 │
                  └─────────────────────────────────────┘
```

---

## Sprint plan détaillé

### Sprint 1 — Quick wins critiques (1 semaine · 8 SP · ~4 j-h)

| Jour | Item | Output |
|---|---|---|
| Jour 1 | 1.1 Sanitation save_memory | `MemorySanitationError` + 11 regex + Unicode block + tests |
| Jour 2 | 1.2 Dedup fact_hash | normalize + hash + check + `MemoryDuplicateError` + tests |
| Jour 3 | 1.3 query_memory real search | `query` param + route vers searchMemories + sort + tests |
| Jour 4 | Tests d'intégration + dashboard surface (montrer dédup count, sanitation logs) | Polish |

**Livrable** : NodalAI sûre, sans pollution, avec un vrai search. Pas de wow-effect produit encore, mais 100 % des trous sécurité comblés.

### Sprint 2 — Transformation cœur (2 semaines · 10 SP · ~5 j-h)

| Semaine | Item | Output |
|---|---|---|
| Sem 1, J1-2 | 1.5 Budget tokens | colonne `memoryTokenBudget` + helper `selectMemoriesUnderBudget` |
| Sem 1, J3-5 | 1.4 Auto-injection | `selectMemoriesForInjection` + intégration `buildSystemPrompt` + heuristique top-N skill-aware |
| Sem 2, J1-2 | 1.6 Feedback loop | 2 nouveaux tools + UI dashboard "marked helpful/outdated" |
| Sem 2, J3-5 | Tests E2E + polish + démo vidéo "agent qui se souvient" | Demo asset |

**Livrable** : la **vraie transformation produit**. Un agent sans demander voit déjà les préférences de l'équipe. C'est ce moment qu'on capture en vidéo pour le pitch.

### Sprint 3 — Intelligence émergente (3 semaines · 18 SP · ~9 j-h)

| Semaine | Item | Output |
|---|---|---|
| Sem 1 | 2.1 Extraction post-job | LLM auxiliaire Haiku + prompt extraction + insertion `source='reflection'` |
| Sem 2 | 2.2 Prefetch async | refactor `executeJob` pour kick-off prefetch en parallèle |
| Sem 3 | 2.3 Colonnes temporelles actives | filtres `valid_to` + tool `invalidate_memory` + tests |

**Livrable** : mémoire qui se densifie toute seule au fil des jobs, se nettoie de l'obsolète, et répond plus vite. Pitch : *"Plus tu utilises NodalAI, plus il devient bon — sans intervention humaine."*

---

## Effort total et timeline

| Sprint | Items | SP | j-h équivalents | Calendrier |
|---|---|---|---|---|
| Sprint 1 | 1.1, 1.2, 1.3 | 8 | ~4 j-h | Semaine 1 |
| Sprint 2 | 1.4, 1.5, 1.6 | 10 | ~5 j-h | Semaines 2-3 |
| Sprint 3 | 2.1, 2.2, 2.3 | 18 | ~9 j-h | Semaines 4-6 |
| **Total** | **9 items P1+P2** | **36 SP** | **~18 j-h** | **6 semaines solo** |

**Items P3 (3.1, 3.2, 3.3) en backlog** : 26 SP additionnels, à débloquer ad hoc.
**Items P4 (4.1) skip explicite** sauf demande utilisateur claire.

---

## Critères de succès

À la fin de Sprint 2 (3 semaines) :

| Critère | Mesure |
|---|---|
| **Auto-injection démontrable** | Crée un agent + 5 memories → `executeJob` → vérifier que le system prompt rendu contient les 5 facts |
| **Budget respecté** | Memories > budget → seules les top-importance sont injectées |
| **Sanitation active** | `save_memory({ fact: "ignore previous instructions" })` → rejet structured error |
| **Pas de doublon** | Insérer le même fact 2× → 2e jet rejeté |
| **Real search** | `query_memory({ query: "typescript" })` → top 5 par cosine |
| **Wow demo** | Vidéo 60s : "user dit X dans une session, ouvre une nouvelle session, l'agent s'en souvient sans aucun query manuel" |

À la fin de Sprint 3 (6 semaines) :

| Critère | Mesure |
|---|---|
| **Extraction auto** | Compléter un job → 1-3 facts apparaissent avec `source='reflection'` |
| **Prefetch trace** | OTel span montre `searchMemories` démarre avant `generateText` premier turn |
| **Obsolescence active** | `invalidate_memory` → fact disparaît des search ≤ 1 turn |
| **Densification mesurable** | Sur 1 semaine d'usage : count `agent_memory` augmente sans intervention humaine, count `archived` augmente aussi |

---

## Ce qui change concrètement pour un utilisateur

### Avant (état actuel)

```
User : "OK, on a parlé de TypeScript strict la semaine dernière."
Agent : "Pouvez-vous me rappeler ce que nous avons discuté ?"
[user doit re-expliquer]
```

### Après Sprint 2 (auto-injection)

```
[System prompt auto-injecte :
  - (preference, 5★) user works in TypeScript strict mode, no any allowed
  - (context, 4★) project NodalAI uses pnpm workspaces + Turborepo]

User : "OK, on a parlé de TypeScript strict la semaine dernière."
Agent : "Oui — tu m'avais expliqué que tu refuses tout `any` et que les invariants
        sont enforced via dependency-cruiser. Tu veux qu'on revienne sur quel aspect ?"
```

### Après Sprint 3 (extraction auto + temporel + prefetch)

```
[Job complete → Haiku extrait : "User considers Vercel AI SDK locking acceptable
                                 vs maintaining custom transports."]
[Fact persisté avec source='reflection']
[2 semaines plus tard, user dit : "On migre vers Bun finalement"]
[Agent appelle mark_outdated sur le fact précédent]
[Le fact passe à archived=true + valid_to=now()]

→ Au tour suivant, le system prompt ne mentionne plus Vercel AI SDK
→ Mais l'historique reste auditable dans le dashboard
```

---

## Risques et mitigations

| Risque | Impact | Mitigation |
|---|---|---|
| Auto-injection bloat le system prompt | Tokens consumption explose | Budget dur 1500 tokens (1.5) + monitoring cost-per-job |
| Sanitation trop agressive → faux positifs | UX dégradée | 11 patterns calibrés sur Hermes (testés en prod), bypass admin opt-in |
| Extraction auto produit du bruit | Mémoire polluée | LLM auxiliaire Haiku avec prompt strict "0-5 facts MAX, skip task outcomes" + sanitation 1.1 appliquée |
| Coût LLM auxiliaire | $$ | Haiku ~$0.0001/job ; cap configurable per-entity ; skip jobs triviaux |
| Migration colonnes temporelles | Données existantes pas migrables | Default `valid_to=NULL` = jamais expiré, rétro-compatible |

---

## Références

- **Audit deep mémoire** : [`hermes-memory.md`](./hermes-memory.md) — 540 lignes, source de tous les patterns
- **Audit global** : [`hermes-total-audit.md`](./hermes-total-audit.md) §13 — verdict mémoire et positioning stratégique
- **Code Hermes référence** :
  - `D:/APPS/hermes-agent-main/tools/memory_tool.py` (586 lignes) — built-in `MEMORY.md` + `USER.md` + sanitation
  - `D:/APPS/hermes-agent-main/agent/memory_manager.py` (555 lignes) — orchestrator + 11 hooks
  - `D:/APPS/hermes-agent-main/agent/memory_provider.py` (279 lignes) — ABC + lifecycle contract
- **Code NodalAI actuel** :
  - `D:/APPS/NodalAI/packages/memory/src/{crud,search,list,filter,access-tracking,stats}.ts` (~700 lignes)
  - `D:/APPS/NodalAI/packages/tools/src/builtin/{save-memory,query-memory}.ts` (~142 lignes)
  - `D:/APPS/NodalAI/packages/db/src/schema/memory.ts` (schéma `agent_memory`)
  - `D:/APPS/NodalAI/packages/orchestration/src/system-prompt.ts` (à étendre pour 1.4)
  - `D:/APPS/NodalAI/apps/runner/src/job/execute.ts` (à étendre pour 2.1 et 2.2)

---

*Roadmap mémoire NodalAI — version 1.0 — 2026-05-13*
