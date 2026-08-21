# AUDIT_HARNESSES — les douze harnais LLM

**2026-08-07**

> **Ce document est très majoritairement `BLOCKED`, et c'est son résultat principal.** La grille
> demandait neuf dimensions pour chacun des douze fournisseurs, soit 108 vérifications. Sans clé
> fournisseur, une seule dimension a pu être établie pour tous. Le publier tel quel est plus honnête
> que de le remplir par lecture de noms de fichiers — ce que §3.5 interdit explicitement.

---

## 1. Ce qui a été établi

| Provider | Fichier | `promptCaching` | Note du registre |
|---|---|---|---|
| anthropic | `anthropic.ts` + `anthropic-cache.ts` | **true** | seul à supporter `cache_control` |
| openai | `openai.ts` | false | |
| openai-compatible | `openai-compatible.ts` | false | |
| google | `google.ts` | false | |
| deepseek | `deepseek.ts` | false | « does not support Anthropic-style cache_control headers » — cache **transparent** côté fournisseur |
| moonshot | `moonshot.ts` + `moonshot-schema.ts` | false | |
| minimax | `minimax.ts` | false | « MiniMax's Anthropic endpoint does not support cache_control » |
| mistral | `mistral.ts` | false | |
| groq | `groq.ts` | false | |
| openrouter | `openrouter.ts` | false | « depends on underlying model; conservative default » — cache **transparent** côté fournisseur |
| ollama | `ollama.ts` | false | « local inference, no caching layer » |
| image-models | `image-models.ts` | false | |

**Établi pour les douze `[A]`** : le drapeau `promptCaching` et son application effective
(`client.ts:310` conditionne l'injection des breakpoints sur ce drapeau — donc pas d'écart entre la
déclaration et l'usage).

**Établi transversalement `[A]`** :
- Aucune table de tarification n'existe dans `registry.ts` (`grep costUsd|pricePerM|inputPrice` :
  zéro résultat). Conséquence directe sur TOKEN-001 : le plafond en dollars n'a aucune source de
  repli.
- `EMBEDDING_PROVIDER` vaut `keyword` par défaut (`env.ts:35`), donc aucun appel d'embedding — ni
  coût — dans la configuration livrée.

---

## 2. Ce qui n'a pas été établi

Pour **chacun** des douze fournisseurs, les huit dimensions suivantes sont `BLOCKED` :

1. Tool-calling — format natif ou contournement, et validité du contournement contre l'API **actuelle**
   du fournisseur. Le README cite des contournements pour les arguments hors-spec de DeepSeek et des
   formats XML pour Kimi/Qwen/GLM ; **aucun n'a été vérifié contre la documentation courante**, alors
   que c'est précisément le genre de chose qui se périme en silence et dégrade la qualité sans erreur.
2. Streaming supporté et utilisé.
3. Sortie structurée / mode JSON — natif ou forcé par prompt.
4. Gestion des tokens de raisonnement et round-tripping.
5. Fenêtre de contexte : `probe-context.ts` établit-il des limites réelles, et que se passe-t-il au
   dépassement (troncature, résumé, échec) ?
6. Taxonomie d'erreurs : 429, 5xx, timeout, filtre de contenu et dépassement de contexte sont-ils
   distingués ? Rejouer un dépassement de contexte est du gaspillage pur ; rejouer un filtre de
   contenu est inutile.
7. Exactitude tarifaire.
8. Épinglage d'identifiant de modèle vs alias flottant.

Et les six modules transversaux — `tool-call-middleware.ts`, `parsers.ts`, `tolerant-fetch.ts`,
`retry.ts`, `failover.ts`, `tool-choice-floor.ts` — sont **tous `BLOCKED`**.

Ils méritent une attention particulière au prochain passage, pour deux raisons formulées par le
protocole lui-même :

- **`tolerant-fetch.ts`** : « tolérant » est un mot à interroger. Quelles malformations accepte-t-il,
  et cette tolérance peut-elle masquer une vraie erreur, voire accepter une réponse malveillante ?
  C'est en tension directe avec l'invariant #4 du projet (« fail loud, no silent smart fallbacks »).
- **`failover.ts`** : le basculement d'un modèle bon marché vers un modèle cher est un événement de
  coût silencieux. Le contexte est-il renvoyé intégralement ? À quel différentiel de prix ?
  L'utilisateur le voit-il ?

Je n'ai **aucune** base pour affirmer quoi que ce soit sur ces six modules — ni en bien ni en mal.

---

## 3. Ce qu'il faudrait pour compléter

Une clé bon marché sur trois familles couvrirait l'essentiel de la diversité de comportement :

| Famille | Fournisseur suggéré | Ce que ça couvre |
|---|---|---|
| Agrégateur | OpenRouter | GLM, Kimi, Qwen via un seul jeton — plus le **seul** chemin où le plafond en dollars fonctionne réellement, donc le seul moyen de tester TOKEN-11 |
| Natif non-OpenAI | DeepSeek | Les arguments d'outils hors-spec, le round-tripping du raisonnement, le cache transparent |
| Natif à cache explicite | Anthropic | Le seul chemin `promptCaching:true`, donc la seule mesure possible du taux de hit |
| Local | Ollama | Absence d'authentification, absence de coût, effondrement silencieux de qualité |

Coût estimé pour l'ensemble des mesures de la phase 6 et des mesures de tokens manquantes de la
phase 5 : de l'ordre de quelques dollars, très en deçà du plafond autorisé. **C'est la dépense la
plus rentable pour compléter cet audit** — elle débloquerait à elle seule 16 des 20 contrôles de la
phase 6 et 8 des 16 de la phase 5, soit près du tiers de tout ce qui est resté `BLOCKED`.
