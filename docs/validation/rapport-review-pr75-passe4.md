## Constats

**1. IMPORTANT — faux vert de visibilité : l’attachement d’une racine imbriquée échappe encore à l’invalidation du cache. Le constat tient.**

`apps/runner/src/job/code-projects.ts:566` accepte le cache sur la seule signature des déclarations. Les attachements sont lus après, à `:572`, alors qu’ils déterminent l’identité du projet à `:659`.

Déclenchement reproduit en mémoire sur le code du fichier :

1. `C:/w` attaché ; une écriture dans `C:/w/app/src/module/a.ts` fait annoncer `C:/w/app`.
2. Pendant le TTL, le propriétaire attache `C:/w/app/src`, puis le masque. Ces gestes modifient `agent_workspaces`, sans changer les déclarations.
3. Le contexte annonce toujours `C:/w/app` : le filtre à `:445` ne reconnaît pas ce parent comme appartenant au sous-arbre masqué.
4. Après vidage du cache, le contexte est vide.

**Résultat :** une activité désormais masquée continue d’alimenter le contexte pendant au plus 60 secondes. Résidu préexistant, comparable au constat nº 2 de passe 3. Aucun faux vert de `produced`, kill ou perte de données démontré ici ; **je ne le classe pas BLOQUANT**.

**2. MINEUR — commentaires résiduels inexacts. Le constat tient.**

- `apps/runner/src/job/code-projects.ts:12` résume encore la règle avec la seule exception du manifeste ; `:563` accepte aussi les déclarations.
- `packages/tools/src/tests/observed-unreadable.test.ts:13` affirme que seul `readFile` est remplacé et que `stat` reste réel ; `:38` remplace désormais aussi `stat`.
- `packages/tools/src/verification/produced.ts:16` situe l’appel hors du `try/catch` ; il est dans celui de `packages/tools/src/execute.ts:661`, à `:693`.

Déclenchement : lecture pour comprendre ou maintenir ces chemins. **Sens : aucun faux vert ou faux rouge d’exécution propre ; information documentaire erronée.**

## Les six questions

| Question | Verdict |
|---|---|
| **1. Les correctifs existent-ils ?** | **tient** — `observed.ts:78` réserve l’absence à `ENOENT`/`ENOTDIR`, `:88` distingue les autres erreurs ; `code-projects.ts:550` relit les déclarations, `:561` calcule leur signature, `:566` la compare. Les trois commentaires ciblés sont corrigés dans `declared.ts:23`, le runner à `:130` et le web à `:186`. |
| **2. Reste-t-il un faux vert dans écriture constatée → produced → declare_verification ?** | **tient** — aucun nouveau faux vert démontré dans cette chaîne. L’appel de production transmet bien les clés observées (`execute.ts:693`), le marquage filtre les livrables nommés et constatés (`produced.ts:52`, `:62`), puis la déclaration exige `addressed` et `produced` sur le bon triplet job/type/clé (`builtin/declare-verification.ts:143`, `:163`, `:177`). Les cibles dossier restent déclaratives, limite déjà explicitée dans `observed.ts:15`. |
| **3. La signature suffit-elle pour les gestes du propriétaire ?** | **constat** — nº 1. Le renommage et le masquage sont relus après le cache (`:414`, `:424`). Un changement de `kind`, une dé-déclaration ou une suppression changent l’ensemble sélectionné à `:550`. Mais un nouvel attachement imbriqué change aussi l’identité, sans modifier cette signature. |
| **4. Un code Windows signifiant « absent » manque-t-il ?** | **tient** — aucun identifié. Les erreurs Windows de fichier ou chemin introuvable sont traduites en `UV_ENOENT` par [libuv](https://github.com/libuv/libuv/blob/v1.x/src/win/error.c). Il ne faut pas ajouter les codes Win32 bruts à `estAbsence`. |
| **5. Reste-t-il un commentaire contredit par le code ?** | **constat** — nº 2, mineur. |
| **6. Rien de neuf ?** | **constat** — un résidu fonctionnel de visibilité et des commentaires inexacts ; aucun BLOQUANT démontré. |

Validation : lecture des commits et recherche transverse ; reproductions en mémoire du cache, de douze transitions de `stat` avec vérification des cibles et avertissements, et d’une modification de contenu à taille égale. Aucune écriture ni suite d’intégration exécutée.

des constats