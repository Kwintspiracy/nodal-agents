## Constats

**1. Important — faux vert de visibilité : deux calculs de projet ignorent encore les déclarations.**

`apps/runner/src/job/code-projects.ts:146` utilise seulement `hasMarker`. `apps/web/src/lib/code-projects.ts:198` utilise seulement `hasProjectMarker`.

Déclenchement : `C:/w/app` attaché, déclaré comme projet de code sans manifeste ; écriture de `C:/w/app/src/x.ts`. Les deux fonctions rendent **`C:/w/app/src`**, contre **`C:/w/app`** pour l’intention et l’observation. Résultat reproduit en mémoire avec les fonctions du dépôt.

Ces chemins sont effectivement utilisés : scan du runner (`code-projects.ts:619`), liste web (`actions.ts:12398`) et détail (`actions.ts:13030`). La lecture ultérieure du registre ne corrige pas l’identité.

Sens concret : si `app` est masqué comme projet, le runner laisse passer `app/src`, car le filtre compare les clés par égalité (`code-projects.ts:431`). Un projet censé être retiré du contexte reste annoncé. Cela ne démontre pas un faux vert des tests de vérification.

**2. Important — faux vert de production : une erreur de lecture devient une écriture constatée.**

`packages/tools/src/verification/observed.ts:54` lit le contenu ; le `catch` à la ligne 56 transforme toute erreur en `null`. La comparaison à la ligne 82 traite ensuite une empreinte valide suivie de `null` comme un changement.

Déclenchement : fichier lisible avant l’appel, contenu inchangé, seconde lecture refusée ou en erreur, outil signalant un succès. La cible entre dans `changedFileTargets`, puis peut recevoir `produced=true` via `packages/tools/src/execute.ts:693`.

Reproduction en mémoire : `stat` réussit aux deux passages, seule la seconde lecture lève `EACCES` ; la fonction retourne la cible comme modifiée. C’est un trou neuf : cette lecture n’existait pas auparavant. Deux lectures refusées donnent inversement `null → null`, donc un **faux rouge** si une écriture réelle a eu lieu.

**3. Mineur — commentaires donnant une assurance fausse ; aucun faux vert/rouge d’exécution propre.**

- `packages/tools/src/verification/intent.ts:292` affirme encore qu’une racine sans manifeste ne conserve aucune clé correspondante. Le correctif conserve justement une racine déclarée sans manifeste.
- `packages/tools/src/projects/attach.ts:395` affirme que seules les racines à manifeste arrivent au registre ; le prédicat accepte désormais aussi les déclarées.
- `packages/tools/src/verification/observed.ts:45` définit `null` comme « absent », alors qu’il signifie aussi dossier ou erreur de lecture.

## Les six questions

| Question | Verdict |
|---|---|
| **1. Les trois correctifs existent-ils ?** | **tient** — `b82ccfa8` : SHA-256 calculé dans `observed.ts:54`, comparé à la ligne 83. `f4c361b9` : prédicat utilisé dans `intent.ts:181`, transmis à la ligne 303. `96bb483b` : prédicat chargé dans `attach.ts:385`, utilisé pour résolution et filtrage aux lignes 389–390. |
| **2. Un cinquième calcul oublié ?** | **constat** — nº 1 : il en reste au moins deux, dans le runner et le web. |
| **3. Un trou neuf avec l’empreinte ?** | **constat** — nº 2. Le remplacement par un dossier et le suivi des liens symboliques existaient déjà avec `stat`. Un fichier énorme est maintenant chargé entièrement en mémoire ; le coût est assumé, mais une erreur de lecture rejoint le même `catch`. **NON TRANCHÉ** pour un seuil concret d’épuisement mémoire. |
| **4. Régression des garanties de la passe 32 ?** | **tient** — garanties conservées à la lecture : filtre fichier dans `attach.ts:380`, transaction à la ligne 220, rollbacks aux lignes 271, 280 et 315. `register.ts:120` réserve la mise à jour aux lignes non déclarées. Une déclaration préexistante ne devient donc pas une nouvelle déclaration à annuler. |
| **5. Commentaires contredits par le code ?** | **constat** — nº 3. |
| **6. Rien de neuf ?** | **constat** — deux constats fonctionnels et des commentaires inexacts. |

Validation : lecture des trois commits, du rapport précédent et des chemins concernés ; reproductions en mémoire sur les fonctions extraites du dépôt. Aucune suite d’intégration exécutée en lecture seule. Issue #102 exclue.

des constats