# AUDIT_TOKENS — coût réel du prompt et garde-fous de dépense

**2026-08-07** · mesures `[B]` avec `js-tiktoken` (`cl100k_base`) sur les vrais objets du dépôt

> **Limite** : aucune clé fournisseur n'était disponible. Les blocs **constants** du prompt sont donc
> mesurés exactement ; l'historique de conversation, l'injection mémoire réelle, le surcoût de
> délégation et le taux de hit du cache **ne le sont pas**. Aucun chiffre estimé n'apparaît ici : ce
> qui n'a pas été mesuré est marqué comme non mesuré.

---

## 1. Ce qui a été mesuré

### 1.1 Skills système du catalogue livré — 18 645 tokens au total

| tokens | slug | kind |
|---:|---|---|
| 3 726 | claude-html-design | — |
| 2 996 | obsidian | — |
| 1 152 | verify-before-done | **baseline** |
| 1 039 | telegram-responder | channel |
| 922 | command-execution | — |
| 893 | results-delivery | capability |
| 872 | office-editing | — |
| 782 | research-scope-discipline | — |
| 727 | tool-schedules | agent-internal |
| 701 | tool-create-mcp | agent-internal |
| 681 | safe-tool-use | **baseline** |
| 643 | tool-create-agent | agent-internal |
| 573 | citation-discipline | — |
| 539 | task-planning | — |
| 533 | workspace-hygiene | **baseline** |
| 512 | markdown-output | channel |
| 408 | tool-update-agent | agent-internal |
| 360 | language-mirror | **baseline** |
| 320 | tool-attach-mcp | agent-internal |
| 266 | tool-attach-connector | agent-internal |

**Sous-total `kind=baseline` = 2 726 tokens** — c'est le seul montant réellement payé par *tout*
agent. Le total de 18 645 est un plafond théorique qui suppose les 20 skills attachées, ce qui
n'arrive pas.

### 1.2 Blocs constants

| tokens | bloc |
|---:|---|
| 2 964 | `buildBaselineBlock(role: 'orchestrator')` |
| 2 873 | `buildBaselineBlock(role: 'agent')` |
| 1 516 | `buildChannelBlock(telegram)` |

**Observation** : 91 tokens seulement séparent l'orchestrateur de l'agent. Un worker délégué paie donc
quasiment la même discipline de base, y compris les parties qui ne le concernent pas.

*Note de méthode : une première passe avait utilisé `role: 'root'` / `'worker'`, valeurs absentes de
la signature (`'agent' | 'orchestrator' | 'system'`), et concluait à tort à une identité parfaite.
Chiffres ci-dessus obtenus après relecture de la signature.*

### 1.3 Schémas d'outils — 14 589 tokens pour 59 outils intégrés

| tokens | outil |
|---:|---|
| 758 | xlsx_format_range |
| 656 | pptx_create |
| 576 | docx_create |
| 557 | create_schedule |
| 525 | create_mcp |
| 495 | run_command |
| 490 | pptx_append_slides |
| 399 | create_agent |
| 368 | update_schedule |
| 361 | update_skill |
| 354 | create_skill |
| 338 | xlsx_set_column_widths |

**Concentration** :
- 24 outils Office (`docx_*`, `pptx_*`, `xlsx_*`) = **6 462 tokens = 44 % du budget de schémas**
- 19 outils méta (`create_*`, `update_*`, `attach_*`, `detach_*`, `*_schedule`) = **4 429 tokens**

### 1.4 Ordre de grandeur d'un agent ROOT bureautique

```
buildBaselineBlock(orchestrator)      2 964
skills kind=baseline (×4)             2 726
schémas Office (×24)                  6 462
schémas méta (×19)                    4 429
reste des schémas                     3 698
                                    ───────
préfixe système fixe               ~20 300 tokens / tour
```

Hors mémoire injectée, hors contexte de job, hors historique de conversation, hors bloc canal
(+1 516 si Telegram).

---

## 2. Le cache — conception juste, portée étroite

### 2.1 Ce qui est bien fait

`packages/orchestration/src/system-prompt.ts:629-631` sépare explicitement le prompt en deux moitiés :

```
const volatile = runtimeBlock + memoryBlock + jobContextBlock + inventoryBlock;
return volatile.trim().length > 0 ? stable + SYSTEM_PROMPT_CACHE_BOUNDARY + volatile : stable;
```

`packages/llm/src/providers/anthropic-cache.ts` exploite ce marqueur correctement : point de cache
éphémère sur le **préfixe stable**, la moitié volatile passant en second message système **non caché**
pour ne pas invalider le préfixe, plus un point de cache **glissant** sur le dernier message pour que
le transcript croissant soit relu depuis le cache.

C'est exactement le bon découpage. Le préfixe de ~20 300 tokens mesuré ci-dessus est donc,
sur Anthropic, payé plein tarif une fois puis à ~10 % ensuite.

Second point favorable : le garde-fou de tokens est **sensible au cache**
(`apps/runner/src/job/execute.ts:2577`) — il compte `effectiveInputTokens + outputTokens`, c'est-à-dire
hors tokens cachés. Un job long qui relit un transcript en cache n'est donc pas tué à tort. C'est un
raisonnement que beaucoup de harnais ratent.

