# Plan de test — PR #8

Branche `fix/harness-bugs`. À exécuter **après** `rapport-review-pr8.md`, et
seulement sur ce que la lecture n'a pas pu trancher.

Ce document n'est pas une seconde review. La review a rendu 7 constats ; ceux
qui suivent sont les seuls que personne n'a **exécutés**. Un constat déduit est
une hypothèse bien argumentée, pas un fait.

**Tu peux écrire dans le dépôt** (`workspace-write`). Chaque test qui mute un
fichier dit comment revenir en arrière, et tu confirmes `git status` propre à la
fin.

**Règle qui prime sur tout le reste : un test que tu ne peux pas exécuter se
rapporte NON EXÉCUTÉ.** Ne conclus jamais par lecture ce que ce document te
demande de mesurer. C'est le résultat le plus utile que tu puisses rendre quand
l'environnement manque.

---

## T1 — les mutations, réellement appliquées

Le rapport a conclu que deux mutations resteraient vertes, sans les appliquer.
Je les ai exécutées depuis et j'obtiens `30/30, code 0` — mais **une suite de ce
dépôt est instable** (voir T4), donc un seul run ne prouve rien.

| # | Mutation | Attendu | Ce que l'inverse prouverait |
|---|---|---|---|
| T1a | `run-chat.ts` : `personality: systemPrompt` → `agentRow.personality` | **reste verte** (trou de couverture) | un test couvre le câblage chat — dire lequel |
| T1b | `run-job.ts` : idem | **reste verte** | idem côté job |
| T1c | `system-prompt.ts` : retirer `'cli-runtime'` de la condition du bloc builtin | **rougit** | l'assertion ne mord pas |
| T1d | `system-prompt.ts` : neutraliser `identityLine` | **rougit**, 1 seul test | le test d'identité ne mord pas |

Commande, pour chaque mutation :

```bash
pnpm test --force
```

`--force` est obligatoire : sans lui Turborepo sert le cache et le résultat ne
veut rien dire.

**Lance chaque mutation DEUX fois.** Si les deux runs divergent, c'est T4, pas
un verdict.

Restauration : `git checkout -- <fichier>` après chaque mutation.

## T2 — le prompt réellement produit

Les constats 1 à 4 du rapport disent que le prompt ordonne des outils absents
(`assign_<agent>`, `skill_view`, `save_memory`, `file_write`). Ils ont été
établis en lisant les **constructeurs de blocs**, jamais un prompt assemblé.

Produis un prompt `surface: 'cli-runtime'` réel — le plus simple est d'ajouter
un test temporaire dans `packages/orchestration/src/tests/` qui appelle
`buildSystemPrompt` sur l'agent semé par `cli-runtime-surface.test.ts` et écrit
le résultat dans un fichier hors dépôt.

Puis compte, dans ce texte :

| Chaîne | Présente ? |
|---|---|
| `assign_` | |
| `create_task` | |
| `list_tasks` | |
| `return_result` | |
| `skill_view` | |
| `run_skill_script` | |
| `save_memory` | |
| `query_memory` | |
| `mark_memory_outdated` | |
| `file_read` / `file_write` / `file_edit` / `file_list` / `file_search` | |

Rends le **compte exact par chaîne**, et pour les trois premières occurrences de
chacune, la phrase qui l'entoure. Ce que je veux savoir précisément : est-ce
mentionné comme un **fait** (« l'équipe existe ») ou comme une **consigne**
(« appelle `assign_X` ») ? La différence décide du correctif.

Donne aussi la **taille du prompt en caractères**, et celle de la seule
`personality` — c'est le coût que la PR ajoute à chaque tour, et que la review
n'a pas pu chiffrer.

Restauration : supprimer le test temporaire.

## T3 — un agent CLI peut-il déléguer, oui ou non ?

C'est LA question que la review a soulevée sans la trancher, et elle décide du
sort de la PR.

Le constat 1 dit que l'orchestrateur voit ses sous-agents sans pouvoir les
appeler. Si c'est exact, le bénéfice affiché de la PR est nul et il faut le
dire.

Trace, dans `apps/runner/src/cli-runtime/`, ce qui se passe quand la session
Claude Code produit du texte contenant `assign_<agent>` :

1. `runClaudeTurn` expose-t-il un quelconque outil Nodal à la session ? Lis
   l'argv réellement construit, pas la documentation.
2. `--disallowedTools` retire des outils : y a-t-il un mécanisme symétrique qui
   en **ajoute** ?
3. Existe-t-il un chemin, même indirect (MCP, hook, fichier surveillé), par
   lequel une délégation demandée par le CLI atteindrait le dispatcher Nodal ?

Verdict attendu : **oui / non / partiellement**, avec le fichier et la ligne. Si
c'est non, dis-le franchement — c'est une capacité manquante, pas une
formulation de prompt à corriger.

## T4 — la suite est-elle instable ?

J'ai observé `28/30` deux fois aujourd'hui et `30/30` sur les mêmes commits.
Une suite instable rend tout le reste de ce document douteux : on ne distingue
plus un rouge causé par une mutation d'un rouge de contention.

```bash
pnpm test --force
```

Trois fois de suite, sans rien modifier. Rapporte les trois résultats.

Si une divergence apparaît, isole la suite fautive et dis si l'échec est lié à
pglite (contention sur la base éphémère) ou à autre chose. Ne la corrige pas :
identifie-la.

## Ce qui n'est pas demandé

Corriger quoi que ce soit. Réécrire le prompt. Donner un avis sur le design.
Les quatre tests ci-dessus produisent des mesures ; les décisions viennent
après.

## Format du rapport

Une section par test. Pour chacun : la commande lancée, la **sortie brute**
(pas ton résumé), et le verdict. Les tests non exécutés apparaissent avec leur
raison, et ne sont pas comblés par du raisonnement.

Termine par `git status` pour confirmer que l'arbre de travail est propre.
