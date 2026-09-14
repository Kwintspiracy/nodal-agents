# Demande de review — PR #74 « Une personnalité qui nomme un outil absent », post-merge

Commit `3ec6b191`, mergé le 13/09 **sans passe Codex** (dette de revue,
issue #88). Il est dans `main`.

Sandbox lecture seule. Deux verdicts valent : **le constat tient** (fichier,
ligne, ce qui casse, comment le déclencher) ou **le constat est faux**.

Lire `git show 3ec6b191`, puis `packages/tools/src/personality-tools.ts`,
son test, et `apps/runner/src/job/execute.ts` autour de la ligne où
`PERSONALITY_NAMES_ABSENT_TOOLS` est journalisé.

## Ce que la PR affirme

1. `toolsNamedButAbsent({ personality, available, known })` rend les noms
   **connus du registre**, **cités comme mot entier** dans la personnalité, et
   **absents de la liste du job** — triés, sans doublon.
2. Le mot entier est défini par un lookbehind/lookahead sur `[A-Za-z0-9_]`.
3. Le runner journalise au démarrage, **après** le calcul de la liste
   (invariant #9). Le job n'est **pas** refusé.
4. Six tests sur la règle, un de câblage par le vrai `executeJob`.

## Questions, par priorité

### P0 — la correction de la règle

1. **Le lookbehind.** `(?<!…)` est-il supporté par toutes les cibles de build
   du paquet `tools` (Node de production, `target` du tsconfig, et le
   navigateur si ce module est jamais importé côté web) ? Une cible sans
   lookbehind lève une `SyntaxError` **à l'exécution de la regex**, donc au
   démarrage d'un job. Si le module n'est importé que côté runner, le dire.
2. **Le coût.** La boucle compile une `RegExp` par nom du registre, à chaque
   démarrage de job. Combien de noms `registry.list()` rend-il en pratique ?
   Négligeable ou mesurable ?
3. **Le faux positif.** La liste du registre contient-elle un nom qui est
   aussi un mot courant (`notify`, `search`, `code`, `task`, `remember`…) ?
   Une personnalité en anglais le citerait sans nommer d'outil. Lister les
   noms du registre concernés.
4. **La casse.** La regex est sensible à la casse : `Code_Task` n'est pas
   détecté. Voulu ou trou ?

### P1 — le câblage

5. `agentRow.personality` : le schéma Drizzle garantit-il une chaîne ? Si la
   colonne est `jsonb` ou nullable d'un autre type, `text.trim()` casse.
6. Le point d'insertion est-il bien **après** le calcul définitif de
   `toolDefs` — y compris les outils ajoutés par les skills, les approbations
   et les serveurs MCP ? Un outil ajouté plus tard produirait un
   avertissement faux.
7. `registry.list()` contient-il les outils MCP dynamiques ? Sinon, une
   personnalité qui cite un outil MCP absent n'est jamais signalée : le trou
   est-il dit quelque part ?
8. Un `console.warn` est-il lisible par le PROPRIÉTAIRE dans le produit (page
   Logs / service logs), ou seulement dans la sortie du processus ? Si c'est
   le second, la PR ne tient pas sa promesse (« le propriétaire peut
   maintenant le lire »).

### P2 — les tests

9. Le test de câblage passe-t-il par le VRAI `executeJob` et lit-il la ligne
   journalisée, ou vérifie-t-il un simple appel ? (Invariant #5.)
10. Y a-t-il un test « personnalité vide/nulle » et un test « l'outil est
    présent ⇒ rien » ? Retirer le filtre `available.has(name)` fait-il rougir ?

## Hors périmètre

L'assignation de skills à Dev C ; l'UI ; style, nommage.

## Ce dont je doute moi-même

Q3 (faux positifs sur des noms qui sont des mots courants) et Q8 (le journal
est-il vraiment lisible par le propriétaire).

## Forme du rapport

Les constats d'abord (fichier:ligne, déclenchement, gravité bloquant /
important / mineur), puis les dix questions avec « tient » / « constat » /
« NON TRANCHÉ ». Terminer par UNE ligne : « rien de neuf » ou « des constats ».
