# Rapport de review — PR #9, passe delta

Date : 22 août 2026  
Branche : `fix/misc` → `main`  
Commit correctif relu : `d283161`  
Commit courant : `819cb2a063ec876fa92b949a885ae00a22b8e3b5`

## Verdict

**DEMANDE DE MODIFICATIONS.** La régénération vision est exacte (`42 = 42`, zéro écart), mais le seuil du script est trop strict au regard de la couverture mesurée : `models.dev` seul résout aujourd'hui tout le catalogue. Le réglage de raisonnement 3.6 reste également incohérent : `minimal` manque tandis que l'UI expose à tort `Off`, parce que `mandatory:true` manque. Le constat principal sur le trajet réel d'une image vers Opus 5 reste **NON EXÉCUTÉ**; je ne le valide donc pas par lecture de code.

## Question 1 — seuil d'échec du script

### Verdict : seuil actuel trop strict

Mesure effectuée le 22 août 2026 sur les réponses publiques courantes :

```text
OpenRouter: 421 modèles
models.dev: 10 463 entrées indexées
Catalogue: 54 identifiants uniques
```

Couverture de tout le catalogue :

| Source disponible | Résolus | Non résolus |
|---|---:|---:|
| OpenRouter seul | 33/54 | 21 |
| models.dev seul | **54/54** | **0** |
| union | 54/54 | 0 |

Couverture des 42 identifiants de `VISION_MODEL_IDS` :

| Résolution | Nombre |
|---|---:|
| les deux sources | 26 |
| OpenRouter seulement | 0 |
| models.dev seulement | 16 |
| aucune | 0 |

Les 16 identifiants vision résolus uniquement par models.dev sont les formes natives :

- `claude-fable-5`
- `claude-opus-4-8`
- `claude-opus-5`
- `claude-sonnet-4-6`
- `claude-sonnet-5`
- `claude-haiku-4-5-20251001`
- `gpt-5`
- `gpt-5-mini`
- `gemini-3.5-flash`
- `gemini-3.7-flash`
- `gemini-3.1-pro-preview`
- `mistral-large-latest`
- `MiniMax-M3`
- `kimi-k2.6`
- `kimi-k2.7-code`
- `kimi-k3`

