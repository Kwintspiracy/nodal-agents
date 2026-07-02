# Lot — Mémoire scalable + Curator (plan décidé)

> **STATUT D'IMPLÉMENTATION (2026-07-02) — CODÉ, tests verts, NON commité/non déployé.**
> Orchestré Opus 4.8, codé par 3 agents Sonnet 5.
> - **B1 (FTS)** — FAIT. Migration 0051 `search_tsv` généré + GIN, config **`'english'` (stemming : token↔tokens)** et non `'simple'` (décision : 'simple' trop restrictif). Injection FTS-rankée `ts_rank(plainto_tsquery('english', task))` sans filtre `@@` (fallback importance/récence si tâche vide). `query_memory`/`keywordSearch` : ILIKE → FTS **OR** (`to_tsquery('english', 'a | b | c')`, termes sanitizés). jobs/`search_history` restent en `'simple'` (hors scope).
> - **B2 (curator ON + ré-scoring)** — FAIT. Migration 0052 flag **`memory_curation_enabled` (défaut true, DÉCOUPLÉ de `reflection_enabled`)** + env `MEMORY_CURATION_ENABLED`. Gating par-passe dans `run-curator.ts` (la curation mémoire survit à reflection off). Outil LLM **`set_importance`** usage-driven (charge `access_count`, prompt RE-SCORE) + helper `updateAgentMemoryImportance` (refuse `manual`).
> - **B3 (UI override)** — FAIT. Migration 0053 `importance_locked`. Actions `updateMemoryImportanceAction` (pose lock) + `unpinMemoryImportanceAction` (retire lock, préserve importance). Curator respecte le lock (chaîne agent→curator→**user gagne**). UI /memories : colonne Importance = étoiles 1-5 + cadenas cliquable pin/unpin.
> - **B4 (vecteur)** — toujours DIFFÉRÉ.
> - **Tests + régressions dédiés (audit 2026-07-02, +25 tests) :** P1.1 `run-memory-curator.test.ts` NOUVEAU (9 tests : set_importance/edit/archive sur ligne DB réelle, chaque string d'outcome d'erreur, no-op, access_count/RE-SCORE dans le prompt) · P1.2 query_memory sécurité (syntaxe tsquery ne throw pas, stopwords, ranking OR, access_count bumpé) · P2.3 backward-compat injection (query vide → ordre importance pur) · P2.4 actions web (pin/unpin payload + scoping session) · P3.5 ts_rank domine le sort. **P3.6 (test composant UI) SKIPPÉ** — pas de `@testing-library/react` dans apps/web (seul jsdom), `ImportanceStars` inline dans MemoriesClient (pas de harnais composant → gap réel, non comblé).
> - **UX unpin corrigé (retour live Quentin) :** colonne Importance rendue TOUJOURS visible (était `hidden lg:table-cell`) + affordance unpin découvrable (pill « Pinned » → « Unpin » au hover) au lieu d'une icône cadenas nue.
> - **Portes vertes :** typecheck 27/27 · deps:check 0 erreur · memory 143 · tools 370 · runner 476 · web 530 · web lint 0. Migrations 0051-0053 appliquées sur **vrai Postgres** au boot dev.
> - **RESTE :** décision commit → build+pack → boot du vrai pack + valider live → publish npm. Gap ouvert : test composant UI (P3.6, nécessiterait @testing-library/react).

**Statut :** scope figé avec Quentin, 2026-07-02. Basé sur un audit croisé Hermès ↔ Nous, vérifié ligne par ligne (voir « État vérifié » ci-dessous). La mémoire vectorielle est **incluse dans le plan mais reportée** à une étape ultérieure — PAS à faire cette fois. Tout le reste est à faire, curator inclus.

## Objectif

Tenir la charge à des milliers de faits sans rater les faits pertinents-mais-anciens, et garder la mémoire propre dans le temps via un agent curateur qui repasse régulièrement. Aujourd'hui l'injection est un fenêtrage récence + mots-clés (borné à 200), et la passe LLM de curation est OFF par défaut.

