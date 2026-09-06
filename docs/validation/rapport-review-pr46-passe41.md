## Réponses aux questions

1. **L’égalité stricte améliore nettement la garde, mais la liaison n’est pas encore sûre.**

Le refus évoqué dans la demande est acceptable : si l’agent propose « Veille IA », appelle `register_project({ path: "veille-ia" })` sans transmettre `name: "Veille IA"`, la création passe simplement par la carte d’approbation. C’est un échec sûr résultant du non-respect de la consigne.

En revanche, l’égalité sur le nom d’affichage produit encore une autorisation indue :

**[P0, bloquant, déduit sans exécution] — `packages/tools/src/builtin/register-project.ts:152`**

Les noms d’affichage ne sont ni uniques ni liés au chemin. Or le prompt propose également les projets existants par leur nom. Le scénario suivant crée donc silencieusement une destination que l’utilisateur n’a pas choisie :

```text
Projet existant proposé : « Notes » → chemin existing-notes
Option choisie : « Notes »
register_project({ path: "new-notes", name: "Notes" })
```

`accepted` contient `notes`; la réponse vaut également `notes`; la garde autorise alors `new-notes`, bien que l’utilisateur ait sélectionné le projet existant. Le schéma confirme que seule la clé dérivée du chemin est unique, pas `display_name` (`packages/db/src/schema/code-projects.ts:77` et `:135`).

La liaison doit donc porter sur une option de création non ambiguë ou sur une autorisation structurée associant explicitement la réponse au chemin. L’égalité textuelle avec un nom d’affichage ne suffit pas.

2. **Je ne recommande pas de replier les espaces internes.**

« Veille  IA » entraînant une carte d’approbation est bénin et sûr. Comme l’agent contrôle à la fois l’option et les paramètres de l’appel, la consigne d’égalité exacte est suffisante. Réduire tous les espaces élargirait encore les équivalences et donc les collisions possibles, sans résoudre le défaut de liaison ci-dessus.

3. **La passe 40 n’est pas close.**

Les quatre constats explicites de la passe 40 sont techniquement corrigés, mais le P0 conserve une variante bloquante : un nom choisi ne désigne pas nécessairement le chemin créé.

## Vérification de chaque constat de la passe 40

- **P0 — correspondance par sous-chaîne : correction locale confirmée.**  
  `packages/tools/src/builtin/register-project.ts:177` utilise désormais `accepted.has(fold(r.answer))`. « Add notes to the README » n’autorise donc plus `notes`, et le test correspondant se trouve dans `packages/tools/src/tests/builtin/register-project.test.ts:634`.  
  Toutefois, le problème de liaison n’est pas entièrement clos à cause de la collision entre le nom d’un projet existant et celui d’une nouvelle destination décrite ci-dessus.

- **P1 — `rmdir` avalait toutes les erreurs : traité.**  
  `packages/tools/src/builtin/register-project.ts:378` ignore uniquement `ENOTEMPTY` et `ENOENT`. Les autres codes positionnent `rollbackFailed` et sont journalisés avec `PROJECT_ROLLBACK_DIR_FAILED`.

- **P1 hors demande — échec du rollback SQL muet : traité.**  
  `packages/tools/src/builtin/register-project.ts:357` intercepte l’échec de suppression, journalise `PROJECT_ROLLBACK_ROW_FAILED` et fait rendre `;rollback_failed`.

- **P2 — `limit(50)` sans ordre : traité.**  
  `packages/tools/src/builtin/register-project.ts:174` applique `orderBy(desc(resolvedAt))` avant la limite. Le test avec 61 questions est présent dans `packages/tools/src/tests/builtin/register-project.test.ts:665`.

## Constats hors demande

**[P0, bloquant, déduit sans exécution] — `packages/tools/src/builtin/register-project.ts:152`**

Une option correspondant au nom d’un projet existant peut autoriser la création d’un autre chemin portant le même `name`. L’autorisation reste donc liée à un libellé non unique plutôt qu’à la destination approuvée.

Je n’ai pas exécuté les tests afin de ne pas utiliser l’arbre de travail non committé. La revue porte sur `git show 147159ff` et sur les cinq fichiers lus via `git show HEAD:<chemin>`.

## Constats bloquants

- Collision de noms : sélectionner un projet existant peut autoriser silencieusement la création d’un autre chemin portant le même nom — `packages/tools/src/builtin/register-project.ts:152`.