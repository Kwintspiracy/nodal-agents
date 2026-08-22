<!-- artifact: https://claude.ai/code/artifact/7844e194-d0c1-440d-8c84-7534fb429f6a -->

# PR — voir ce qui se passe pendant une session de code

Une session de code tourne dix à vingt minutes. Pendant tout ce temps, l'onglet
Code est **vide**. Quand la ligne finit par apparaître, elle ne dit pas qui l'a
exécutée.

Trois manques, une seule question derrière : *qu'est-ce qui se passe, là,
maintenant, et qui le fait ?*

## 1 — Une session `code_task` est invisible tant qu'elle tourne

**Constat.** `executeTool` écrit sa ligne d'audit **après** que l'outil a rendu
la main (`Date.now() - startMs` le prouve). Un `code_task` n'existe donc en base
qu'une fois terminé.

Le chemin runtime, lui, découpe le flux et insère une ligne par outil **pendant**
l'exécution (`run-job.ts`, paire `tool_use` → `tool_result`). D'où l'asymétrie :
un agent qui **est** une CLI se voit travailler, un agent qui **appelle** une CLI
est invisible jusqu'au bout.

**Pourquoi ça compte.** C'est le pire moment pour être aveugle : on ne sait ni si
ça avance, ni si c'est parti de travers, ni même si c'est vraiment lancé — ce qui
pousse à relancer une session déjà en cours.

**Ce qui existe déjà.** Les deux CLI émettent du JSON ligne par ligne (`--json`
pour Codex, `stream-json` pour Claude). `code_task` reçoit déjà ces morceaux via
`child.stdout.on('data')` (`process.ts:178`) — il les **empile** au lieu de les
lire au fil de l'eau. Le consommateur existe aussi : `run-job.ts` fait exactement
ce travail.

Il n'y a rien à inventer, il y a à brancher.

**À vérifier avant de coder.** `process.ts` plafonne la capture
(`MAX_STDOUT_CHARS`). Si une session dépasse ce plafond, une partie du flux est
**déjà perdue aujourd'hui** — l'analyse au fil de l'eau ne ferait donc pas
qu'améliorer l'affichage, elle récupérerait de l'audit qu'on jette. À mesurer :
combien de caractères produit une session réelle, et à quelle fréquence le
plafond est atteint.

## 2 — On ne sait pas qui a exécuté

**Constat.** `cli_runs.provider` est enregistré à chaque tour, avec une
contrainte en base qui n'autorise que `'claude'` ou `'codex'`. La donnée est
propre et n'est **jamais affichée**.

L'onglet Code est construit depuis `tool_calls`, pas `cli_runs` :
`provider` n'y est sélectionné nulle part.

**La distance au correctif diffère selon le cas :**

| Cas | Où est le provider | Reste à faire |
|---|---|---|
| `code_task` | paramètre **obligatoire** de l'outil, donc dans `toolInput`, **déjà chargé** par la page | l'afficher |
| Runtime CLI | seulement dans `cli_runs.provider` | jointure sur `jobId` |

**Pourquoi ça compte, au-delà du confort.**

- **Sécurité** : la PR #6 a établi que Codex et Claude ne se comportent pas
  pareil sur cette machine, jusqu'à la sandbox. Savoir lequel a tourné change la
  lecture de ce qui s'est passé.
- **Coût** : les deux consomment l'abonnement du propriétaire, pas le même. Une
  session dont on ignore l'exécutant est une dépense inattribuable.

Un audit d'exécution qui n'enregistre pas qui a exécuté n'est pas un audit.

## 3 — Le tour n'affiche ni modèle, ni effort, ni coût

La jointure du point 2 les apporte gratuitement : `cli_runs` porte déjà `model`,
`effort`, `cost_usd`, les tokens et `duration_ms`.

## Ce qui n'est PAS dans cette PR

| Hors périmètre | Où ça va |
|---|---|
| La confusion de nommage « CLI » (outil vs runtime) | copie UI, PR séparée |
| Le serveur MCP de délégation | PR d'architecture |
| Les skills catalogue conscients de la surface | couche catalogue |

## Vérification

| # | Le test qui compte | Le test qui ne prouverait rien |
|---|---|---|
| 1 | Lancer un `code_task` réel et **voir des lignes apparaître avant sa fin** | un unitaire sur le découpage JSONL |
| 2 | Une ligne `code_task` avec `provider: 'codex'` affiche bien Codex, pas une valeur par défaut | vérifier que le badge existe |
| 3 | Mesurer le volume de stdout d'une session réelle vs `MAX_STDOUT_CHARS` | — |

Plus : la mutation qui compte — repasser `code_task` à l'écriture unique en fin
d'exécution doit faire **rougir** le test du point 1. Sans ça, le test ne prouve
rien.

## Discipline

Branche dédiée, PR en brouillon dès le premier commit, plan de review pour Codex
avant `ready_for_review`, et un plan de test si la lecture ne suffit pas — voir
`/revue-codex`.
