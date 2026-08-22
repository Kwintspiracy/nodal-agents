<!-- artifact: https://claude.ai/code/artifact/7844e194-d0c1-440d-8c84-7534fb429f6a -->

# PR A — Observabilité des sessions de code

Aujourd'hui, une session de code longue **échoue** avec un message qui accuse le
CLI, alors que la cause est notre propre plafond de capture. Et pendant qu'elle
tourne, l'onglet Code est **vide**.

Cette PR corrige les deux.

## Ce qu'elle change

| # | Ce qui change | Fichier | Pourquoi |
|---|---|---|---|
| **1** | Lire le flux ligne par ligne au lieu de tout accumuler | `code-task/process.ts` | supprime le plafond, donc **supprime la panne** |
| **2** | Dire « sortie tronquée » au lieu de « JSON invalide » | `code-task/process.ts` | le message actuel accuse le CLI au lieu du plafond |
| **3** | Écrire une ligne d'audit par outil, **pendant** l'exécution | `code-task/index.ts` | la session devient visible en direct |
| **4** | Afficher quel CLI a exécuté (`claude` ou `codex`) | onglet Code | on ne sait pas qui a fait quoi |
| **5** | Afficher modèle, effort et coût du tour | `actions.ts` + onglet Code | une jointure `cli_runs` les apporte |

Le point **1** est le correctif de fond. Les **2 à 5** rendent visible ce qui ne
l'était pas.

## Ce qui se passe quand le plafond tombe

Le tour **échoue** — vérifié dans les trois cas, aucun ne passe en silence :

| Cas | Erreur rendue |
|---|---|
| `claude` : un seul objet JSON, coupé | `stdout is not valid JSON` |
| `codex` : coupe en milieu de ligne | `non-JSON line in JSONL stream` |
| `codex` : coupe sur une fin de ligne | `stream ended without turn.completed` |

Le problème n'est donc pas le silence, c'est **le coût et le mensonge** :

- la session a tourné 10 à 20 minutes, a peut-être écrit des fichiers, et rend
  une erreur d'analyse ;
- le message accuse le **CLI**, alors que la cause est **notre plafond** ;
- le drapeau `truncated` est calculé (`process.ts:169`), transporté (`:243`) et
  **jamais lu** — il permettrait précisément de nommer la vraie cause.

Le plafond est frôlé en usage normal (voir les mesures), donc ces échecs
arrivent.

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
