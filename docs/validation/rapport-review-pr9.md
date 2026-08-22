# Rapport de review — PR #9

Date : 22 août 2026  
Branche : `fix/misc` → `main`  
Commit produit : `18493d7ff164dd6ef52994b3c0b16911eefe7157`  
Commit revu : `8e3033988e2db5b9eb0dc07865e8771734bec2f3`

## Verdict

**DEMANDE DE MODIFICATIONS.** L'entrée native Google est correcte, mais l'entrée OpenRouter porte un tarif deux fois supérieur au tarif réellement publié et facturé par OpenRouter. Le correctif vision est exact pour Gemini 3.6/3.7, mais ne répare que 3 des 14 identifiants omis avant cette PR. Enfin, le comportement antérieur n'était pas silencieux au sens strict : le runner remplaçait l'image par une consigne explicite destinée au LLM.

## Constats, par priorité

### 1. Bloquant — le prix de l'entrée OpenRouter est faux

[`packages/shared/src/model-catalog.ts:792`](../../packages/shared/src/model-catalog.ts#L792) inscrit `0.75 / 3.75` pour `google/gemini-3.7-flash`. Au 22 août 2026, l'API publique OpenRouter publie `pricing.prompt = 0.000000375` et `pricing.completion = 0.000001875`, soit **0,375 $ / 1,875 $ par million**. La page du modèle affiche les mêmes valeurs.

Ce n'est pas une question de convention : le commentaire de provenance du fichier dit explicitement que, dans le bloc `openrouter`, le prix doit être celui réellement facturé (`model-catalog.ts:92-95`). L'entrée surestime donc le coût par deux et peut déclencher prématurément la garde de coût.

Sources : [API publique OpenRouter `/api/v1/models`](https://openrouter.ai/api/v1/models), [fiche OpenRouter Gemini 3.7 Flash](https://openrouter.ai/google/gemini-3.7-flash).

Reproduction :

1. Ouvrir `https://openrouter.ai/api/v1/models`.
2. Chercher l'objet dont `id` vaut `google/gemini-3.7-flash`.
3. Multiplier `pricing.prompt` et `pricing.completion` par 1 000 000.
4. Comparer le résultat `0.375 / 1.875` à `model-catalog.ts:792`, qui contient `0.75 / 3.75`.

Écart adjacent préexistant, à signaler : [`model-catalog.ts:776`](../../packages/shared/src/model-catalog.ts#L776) garde `google/gemini-3.6-flash` à `1.5 / 7.5`, tandis qu'OpenRouter affiche désormais `0.75 / 3.75`. Google annonce aussi que le nouveau tarif promotionnel de 3.7 est appliqué à 3.6. Source : [fiche OpenRouter Gemini 3.6 Flash](https://openrouter.ai/google/gemini-3.6-flash), [guide Google Gemini 3.7](https://ai.google.dev/gemini-api/docs/latest-model).

### 2. Important — la liste vision reste incomplète de 11 identifiants après la PR

Le script officiel a été exécuté en ligne avec succès :

```text
OpenRouter: 421 models
models.dev: 10460 entries
```

Avant la PR, la sortie générée contenait 14 identifiants vision absents de `VISION_MODEL_IDS`. La PR en ajoute trois — `google/gemini-3.6-flash`, `google/gemini-3.7-flash` et `gemini-3.7-flash` — couvrant deux modèles; il reste donc **11 identifiants de catalogue** omis :

- `claude-opus-5`
- `claude-sonnet-5`
- `claude-fable-5`
- `anthropic/claude-opus-5`
- `anthropic/claude-opus-5-fast`
- `anthropic/claude-sonnet-5`
- `anthropic/claude-fable-5`
- `openai/gpt-5.6-luna`
- `openai/gpt-5.6-luna-pro`
- `openai/gpt-5.6-terra-pro`
- `qwen/qwen3.8-max`

Les ajouts manuels Gemini sont bien présents dans la sortie de `node scripts/refresh-model-vision.mjs`; un prochain remplacement par la sortie du script ne les effacera donc pas. La forme native `gemini-3.6-flash` n'est pas attendue, car ce modèle n'existe pas dans le catalogue natif Google actuel du dépôt.

Défaut de diagnostic du script, préexistant mais pertinent : sans accès réseau, ses deux téléchargements ont échoué, puis il a tout de même terminé avec le code `0` et une liste vision vide :

```text
OpenRouter fetch failed: fetch failed
models.dev fetch failed: fetch failed
── Vision-capable (paste into VISION_MODEL_IDS) ──
```

Un opérateur qui ne vérifie que le code de sortie peut donc croire la régénération valide et remplacer la liste par une sortie vide.

### 3. Important — « refuse l'image en silence » est un constat exagéré

Le trou de capacité est réel : avant cette PR, `modelCanSeeImages('google/gemini-3.6-flash')` retournait `false`, donc le runner n'envoyait pas les octets de l'image au modèle.

En revanche, le chemin n'est pas silencieux dans le code. Pour un modèle considéré non-vision, `hydrateForLlm` remplace l'image par le texte construit dans [`apps/runner/src/job/execute.ts:404`](../../apps/runner/src/job/execute.ts#L404) :

```text
Your current model can't see images.
```

La même note ordonne au LLM de déléguer à un agent vision ou de prévenir clairement l'utilisateur (`execute.ts:407-411`), puis elle est injectée à la place de l'image (`execute.ts:454-455`). Il n'y a toutefois pas d'erreur UI ou runner garantie : la notification finale dépend encore du respect de cette consigne par le LLM. Le constat exact est donc : **l'image était retirée de l'appel multimodal et remplacée par une consigne explicite, sans erreur structurée côté utilisateur**.

### 4. À corriger ou documenter — les deux entrées ne diffèrent pas seulement par `forcedToolChoice`

Les trois paires Google natives/OpenRouter du catalogue suivent bien la même convention :

| Modèle | Natif | OpenRouter |
|---|---:|---:|
| Gemini 3.1 Pro | `forcedToolChoice:false` | `true` |
| Gemini 3.5 Flash | `false` | `true` |
| Gemini 3.7 Flash | `false` | `true` |

Cette règle n'est pas universelle à toutes les paires du fichier : les trois paires Anthropic comparables sont `true/true`. Elle est cohérente uniquement à l'intérieur du sous-ensemble Google.

OpenRouter publie `tools` et `tool_choice` parmi les paramètres acceptés par `google/gemini-3.7-flash`, et sa documentation accepte généralement `tool_choice:"required"`. Cela ne constitue cependant pas une mesure live de cette route précise. Aucun `OPENROUTER_API_KEY` n'était disponible dans l'environnement de validation; le test réel de `required` est donc **NON EXÉCUTÉ**.

Il existe aussi une seconde divergence dans les capacités : le natif expose `low/medium/high`, tandis que l'entrée OpenRouter ajoute `max`. L'API OpenRouter du modèle publie seulement `supported_efforts:["high","medium","low"]`. Le runtime transforme `max` en `xhigh`; OpenRouter documente que `xhigh` est rabattu sur `high` pour Gemini. Le réglage ne devrait donc pas casser l'appel, mais il présente deux choix UI équivalents (`high` et `max`) et contredit la recommandation OpenRouter de filtrer le sélecteur sur `supported_efforts`.

Sources : [métadonnées OpenRouter](https://openrouter.ai/api/v1/models), [appel d'outils OpenRouter](https://openrouter.ai/docs/guides/features/tool-calling), [contrôle du raisonnement OpenRouter](https://openrouter.ai/docs/guides/best-practices/reasoning-tokens).

### 5. Les valeurs de l'entrée native Google sont exactes

| Champ | Verdict | Preuve |
|---|---|---|
| `modelId` | CONSTAT TIENT | Google publie `gemini-3.7-flash`. |
| `contextWindow` | CONSTAT TIENT | Limite d'entrée officielle : `1,048,576`. |
| `capabilities.tools` | CONSTAT TIENT | La fiche officielle marque Function calling comme supporté. |
| `reasoningControl` | CONSTAT TIENT | Niveaux `low`, `medium`, `high`; défaut `medium`; `minimal` est refusé. Le contrôle est donc obligatoire au sens du catalogue : pas d'option `off`. |
| prix natif | CONSTAT TIENT AU 22/08/2026 | `0,75 / 3,75` jusqu'au 31/12/2026, puis `1,50 / 7,50`. |
| palier long contexte | AUCUN ÉCART TROUVÉ | La grille Standard de 3.7 publie un tarif unique, sans palier au-delà de 200k. |
| vision | CONSTAT TIENT | Entrées officielles : texte, image, vidéo, audio et PDF. |

Sources : [fiche modèle Google](https://ai.google.dev/gemini-api/docs/models/gemini-3.7-flash), [guide du dernier modèle](https://ai.google.dev/gemini-api/docs/latest-model), [tarification Google](https://ai.google.dev/gemini-api/docs/pricing), [contrôle du thinking](https://ai.google.dev/gemini-api/docs/thinking).

Le tarif promotionnel est la bonne valeur **actuelle** pour une structure utilisée afin d'estimer les appels du jour. Le catalogue n'a cependant aucun champ d'expiration ni mécanisme automatique de bascule; le commentaire seul ne préviendra pas une estimation divisée par deux à partir du 1er janvier 2027.

### 6. Point non traité — « AI mode disponible même si tools = off »

Aucun réglage nommé `AI mode`, `AI Mode` ou `aiMode` n'existe dans `apps/web`. Le réglage le plus proche est **Role**, dans [`AgentComposer.tsx:3039`](../../apps/web/src/app/(dashboard)/agents/%5Bid%5D/edit/AgentComposer.tsx#L3039), avec les valeurs Worker, Router et Planner.

Ce réglage contrôle l'orchestration, pas un « AI mode ». La logique dérivée `requireTools = role !== 'worker'` (`AgentComposer.tsx:2889-2892` et `AgentForm.tsx:222-226`) donne le comportement réel suivant :

- un modèle `tools:false` reste sélectionnable pour un **Worker**;
- il est désactivé pour un **Router** ou **Planner**, car ceux-ci délèguent par appels d'outils.

Si « AI mode » désigne simplement l'utilisation d'un modèle sans outils par un agent autonome, le comportement existe déjà sous le rôle Worker. Si cette expression désigne un autre réglage produit, son exigence reste introuvable et non testable sans capture ou nom fonctionnel exact.

## Vérifications exécutées

- `git diff main...HEAD` : 47 lignes produit dans `packages/shared/src/model-catalog.ts`; le second fichier du diff est la demande de review.
- `node scripts/refresh-model-vision.mjs` avec réseau : succès, 421 modèles OpenRouter et 10 460 entrées models.dev.
- même script sans réseau : deux fetch en échec mais code de sortie `0`.
- tests du paquet shared : **16 fichiers passés, 368 tests passés**, sortie exacte :

```text
Test Files  16 passed (16)
Tests       368 passed (368)
Duration    7.32s
```

- comparaison automatisée des six paires natives/OpenRouter partageant le même identifiant : contextes, prix, `tools` et reasoning cohérents pour les paires existantes, sauf les divergences 3.7 décrites ci-dessus.

## Non exécuté

- Appel OpenRouter facturé avec `tool_choice:"required"` sur `google/gemini-3.7-flash` : aucune clé OpenRouter n'était disponible dans l'environnement. La documentation et les métadonnées confirment le paramètre, mais pas une exécution réelle de cette route.
- Aucun test d'interface manuel : le point « AI mode » ne correspond à aucun libellé ou identifiant localisable. Le comportement du sélecteur de modèles a été tracé dans le code, sans prétendre avoir testé un écran non identifiable.
