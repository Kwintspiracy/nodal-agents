<!-- artifact: https://claude.ai/code/artifact/7844e194-d0c1-440d-8c84-7534fb429f6a -->

# PR A — Observabilité des sessions de code

Aujourd'hui, une session de code longue **rend un résultat amputé sans le dire**,
et pendant qu'elle tourne, l'onglet Code est **vide**.

Cette PR corrige les deux.

## Ce qu'elle change

| # | Ce qui change | Fichier | Pourquoi |
|---|---|---|---|
| **1** | Échouer fort quand la sortie a été tronquée | `code-task/process.ts` | un résultat amputé passe aujourd'hui pour complet |
| **2** | Lire le flux ligne par ligne au lieu de tout accumuler | `code-task/process.ts` | supprime la **cause** de la troncature |
| **3** | Écrire une ligne d'audit par outil, **pendant** l'exécution | `code-task/index.ts` | la session devient visible en direct |
| **4** | Afficher quel CLI a exécuté (`claude` ou `codex`) | onglet Code | on ne sait pas qui a fait quoi |
| **5** | Afficher modèle, effort et coût du tour | `actions.ts` + onglet Code | une jointure `cli_runs` les apporte |

Les points **1 et 2** sont un correctif de bug. Les **3 à 5** sont de
l'observabilité.

## Les trois défauts, en une ligne chacun

| Défaut | Preuve |
|---|---|
| La sortie est tronquée en usage normal | une session réelle a atteint **96 %** du plafond de 400 000 caractères, en mode texte — `code_task` utilise le mode JSON, plus verbeux |
| On perd la **fin**, pas le milieu | `process.ts:167-175` garde le début. La fin porte le résultat, l'usage et le coût |
| Personne n'est prévenu | le drapeau `truncated` est calculé (`process.ts:169`), transporté (`:243`), et **jamais lu** — zéro occurrence dans `index.ts` ou `providers.ts` |

C'est l'invariant #4 rompu à un endroit qui touche l'**audit** et la
**facturation**.

## Pourquoi la session est invisible pendant qu'elle tourne

`executeTool` écrit sa ligne d'audit **après** que l'outil a rendu la main. Un
`code_task` n'existe donc en base qu'une fois terminé — soit 10 à 20 minutes
d'écran vide.

Le chemin runtime, lui, écrit une ligne **par événement**, pendant l'exécution
(`run-job.ts`). D'où l'asymétrie observée : un agent qui **est** une CLI se voit
travailler ; un agent qui **appelle** une CLI est invisible.

Rien à inventer : les deux CLI émettent du JSON ligne par ligne, `code_task`
reçoit déjà ces morceaux, et le consommateur existe dans `run-job.ts`.

## Les mesures

Six sessions Codex réelles du 22/08, stdout brut :

| Session | Octets | Part du plafond |
|---|---:|---:|
| review #7, passe 1 | 384 110 | **96 %** |
| review #8, passe 1 | 198 806 | 50 % |
| review #8, passe 3 | 137 189 | 34 % |
| plan de test #8 | 63 213 | 16 % |

## Où est le provider

| Cas | Où il est | Reste à faire |
|---|---|---|
| `code_task` | paramètre **obligatoire** de l'outil → déjà dans `toolInput`, **déjà chargé** par la page | l'afficher |
| Runtime CLI | seulement dans `cli_runs.provider` | jointure sur `jobId` |

## Hors périmètre

| Sujet | Où ça va |
|---|---|
| Nommage « CLI » : outil contre runtime | **PR B** |
| Serveur MCP, délégation | **PR C** |
| Skills catalogue conscients de la surface | couche catalogue |

## Vérification

| # | Le test qui compte | Le test qui ne prouverait rien |
|---|---|---|
| 1 | Une sortie tronquée fait **échouer** le tour | vérifier que le drapeau existe |
| 3 | Lancer un `code_task` réel et voir des lignes **avant sa fin** | un unitaire sur le découpage JSONL |
| 4 | Une ligne `provider: 'codex'` affiche Codex, pas une valeur par défaut | vérifier que le badge existe |

**La mutation qui compte** : repasser `code_task` à l'écriture unique en fin
d'exécution doit faire **rougir** le test du point 3.

## Discipline

Branche dédiée, PR en brouillon dès le premier commit, plan de review pour Codex
avant `ready_for_review`. Voir `/revue-codex`.