Conclusion mesurée : une panne OpenRouter ne rend actuellement aucune entrée inconnue, puisque models.dev résout les 54 identifiants. Pourtant [`scripts/refresh-model-vision.mjs:76`](../../scripts/refresh-model-vision.mjs#L76) quitte dès `failures.length > 0`.

Les deux scénarios ont été exécutés par injection d'une panne réseau ciblée, sans modifier le fichier :

```text
OpenRouter fetch failed: VALIDATION_OPENROUTER_DOWN
models.dev: 10463 entries
Refusing to print a vision list — 1 of 2 sources failed
exit 1
```

```text
OpenRouter: 421 models
models.dev fetch failed: VALIDATION_MODELS_DEV_DOWN
Refusing to print a vision list — 1 of 2 sources failed
exit 1
```

Le premier refus n'est pas justifié par la couverture réelle. Le second l'est : OpenRouter seul laisse 21 formes natives inconnues.

### Troisième voie

Le critère robuste est la **couverture après collecte**, pas le nombre de fetch en échec :

1. accepter toute source qui répond;
2. résoudre chaque identifiant avec les cartes disponibles;
3. si zéro identifiant reste inconnu, imprimer la liste complète, même si une source est tombée;
4. si des identifiants restent inconnus, ne jamais les interpréter comme non-vision;
5. soit refuser le bloc complet, soit imprimer une section « conserver la valeur existante » distincte et non collable comme remplacement intégral.

Le bloc `unknown` existant ne suffisait pas dans sa forme antérieure : le script imprimait d'abord une liste présentée comme prête à coller. Coller cette liste supprimait précisément les anciens identifiants inconnus. Il faut préserver leur état courant ou rendre le remplacement impossible.

### Message d'erreur inexact

Le texte de [`refresh-model-vision.mjs:80`](../../scripts/refresh-model-vision.mjs#L80), « The existing VISION_MODEL_IDS is more accurate than anything derivable here », n'est pas vrai dans tous les cas.

- Avec OpenRouter en panne aujourd'hui, models.dev dérive exactement les 42 valeurs courantes : l'existant n'est pas plus précis.
- Avec models.dev en panne, l'existant récemment régénéré est effectivement préférable aux 21 inconnus.
- Si l'existant est ancien ou déjà faux, il peut être moins précis qu'une source survivante.

Le seul énoncé toujours vrai est : **une valeur inconnue ne doit pas remplacer une valeur existante par `false`**.

## Question 2 — `max` retiré, `minimal` non ajouté

### Verdict : l'asymétrie ne tient pas dans l'état actuel

La réponse publique OpenRouter a été interrogée directement pour `google/gemini-3.6-flash` :

```json
{
  "mandatory": true,
  "default_enabled": true,
  "supported_efforts": ["high", "medium", "low", "minimal"],
  "default_effort": "medium"
}
```

L'entrée à [`model-catalog.ts:774`](../../packages/shared/src/model-catalog.ts#L774) déclare seulement `low/medium/high` et omet `mandatory:true`. Le résultat réel n'est donc pas seulement « minimal indisponible » :

- [`AgentComposer.tsx:196`](../../apps/web/src/app/(dashboard)/agents/%5Bid%5D/edit/AgentComposer.tsx#L196) ajoute `off` lorsque `mandatory` est absent;
- [`openrouter.ts:105`](../../packages/llm/src/providers/openrouter.ts#L105) transforme ce choix en `{ enabled:false }`;
- OpenRouter marque 3.6 comme obligatoire : la désactivation n'est pas un niveau valide.

L'UI expose donc une valeur fausse (`Off`) tout en cachant une valeur vraie (`Minimal`). La même omission de `mandatory:true` existe sur l'entrée OpenRouter 3.7 à `model-catalog.ts:801`, même si 3.7 ne supporte pas `minimal`.

Ajouter `minimal` dépasse une édition locale de données parce que le contrat global l'interdit actuellement :

- `ReasoningEffort` vaut seulement `off|low|medium|high|max` (`model-catalog.ts:18`);
- les schémas d'actions Zod reprennent cette liste (`apps/web/src/lib/actions.ts:915` et `:922`);
- les labels UI n'ont pas `Minimal`;
- le test de cohérence n'autorise que `low/medium/high/max`.

Cela explique pourquoi l'ajout est un changement transversal, mais ne rend pas le catalogue actuel cohérent. Le commentaire du type promet que `levels` contient les niveaux réellement acceptés et que l'UI les traduit sans clamp silencieux. La correction honnête doit donc étendre le contrat à `minimal` et marquer ces modèles `mandatory`, ou documenter explicitement une politique produit de sous-ensemble tout en supprimant impérativement le faux `Off`.

## Question 3 — trajet réel d'une image vers Opus 5

### Verdict : NON EXÉCUTÉ

Je n'ai pas observé de requête fournisseur sur `main` ni sur `fix/misc`. Je ne conclus donc ni que le constat tient, ni qu'il est faux.

Préconditions vérifiées :

- dashboard réel : `GET http://localhost:3000/agents` → `200`;
- aucun agent affiché ne porte le modèle `claude-opus-5` (`0` occurrence dans la page rendue);
- le chat dashboard ne sait pas joindre un fichier : [`ChatClient.tsx:435`](../../apps/web/src/app/(dashboard)/chat/ChatClient.tsx#L435) affiche exactement `Attachments — not available yet`;
- le chemin image produit passe par Telegram ou Discord;
- aucune session navigateur contrôlable n'était disponible (`browsers.list()` → `[]`);
- aucune session Telegram ou Discord utilisable pour envoyer une vraie image au bot n'était accessible;
- la connexion DB read-only a également été refusée par le cluster actif avec le mot de passe courant puis legacy, empêchant de préparer ou auditer proprement un agent temporaire;
- aucun `OPENROUTER_API_KEY`, `GEMINI_API_KEY` ou équivalent n'était présent dans l'environnement shell.

Je n'ai pas basculé le worktree sur `main` : sans agent Opus 5 et sans canal capable d'envoyer l'image, changer de branche aurait uniquement permis de relire les deux listes — exactement la preuve statique que le protocole interdit de substituer à l'observation.

Ce qui reste nécessaire pour exécuter ce cas : un agent réel `claude-opus-5` doté d'une clé Anthropic active, un bot Telegram/Discord autorisé et une session capable de lui envoyer une image, puis une trace du corps fournisseur avant/après. Jusqu'à cette observation, la phrase « un agent Opus 5 ne pouvait pas recevoir d'image » reste **non validée expérimentalement**.

## Vérifications complémentaires

Comparaison machine de la liste régénérée :

```text
SCRIPT_EXIT=0
GENERATED=42
CURRENT=42
MISSING=0
EXTRA=0
OpenRouter: 421 models
models.dev: 10463 entries
```

Tests du paquet shared :

```text
Test Files  16 passed (16)
Tests       368 passed (368)
```

Aucun test automatisé ne référence `refresh-model-vision.mjs`; les deux comportements de panne ont uniquement été prouvés par les exécutions ciblées ci-dessus.

## Modifications locales

Aucun fichier produit n'a été modifié. Seul ce rapport a été ajouté.

