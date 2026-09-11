Review limitée à `daf9421c` et `a2d6b60f`, avec reproductions Node depuis le contenu exact du commit.

**Constat — Gravité moyenne : un test commenté en fin de ligne reste une revendication active.**  
[apps/qa/lib.mjs:680](D:/APPS/NodalAI/apps/qa/lib.mjs:680)

Déclenchement :
```js
it('x', () => { /* … */ }); /* it('mort @cap:x', () => {}) */
```
`titresDeTest` retourne `["x", "mort @cap:x"]`. Le nouveau filtre ignore le commentaire final, puis le scan reconnaît le test qu’il contient. Une capacité exigée peut donc conserver une revendication après suppression de son seul test actif, et échapper au contrôle « capacité exigée sans preuve ».

Aucune occurrence de cette forme trouvée dans les **588 fichiers de test suivis** au commit `a2d6b60f` : défaut reproduit, sans impact actuel identifié.

Les trois questions :

1. **constat** — Oui, le test commenté est lu comme vivant : reproduction ci-dessus. La recherche du motif demandé dans les fichiers suivis ne retourne rien.

2. **tient** — Sans aucun `*/` ultérieur, la regex ne correspond pas : elle **ne supprime pas** la fin du fichier. Le contenu reste scanné. Aucun ouvreur en tête de ligne sans fermeture ultérieure trouvé dans les tests suivis. Si un template contient cet ouvreur et qu’un `*/` apparaît plus loin, une suppression reste possible ; c’est un cas différent, déjà possible avant ces deux commits.

3. **tient** — `number` est explicitement demandé dans les deux commandes et identifie l’élément dans son dépôt ; les commandes exposent ce champ dans leur sortie JSON ([issues](https://cli.github.com/manual/gh_issue_list), [PR](https://cli.github.com/manual/gh_pr_list)). Dans [collect.mjs:327](D:/APPS/NodalAI/apps/qa/collect.mjs:327), issues et PR passent par **deux fusions séparées**. Reproductions conformes : un seul numéro conservé, fermé prioritaire, `null` si une liste manque, `[]` pour deux listes vides.

La limitation des clés `#n` est désormais explicitement documentée. Vitest tenté mais bloqué au démarrage par une dépendance `pathe` introuvable ; les reproductions Node ont abouti. Aucun fichier modifié.

des constats