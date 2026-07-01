# Brique — `web_search` : recherche web par défaut + routeur + garde-fou

**Statut :** scopé, à décider (maintenant ou backlog). 2026-07-01.

## Objectif / valeur

Un utilisateur lance Nodal **sans rien configurer** et peut **chercher sur le web tout de suite** (best-effort, gratuit). S'il veut du fiable, il est **guidé vers Tavily** — et le système bascule dessus automatiquement dès que la clé est là. Fini le `web_search` qui `throw` et laisse l'agent paumé.

## État actuel (vérifié dans le code)

- `packages/tools/src/builtin/web-search.ts` = **stub** : `execute()` fait toujours `throw WebSearchNotConfiguredError`. Enregistré (`index.ts:89`) mais **pas** dans `ALWAYS_ON_TOOLS`.
- La vraie recherche = **connecteurs** : `tavily_search` (`adapters/tavily`), `firecrawl_search` (`adapters/firecrawl`). Arrivent via `capabilityTools` dans `execute.ts`, assemblés par `computeToolWhitelist` (`packages/tools/src/whitelist.ts`).
- Le LLM reçoit la **liste** `{ name, description }` (`execute.ts:119`) et **choisit lui-même** — aucun routeur.
- Pattern « découvrabilité » déjà présent : skill `tool-attach-connector`, `WebSearchNotConfiguredError`, baseline « ajoute une clé ».

## Design

### 1. Un builtin `web_search` unifié (always-on)

Backend choisi **dans notre code**, priorité :
```
1. Tavily configuré      → tavily_search       (fiable, priorité)
2. sinon Firecrawl        → firecrawl_search
3. sinon                  → DuckDuckGo gratuit   (best-effort, sans clé)
```
Le LLM ne voit qu'**un** outil `web_search` → il n'a pas à choisir le backend ; le routage est déterministe.

### 2. Respect de l'archi (contrainte réelle)

`packages/tools` **ne doit pas** dépendre des adapters/secrets (règle vue `execute.ts:114`). Donc :
- **Le fallback DuckDuckGo** vit **dans le builtin** (`packages/tools`) : pur `fetch` + parse HTML, zéro clé, zéro dépendance adapter.
- **Le backend premium** (Tavily/Firecrawl) est **injecté par le runner** dans le `ToolContext` : quand l'agent a le connecteur, `execute.ts` passe `ctx.searchBackend = (q) => tavilySearch(q, key)`. Le builtin utilise `ctx.searchBackend` s'il existe, sinon son DuckDuckGo interne.

→ Le builtin reste pur ; le runner câble le premium là où les clés déchiffrées sont dispo (à côté de `capabilityTools`).

### 3. Garde-fou + découvrabilité (le point clé demandé)

Sur la branche DuckDuckGo, si l'appel **casse** (bloqué / rate-limité / HTML changé → parse vide) :
- On **ne throw pas dans le vide.** On renvoie un résultat honnête + un message que l'agent relaie :
  > « La recherche web gratuite (best-effort) vient d'échouer — elle n'est pas garantie. Pour du fiable, ajoute une clé **Tavily** (gratuite au départ) : [/connectors] — je basculerai dessus automatiquement. »
- Distinguer **ponctuel** (rate-limit → « réessaie / passe à Tavily ») de **durable** (scraper cassé → on répare, mais on pousse Tavily en attendant).
- Réutilise le mécanisme de découvrabilité existant (pointer vers le connecteur Tavily).

## Ce qu'on code

| Fichier | Changement |
|---|---|
| `packages/tools/src/builtin/web-search.ts` | Réécrire `execute()` : utilise `ctx.searchBackend` si présent, sinon DuckDuckGo (fetch + parse). Retour `{results, degraded?, guidance?}`. |
| `packages/tools/src/types.ts` (ToolContext) | Ajouter `searchBackend?: (query) => Promise<Result[]>`. |
| `packages/tools/src/builtin/index.ts` | Ajouter `web_search` à `ALWAYS_ON_TOOLS`. |
| `apps/runner/src/job/execute.ts` | Si l'agent a Tavily/Firecrawl → construire `searchBackend` (priorité Tavily>Firecrawl) et le mettre dans le `ToolContext`. |
| description du tool | « Search the web. Uses your configured provider (Tavily/Firecrawl) if any, otherwise a free best-effort search. » |

## Tests (gates du projet)

- **Unit** : parse d'une réponse DuckDuckGo mockée → résultats corrects ; réponse cassée → `degraded:true` + message découvrabilité ; `ctx.searchBackend` fourni → l'utilise (pas de DuckDuckGo).
- **Unit runner** : agent avec Tavily → `searchBackend` = Tavily ; sans → DuckDuckGo.
- **Régression** : `tavily_search` / `firecrawl_search` restent dispo tels quels (un agent peut toujours les appeler directement).
- **Smoke (gated, optionnel)** : un vrai appel DuckDuckGo live.

## Risques / décisions ouvertes (pour Quentin)

1. **DuckDuckGo est fragile** (rate-limit, ToS gris, HTML qui bouge). Alternative « sans clé mais plus stable » = SearXNG self-hosté (mais faut l'héberger). → on part sur DuckDuckGo pour le zéro-config, avec le garde-fou qui assume la fragilité.
2. **Always-on pour TOUS les agents** ? (choix : always-on universel vs skill baseline vs assignable). Reco : always-on (read-only, universel, dégrade proprement).
3. On garde `tavily_search`/`firecrawl_search` **aussi** exposés (pour le contrôle fin), OU on ne montre que `web_search` ? Reco : garder les deux (le routeur pour le confort, les outils bruts pour les cas précis type `firecrawl_scrape`).

## Effort
~2-3 jours (builtin + injection runner + garde-fou + tests). Zéro nouvelle dépendance (DuckDuckGo = `fetch` + un mini-parseur ; on a déjà de quoi parser).