## État vérifié (ce qui existe déjà, code lu)

- **Injection auto** (`packages/memory/src/inject.ts` `selectMemoriesForInjection`) : `SELECT ... WHERE entity + not archived + not expired ORDER BY importance DESC, last_accessed_at DESC LIMIT 200` (`MAX_CANDIDATES=200`), puis rank en JS `importance + min(hits_mots_clés_de_la_tâche, 2)*2`. → **le pré-filtre n'est PAS relevance-aware** ; les faits pertinents hors du top-200 par récence ne sont jamais injectés.
- **`query_memory`** (`packages/tools/src/builtin/query-memory.ts`) : `keywordSearchMemories` = **ILIKE** mots-clés (pas de FTS, pas d'embeddings). Aucune branche embedding.
- **`agent_memory`** (`packages/db/src/schema/memory.ts`) : a `importance int default(3)`, `access_count`, `archived`, `valid_to`, une **colonne `embedding vector(1536)` (pgvector) présente mais inutilisée** par défaut. **Pas de colonne FTS** (contrairement à `agent_jobs.search_tsv` + GIN, migration 0050, qui alimente `search_history`).
- **`save_memory`** : l'agent peut assigner `importance 1-5` mais **retombe à 3** s'il ne la précise pas → importance quasi-plate en pratique. UI /memories : override étoiles **retiré** récemment.
- **Curator mémoire** (`apps/runner/src/cron/run-curator.ts` + `apps/runner/src/reflection/run-memory-curator.ts` + `packages/memory/src/curator.ts`) :
  - **Phase 1 déterministe : ON par défaut**, appelée à chaque tick (~2 min), mais **idempotente** (archive les faits agent-créés, `access_count=0`, `importance ≤ 2`, > 60 j ; jamais `source='manual'`). Requête d'archivage qui matche 0 ligne la plupart du temps.
  - **Phase 2 LLM : OFF par défaut** — gatée par `entities.reflection_enabled` (défaut `false`). Sait déjà **DISTILL** (résumer les blobs), **MERGE** les vrais doublons (`edit_memory` l'un + `archive_memory` les autres), **ARCHIVE** l'obsolète. **Ne touche PAS à l'importance** (`edit_memory` ne change que le texte).
- **Hermès (référence, vérifié dans leur source)** : mémoire par défaut = 2 fichiers texte bornés (`MEMORY.md` 2200c / `USER.md` 1375c), snapshot **figé** dans le prompt, **aucune récupération, aucun embedding**. Sémantique = providers opt-in ; le local « Holographic » = vecteurs **SHA-256 déterministes** (pas neuronaux) + FTS5. Leur « curator » = **skills**, pas mémoire ; la mémoire est maintenue par `background_review` (fork à chaque tour). Philosophie : **petite mémoire curée** vs notre **gros store cherchable**.

## Scope — À FAIRE cette fois

### Brique 1 — FTS + GIN sur la mémoire (le gain scale) · Difficulté **Moyenne**
- **Migration** : ajouter à `agent_memory` une colonne générée `search_tsv tsvector` (`to_tsvector('simple'|'english', fact)`) + **index GIN** — calquer sur `agent_jobs.search_tsv` (migration 0050) + backfill des lignes existantes.
- **`selectMemoriesForInjection`** : remplacer le `ORDER BY importance, last_accessed LIMIT 200` par une **sélection par pertinence FTS sur la tâche** : `ORDER BY ts_rank(search_tsv, plainto_tsquery(task)) DESC` (+ `importance` en booster/tiebreaker). Fallback `importance DESC, last_accessed DESC` **quand la tâche est vide** (compat rétro). Garder `selectMemoriesUnderBudget` pour le packing sous budget char.
- **`query_memory`** : passer d'ILIKE à FTS (`ts_rank`) pour un meilleur classement (même moteur que l'injection).
- **Tests** : unit — un fait pertinent mais ancien (hors top-200 récence) EST désormais sélectionné ; tâche vide → ordre importance/récence inchangé ; query_memory classe par pertinence FTS. Régression — `search_history` intact.
- **vs Hermès** : rattrape leur FTS5, mais **sur notre store rankable** → mieux que leur blob figé. Zéro dépendance externe (FTS natif Postgres, pattern déjà éprouvé chez nous).

### Brique 2 — Curator mémoire ON par défaut + ré-scoring d'importance · Difficulté **Faible-Moyenne**
- **Activer par défaut.** ⚠️ **Décision de découplage** : `reflection_enabled` gate À LA FOIS la boucle d'apprentissage (auto-génération de skills, qui a eu des soucis de sur-génération) ET la curation mémoire. → Introduire un **flag dédié `memory_curation_enabled` (défaut `true`)** pour la Phase 2 mémoire, **indépendant** de `reflection_enabled` (qui reste opt-in pour le skill-learning). Le curator mémoire tourne donc par défaut sans allumer la boucle skills.
- **Ré-scoring d'importance** (le manque) : étendre `run-memory-curator.ts` — ajouter la capacité de **ré-évaluer l'importance** d'un fait selon **l'usage réel (`access_count`) + la pertinence**. Soit un nouvel outil `set_importance(id, 1-5, raison)`, soit `edit_memory` accepte un champ `importance`. Le prompt intègre `access_count` et `importance` actuels (déjà chargés, lignes 66/96). Aligné avec le commentaire existant `curator.ts:23` (« usage — sounder than a one-shot importance guess »).
- **Cadence** : garder l'intervalle existant (`CURATOR_INTERVAL_DAYS=7`) + déféré au premier run. Garde-fou `source='manual'` intact (jamais toucher les faits saisis à la main).
- **Tests** : le curator fusionne/distille/archive (existant) + **ré-ajuste l'importance** (nouveau) ; refuse `source='manual'` ; ON par défaut sans `reflection_enabled`.
- **vs Hermès** : notre équivalent de leur `background_review` — eux à chaque tour, nous périodique mais **enfin ON**, et en plus **usage-driven sur l'importance**.

### Brique 3 — Override étoiles dans l'UI · Difficulté **Faible**
- Ré-ajouter l'édition d'importance par fait dans `/memories` (`MemoriesClient.tsx`) : un contrôle étoiles/1-5 + action `updateMemoryImportanceAction`.
- **Flux d'importance acté** : Agent (à la sauvegarde, valeur initiale) → **Curator (ré-ajuste régulièrement selon usage/pertinence = l'autorité dans le temps)** → Utilisateur (override manuel possible).
- **Tests** : l'override user persiste + n'est pas écrasé par le curator (marquer `source`/`importance_locked` si édité à la main ? — décision d'impl : un fait dont l'importance a été fixée par l'user est respecté).

## Scope — REPORTÉ (étape suivante, PAS cette fois)

### Brique 4 — Hybride vecteur opt-in (sémantique) · Difficulté **Élevée** · **DIFFÉRÉ**
- pgvector à rendre dispo dans l'embedded Postgres (aujourd'hui « not available » → colonnes réécrites en texte) + un provider d'embeddings (cloud OU ollama local) + **fusion des scores FTS + cosinus** (façon Holographic : rerank pondéré) + backfill des embeddings.
- **Opt-in strict** (fidèle au zéro-config) : n'entre en jeu que si l'user configure `EMBEDDING_PROVIDER`. La colonne `embedding` et le hybride `searchMemories` existent déjà à moitié.
- **Documenté ici pour mémoire, à ne PAS implémenter dans ce lot.**

## Décisions verrouillées (Quentin)
- FTS d'abord (règle 80 % du problème de scale, zéro dépendance).
- Curator mémoire **ON par défaut**, découplé du skill-learning, avec **ré-scoring d'importance** usage-driven.
- Importance **assignée par l'agent d'abord**, éditable par l'user, autorité dans le temps = le curator.
- Vecteur = **plus tard**, opt-in.

## Ordre d'implémentation suggéré
Brique 1 (FTS) → Brique 2 (curator ON + importance) → Brique 3 (UI override). Brique 4 différée.
