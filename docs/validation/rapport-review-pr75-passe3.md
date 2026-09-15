## Constats

**1. Important — faux vert de production : un refus de `stat` reste assimilé à une absence.**

`packages/tools/src/verification/observed.ts:72` retourne `ABSENT` pour **toute** erreur de `stat`. À la ligne 127, une empreinte lisible suivie de cette « absence » devient une modification.

Déclenchement : fichier inchangé, lisible avant l’appel, puis `stat` lève `EACCES` après un outil signalant un succès. La cible peut recevoir `produced=true` via `packages/tools/src/execute.ts:693`.

Reproduction en mémoire sur les fonctions extraites : **une cible créditée, aucun avertissement**. Le sens inverse, `EACCES` puis fichier lisible inchangé, donne le même résultat. C’est un **résidu préexistant**, pas une régression introduite par le troisième état : le correctif distingue les erreurs de `readFile`, mais pas celles de `stat`.

**2. Modéré — faux vert de visibilité pendant au plus 60 secondes : le cache conserve l’ancienne identité après une déclaration.**

`apps/runner/src/job/code-projects.ts:537` rend le scan en cache avant de relire les déclarations à la ligne 601. Le masquage compare ensuite cette ancienne clé à la clé actuelle par égalité, ligne 443.

Déclenchement :

1. `C:/w/app`, attaché sans manifeste, produit un scan nommé `C:/w/app/src`.
2. Pendant le TTL, le propriétaire déclare `C:/w/app` comme projet et le masque.
3. Le contexte conserve `app/src`, qui ne correspond pas à la clé masquée `app`.

Reproduction en mémoire : `app/src` avant déclaration, toujours `app/src` après déclaration et filtrage ; après vidage du cache, `app`. Le correctif ferme donc le désaccord à cache renouvelé, mais laisse cette fenêtre. Le nouveau test vide explicitement le cache (`apps/runner/src/tests/job/code-projects-context.test.ts:173`).

**3. Mineur — commentaires encore inexacts ; aucun faux vert/rouge d’exécution propre.**

- `apps/web/src/lib/code-projects.ts:186` présente le manifeste comme la **seule exception**, alors que la ligne 204 accepte une déclaration.
- `apps/runner/src/job/code-projects.ts:129` affirme la même exclusivité, contredite par la ligne 615.
- `packages/tools/src/projects/declared.ts:21` annonce **trois endroits** calculant une clé et partageant ce prédicat ; les six calculs ne passent pas tous par cette fonction.

Déclenchement : lecture de ces commentaires pour comprendre ou modifier la règle. Ils donnent une assurance documentaire fausse.

## Les six questions

| Question | Verdict |
|---|---|
| **1. Les correctifs existent-ils ?** | **tient** — trois états dans `observed.ts:56`, refus de lecture distingué à `:80`, comparaison prudente et avertissement à `:111`. Déclarations prises en compte dans le runner à `code-projects.ts:615`, dans le web à `code-projects.ts:204`, chargées par `workspace-roots.ts:72` et transmises par `actions.ts:12403` et `:13039`. Commentaires corrigés dans `intent.ts:292` et `attach.ts:395`. |
| **2. Septième calcul ou comparaison divergente ?** | **constat** — aucun septième calcul divergent trouvé, mais la comparaison entre identité mise en cache et identité actuelle reste incorrecte dans le constat nº 2. Les six calculs sont les deux résolutions d’intention, l’observation, l’attachement, le runner et le web. `written-file-type.ts:57` utilise aussi le résolveur, mais uniquement pour classifier ; il ne transmet pas sa clé. Les consommateurs examinés utilisent `projectKey` sur un projet déjà identifié. |
| **3. Trou avec le troisième état ?** | **constat** — résidu nº 1. Les cas demandés suivent bien la politique annoncée : illisible des deux côtés à taille égale → aucun crédit et avertissement ; illisible d’un seul côté → crédit seulement si les deux tailles connues diffèrent ; absent puis illisible → aucun crédit et avertissement. Aucun trou supplémentaire démontré dans ces branches. |
| **4. Masquage, lien, racines imbriquées dans le web ?** | **tient** — le passage des déclarations ne change ni la résolution lexicale des liens, ni le choix de la racine la plus profonde, ni le filtre des racines masquées (`code-projects.ts:248`, `:294`, `:300`). La déclaration intervient après le choix de la racine. Aucun changement indésirable identifié sur ces cas. |
| **5. Commentaires contredits par le code ?** | **constat** — nº 3. |
| **6. Rien de neuf ?** | **constat** — deux constats fonctionnels supplémentaires et des commentaires inexacts. |

Validation : lecture des commits et fichiers demandés, recherche transverse avec revue indépendante, reproductions en mémoire sans écriture. Aucune suite d’intégration exécutée.

des constats