# Lot — First-run experience (décidé, à implémenter)

**Statut :** scope figé avec Quentin, 2026-07-01. Trois briques qui font qu'un premier lancement donne un agent **capable + aligné + qui sait chercher**, au lieu d'un agent bridé qui confirme tout.

## Contexte / problèmes constatés (vérifiés dans le code)

1. **L'agent d'onboarding devient ROOT par auto-désignation** → chemin passif qui met **tous les grants OFF + `autonomy: 'propose_confirm'`** (`packages/shared/src/root-agent.ts`). Résultat : agent qui « ne peut rien + confirme tout ».
2. **L'interview capture l'autonomie mais ne l'applique pas** : la 5e question (initiative vs suivre les ordres) → `createMemoryAction` seulement (`OnboardingFlow.tsx:424`), jamais écrite sur le réglage d'autonomie.
3. **Les built-in tools ne sont pas documentés** (`web_search`, `file_*`, `save_memory`, `dashboard_publish`…) — pas de page de référence.
4. **`web_search` est un stub** qui throw ; la vraie recherche n'existe que via connecteur (Tavily/Firecrawl), donc rien out-of-the-box.

## Décisions (figées)

- **L'onboarding est un acte DÉLIBÉRÉ** (l'user le déroule + répond) → on le traite comme la désignation manuelle : **tous les grants ON** (`DEFAULT_ROOT_GRANTS`). Justification Quentin : install local/perso, peu de risque ; le garde-fou pertinent = l'autonomie, pas le bridage des capacités.
- **L'autonomie est pilotée par la réponse d'interview**, avec confirmation par l'agent.

## Brique A — Onboarding pilote l'autonomie + grants ON

1. À la fin de l'interview, l'agent **classe la réponse** de la question 5 dans un des 3 modes et **confirme** :
   > « OK, je vois. Il y a 3 modes — je te mets en **[X]**. Tu pourras le changer dans **Settings → Autonomy**. »
2. Applique **vraiment** le réglage sur l'agent (pas en mémoire) :
   | Réponse | `AutonomyLevel` | Comportement |
   |---|---|---|
   | prends l'initiative / autonome | `fully_autonomous` | fait tout seul |
   | un mix / équilibré | `destructive_gate` | ordinaire seul, gate le destructif |
   | suis mes ordres | `propose_confirm` | confirme avant d'agir |
3. Le ROOT auto-créé reçoit **`DEFAULT_ROOT_GRANTS` (tout ON)** au lieu du profil auto-désignation (tout OFF).
- **Fichiers :** `OnboardingFlow.tsx` (mapping + confirmation + appel action) ; l'action de set root-grants/autonomy (déjà existante côté /settings/root-context) ; le point d'auto-désignation ROOT (traiter l'onboarding comme délibéré).
- **Décision d'impl :** le mapping réponse→mode via classification LLM dans le flow (l'interview tourne déjà sur le modèle), confirmé à l'écran + modifiable.

## Brique B — `web_search` par défaut (routeur + fallback + garde-fou)

Voir `docs/proposals/web-search-brique-2026-07.md`. Résumé :
- Un `web_search` unifié always-on : Tavily > Firecrawl > **DuckDuckGo gratuit** (routage dans notre code, injecté par le runner).
- Garde-fou : si le gratuit casse → message honnête + découvrabilité vers Tavily.
- Recos figées : DuckDuckGo comme fallback ; always-on universel ; garder aussi `tavily_search`/`firecrawl_search` bruts.

## Brique C — Doc « Built-in tools »

- Page de référence **auto-générée** depuis le registry des builtins (comme skills/connecteurs), listant `web_search`, `file_read/write/edit/list/search`, `save_memory`/`query_memory`/`search_history`, `dashboard_publish`, `return_result`, etc. — avec pour chacun : nom, description, risk, always-on ou non, skill requis éventuel.
- **Fichier :** étendre `apps/docs/scripts/gen-reference.ts`.

## Tests (gates)
- **Unit/regression** : mapping réponse→autonomie (3 cas) ; l'onboarding écrit bien le réglage + grants ON ; `web_search` (parse OK / degraded / backend injecté).
- **Doc** : la référence builtins se génère sans drift.

## Effort estimé
- Brique A : ~1-1.5j. Brique B : ~2-3j. Brique C : ~0.5j. Total ~4-5j.

## Ordre suggéré
B (web_search — le plus visible) → A (onboarding autonomie) → C (doc builtins). Ou A d'abord si on veut d'abord réparer le « premier contact ».
