# Demande de review — PR #46, passe 24 (P4a : le coût au plus près du réel)

Périmètre : **le commit P4a qui suit `82ff74f3`** (`packages/shared/src/model-catalog.ts`
et son test `cost-estimate.test.ts`, `apps/runner/src/llm/call-sink.ts`,
`apps/runner/src/job/execute.ts` — deux appels).

## Ce que Quentin a demandé (06/09)

« Le plus important, c'est que le coût affiché soit le plus près possible du
coût réel. » Or `estimateModelCostUsd` facturait CHAQUE jeton d'entrée au prix
plein, cache compris — sur un job cron où 95 % de l'entrée est relue du cache
(mesuré : 36 032 sur 36 071 jetons au tour 4 du job `dd478381`), le coût des
fournisseurs natifs était surestimé jusqu'à ×5. OpenRouter, lui, rapporte son
coût réel ; il n'était pas concerné.

## Ce que le commit affirme

1. **Un prix de cache PAR MODÈLE, jamais un facteur.** `ModelPricing` gagne
   `cacheReadPerMillionUsd?` et `cacheWritePerMillionUsd?`. Source :
   OpenRouter `GET /api/v1/models`, `pricing.input_cache_read` /
   `input_cache_write` × 1e6, relevé le 06/09/2026 — le rapport n'est PAS
   universel (Anthropic 0,1× lu / 1,25× écrit ; DeepSeek 0,5× ; Kimi ≈ 0,17× ;
   Google écrit à ≈ 0,05×, c'est du stockage). Les natifs (Anthropic, OpenAI,
   Google, MiniMax M3/M2.7, Moonshot) reçoivent le prix du même modèle chez
   OpenRouter, qui passe le tarif vendeur (les prix in/out y étaient identiques,
   vérifié pour chacun). Les natifs DeepSeek gardent leur prix vendeur sans prix
   de cache (l'id OpenRouter agrège d'autres revendeurs).
2. **La section `openrouter` est rafraîchie** sur ses prix in/out : 10 entrées
   avaient dérivé (`gpt-5.6-luna` 0,1/0,6 → 0,2/1,2 ; `gemini-3.7-flash`
   0,375/1,875 → 0,75/3,75 ; `glm-5.2` 0,76/2,42 → 0,966/3,036 ; les DeepSeek
   v4 ; `kimi-k2.7-code` ; `gemma-4-31b-it`). Liste complète dans le rapport de
   génération (`p4a-report.txt`, session).
3. **`estimateCallCostUsd(provider, model, { inputTokens, outputTokens,
cachedTokens?, cacheCreationTokens? })`** : frais = entrée − lus − écrits
   (plancher 0, lus et écrits bornés à l'entrée) ; coût = frais × prix + lus ×
   (prix lecture ?? prix entrée) + écrits × (prix écriture ?? prix entrée) +
   sortie × prix. Un modèle sans prix de cache est facturé PLEIN — une
   surestimation, dite par `hasCachePricing()`. `estimateModelCostUsd` reste,
   comme calcul sans cache (compatibilité, tests).
4. **Les deux appelants** passent les jetons de cache : `call-sink.ts`
   (`obs.usage.cachedTokens` / `cacheCreationTokens`) et `execute.ts` (le
   cumul `totalCostUsd` du job, avec `cachedT` / `cacheWriteT` déjà calculés
   pour `effectiveInputTokens`).

## Mesuré

- Opus 5 : 10 000 en entrée (8 000 lus, 1 000 écrits, 1 000 frais), 500 en
  sortie → 0,02775 $ contre 0,0625 $ sans remise ; comparé à 1e-9.
- Mutation : `readRate = prix d'entrée` (remise retirée) → rouge.
- Invariants : prix de lecture ≤ prix d'entrée pour tous ; la liste des modèles
  SANS prix de cache est nommée (7) et ne peut que rétrécir ; `tsc` shared et
  runner propres ; `pricing-coverage` inchangé et vert.

## Ce dont je doute moi-même

### Les natifs prennent le prix OpenRouter du même modèle

Le raisonnement : OpenRouter passe le tarif vendeur pour ces cinq fournisseurs
(in/out identiques au catalogue natif, vérifié). Mais un tarif de cache peut
différer entre l'API directe et OpenRouter (Anthropic : 5 min vs 1 h d'écriture,
1,25× vs 2×). Le catalogue prend la valeur publiée par OpenRouter ; est-ce le
bon défaut pour l'API directe, ou faut-il citer la page vendeur ?

### `inputTokens` inclut-il le cache pour TOUS les fournisseurs ?

L'estimateur suppose la sémantique AI SDK (`inputTokens.total` = frais + lus +
écrits, vérifié dans `@ai-sdk/anthropic` 3.0.76 :
`convert-anthropic-messages-usage.ts`). Si un fournisseur rapportait
`inputTokens` HORS cache, `fresh = input − reads` sous-compterait. Vérifié dans
les dist : `@openrouter/ai-sdk-provider` (`noCache: promptTokens - cacheReadTokens`)
et `@ai-sdk/openai` (`noCache: inputTokens - cachedTokens`) — le total inclut le
cache pour les trois fournisseurs qui comptent ici.

### Le plancher `Math.min(reads, input)`

Des compteurs incohérents (lus > entrée) sont bornés silencieusement. Faut-il
plutôt le tracer ?

## Hors périmètre

La barre d'état (P4b), l'écran ; les lignes `llm_calls` déjà écrites (leur
`cost_usd` reste ce que le runner d'hier a calculé — pas de recalcul rétroactif).

## Ce qui n'est PAS attendu

« Ça a l'air bien ». Deux verdicts : tient / faux. Dis explicitement si tu ne
trouves rien de neuf. Un constat non exécuté est marqué NON EXÉCUTÉ.