### 2.2 Ce qui est étroit

`packages/llm/src/providers/registry.ts` — drapeau `promptCaching` :

| Provider | `promptCaching` | Note du code |
|---|---|---|
| anthropic | **true** | seul à supporter `cache_control` |
| openai | false | |
| ollama | false | « local inference, no caching layer » |
| openai-compatible | false | |
| google | false | |
| mistral | false | |
| groq | false | |
| openrouter | false | « depends on underlying model; conservative default » |
| deepseek | false | « DeepSeek does not support Anthropic-style cache_control headers » |
| minimax | false | « MiniMax's Anthropic endpoint does not support cache_control » |
| moonshot | false | |
| image-models | false | |

Nuance importante : DeepSeek et OpenRouter **cachent de façon transparente** côté fournisseur — le
commentaire d'en-tête d'`anthropic-cache.ts` le reconnaît explicitement. Le coût y est donc atténué,
mais sans que le produit y contribue et sans que la réduction soit visible dans ses compteurs.

**Non mesuré** : le taux de hit réel, qui exigerait les compteurs `cachedInputTokens` renvoyés par un
fournisseur en fonctionnement.

---

## 3. Garde-fous de dépense

| Garde-fou | Emplacement | État |
|---|---|---|
| **Budget de tokens par job** (Guard 1a) | `execute.ts:2577-2595` | ✅ Fonctionne, et sensible au cache. C'est la protection réelle |
| **Plafond en dollars** (Guard 1e) | `execute.ts:2596-2613` | ⚠️ **Ne se déclenche que si le fournisseur renvoie le coût** — soit OpenRouter avec `usage:{include:true}`. Pour les 11 autres, `totalCostUsd` reste à 0 et le plafond n'est jamais atteint |
| Table de tarification locale | `registry.ts` | ❌ **Inexistante** — `grep costUsd\|pricePerM\|inputPrice` : zéro résultat. Aucune estimation de repli |
| Compteurs anti-boucle | `chain-counters.ts` | 15 chaînes, 50 appels/tour, profondeur 3 — présents, **non exercés sous charge** |
| Détecteur d'absence de progrès | — | **Non exercé** |
| Amplification par retry / failover | `retry.ts`, `failover.ts` | **Non modélisée** — c'est le trou le plus significatif de cette phase |

Le commentaire du code est parfaitement honnête sur le point 2 : *« Fires only when the provider
actually reported a non-zero cost (i.e. OpenRouter with usage:{include:true}); providers that don't
report cost leave totalCostUsd at 0 and this guard never trips — Guard 1a is the fallback for those. »*
C'est la promesse produit — « real-dollar cost cap from provider-billed cost » — qui ne correspond
pas. Voir **TOKEN-001**.

---

## 4. Optimisations classées par gain mesuré

| Rang | Action | Gain mesuré | Effort | Risque qualité |
|---|---|---|---|---|
| 1 | Rendre les 24 outils Office attachables par capacité | **jusqu'à 6 462 tk/tour** sur un agent non bureautique | M | Moyen — un agent perd une capacité sans le savoir si la découvrabilité n'est pas soignée |
| 2 | Rendre les 19 outils méta conditionnels au niveau d'autonomie et aux grants ROOT | **jusqu'à 4 429 tk/tour** sur un agent non ROOT | M | Faible — un worker n'a de toute façon pas à créer des agents |
| 3 | Différencier réellement la baseline worker | ~1 000-1 500 tk par sous-agent, multiplié par le fan-out (non mesuré) | S | **Élevé** — ce projet a déjà documenté qu'un worker mal cadré dérive (étude de causalité du 21/07) |
| 4 | Étendre le cache aux fournisseurs qui le supportent nativement | non mesuré | M | Nul |
| 5 | Alléger `claude-html-design` (3 726 tk) et `obsidian` (2 996 tk) | jusqu'à 6 722 tk, mais seulement pour les agents qui les ont | S | Moyen — ce sont des skills de contenu, les raccourcir dégrade leur objet |

**Recommandation de priorité** : 1 puis 2. Ensemble, ils retirent jusqu'à **10 891 tokens par tour**
d'un agent ordinaire, soit plus de la moitié du préfixe fixe mesuré, sans toucher à la discipline de
l'agent — donc sans le risque de fiabilité que porte l'option 3.

---

## 5. Ce qui reste à mesurer

8 des 16 contrôles de la phase 5 sont `BLOCKED`. En particulier :

- ventilation complète d'un **job réel** (historique, mémoire injectée, résultats d'outils) ;
- **surcoût de délégation** — chaque sous-agent repaie son propre préfixe, et avec un fan-out à
  profondeur 3 le multiplicateur peut être important ; c'est probablement le plus gros poste non
  mesuré ;
- **taux de hit du cache** réel ;
- **amplification par retry** : pire cas de dépense issu d'une seule action utilisateur ;
- déclenchement effectif des deux garde-fous en charge.

Tout cela demande une clé fournisseur bon marché et une base peuplée. C'est le point 18 du plan de
remédiation.
