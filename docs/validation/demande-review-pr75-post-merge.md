# Demande de review — PR #75 « Une écriture se constate sur le disque », post-merge

Commit `5c5e4101`, mergé le 13/09 **sans passe Codex** (dette de revue,
issue #88). Il est dans `main`. Le code a bougé depuis : `cfdf6631` (PR #87) a
corrigé une attente de son test.

Sandbox lecture seule. Deux verdicts valent : **le constat tient** (fichier,
ligne, ce qui casse, comment le déclencher) ou **le constat est faux**. « Ça a
l'air bien », « conforme aux bonnes pratiques », « je confirme » ne comptent
pas.

Lire `git show 5c5e4101`, puis le code d'aujourd'hui :
`packages/tools/src/verification/observed.ts`, `produced.ts`, `intent.ts`,
`execute.ts` (section 3), `packages/tools/src/projects/markers.ts`.

## Ce que la PR affirme

1. Avant l'appel de l'outil, `snapshotFileTargets` prend l'empreinte des
   cibles de `kind === 'file'` : `{ size, mtimeNs }` en `bigint`, `null` si
   absent ou si ce n'est pas un fichier.
2. Après un succès, `changedFileTargets` reprend l'empreinte ; une différence
   = écriture constatée. `observedDeliverableKeys` traduit ces fichiers (plus
   les cibles `dir`, restées **déclaratives**) en clés de livrables, avec la
   même règle de nommage que l'intention et **sans expansion**.
3. `markDeliverablesProduced` ne marque `produced` que les livrables nommés
   dont la clé est dans cet ensemble ; les autres sont journalisés
   `VERIFICATION_PRODUCED_NOT_OBSERVED` et **ne sont pas** produits. Le
   paramètre est optionnel : omis, l'ancien contrat (tout ce qui est nommé).
4. Conséquence voulue : `declare_verification` n'accorde plus à un outil
   menteur le droit de déclarer comment on vérifie ce projet.
5. Prouvé par le vrai `executeTool` dans `intent.test.ts`.

## Déjà trouvé et corrigé — à relire aussi

Les questions 6 et 7 (la symétrie des clés entre l'intention et l'observation)
ne sont plus hypothétiques : le défaut existait, il a été MESURÉ en corrigeant le
constat C4 de la revue de #66, et il est fermé sur cette branche.

Ce qui se passait : un projet DÉCLARÉ sans manifeste donnait le bon TYPE mais
une clé de sous-dossier. En câblant la déclaration dans l'intention seule, le
test est reparti au rouge sur `produced` — le seam d'observation calculait
encore l'ancienne clé, donc un fichier réellement écrit sur le disque passait
pour non produit. Les deux calculs partagent maintenant un seul prédicat
(`packages/tools/src/projects/declared.ts`).

**Ce correctif fait partie du périmètre de cette review.** Le prédicat est-il
appliqué PARTOUT où une clé de projet se calcule, ou en reste-t-il un troisième
endroit qui répondrait autrement ?

## Questions, par priorité

### P0 — le faux négatif, et ce qu'il coûte

1. **L'empreinte rate une écriture.** `size` + `mtimeNs` identiques = « rien
   écrit ». Sur quels systèmes de fichiers `mtimeNs` de `stat({bigint:true})`
   a-t-il une granularité RÉELLE inférieure à la seconde ? NTFS, ext4, APFS,
   un montage réseau (SMB/NFS), un volume Docker sous Windows. Si la
   granularité est la seconde, une réécriture de même taille dans la même
   seconde est-elle indistinguable ? Le commentaire ne parle que de « la même
   nanoseconde » : est-ce une sous-estimation du risque ?
2. **Le faux négatif est-il silencieux ?** Quand `produced` reste faux à tort,
   que perd l'utilisateur exactement ? Tracer : `produced = false` →
   `declare_verification` refuse ? → la carte du livrable ? → un job
   légitime est-il bloqué ? Un `console.warn` est-il la seule trace ?
3. **Cible fichier qui n'existe ni avant ni après.** `same` est vrai quand
   `was === null && now === null` : le fichier n'existe pas. Mais un outil
   dont la cible est un fichier SUPPRIMÉ (`file_delete` ou équivalent, s'il
   existe) : la suppression est un changement (`was !== null`, `now === null`)
   ⇒ produit. Est-ce voulu ? Un livrable « produit » par une suppression.
4. **L'ordre `filesBefore` / mutation.** `snapshotFileTargets` est appelé
   AVANT `tool.execute`, mais APRÈS quoi exactement ? `resolveMutationTargets`
   et `writeMutationIntent` tournent-ils avant ? Si un checkpoint/snapshot est
   pris entre les deux et touche le fichier (copie, restauration), l'empreinte
   bouge sans que l'outil ait écrit ⇒ faux positif. Vérifier le chemin réel.
5. **Deux outils concurrents.** Deux appels d'outil du même job, en parallèle
   (le sont-ils ?), visant le même fichier : A prend l'empreinte, B écrit, A
   écrit rien, A constate un changement ⇒ A est crédité. Est-ce possible dans
   le runner ?

### P1 — les clés

6. `observedDeliverableKeys` fait `rebaseOntoLexicalRoots` sur les fichiers
   changés puis `resolveProjectRoots` avec `hasMarker`. `markDeliverablesProduced`
   compare par `d.key` — les clés produites par `writeMutationIntent` et par
   `observedDeliverableKeys` sont-elles calculées par le MÊME chemin ? Le
   commentaire dit « sans expansion » : où l'intention expanse-t-elle, et une
   clé expansée peut-elle exister côté intention sans jamais apparaître côté
   observé, rendant un livrable légitime définitivement non produit ?
7. Casse Windows : les clés passent-elles par `projectKey` (repli de casse) des
   deux côtés ? Une divergence de casse entre les deux ensembles serait un
   faux négatif systématique et invisible.
8. Un fichier visé dont `deliverableType` est `document` (typage de #66) :
   passe par `officeFileDeliverables`. Le filtre est `!== 'code_project'` —
   couvre-t-il tous les types existants aujourd'hui (`DeliverableType`) ou un
   type nouveau tomberait-il là par défaut, à tort ?

### P2 — le seam et le contrat

9. `markDeliverablesProduced` rend `false` quand `constates.length === 0`.
   L'appelant (`execute.ts`) utilise-t-il cette valeur ? Une branche a-t-elle
   changé de sens silencieusement ?
10. `filesBefore ?? new Map()` : si `mutationTargets` est absent, l'observation
    ne tourne pas du tout — mais le bloc est-il atteignable avec
    `mutationTargets` non nul et `filesBefore` nul ? Code mort ou garde utile ?
11. Le paramètre `observedKeys` optionnel : quels appelants restants ne
    l'observent PAS, et est-ce assumé ou un oubli ? Les lister.
12. Les cibles `dir` sont ajoutées aux clés observées **sans aucune
    vérification**. Un outil shell qui dit avoir écrit et n'écrit rien reste
    donc « produit ». La PR le dit. Mais : le cas de #60 (l'outil menteur)
    est-il en pratique un shell ? Autrement dit, le trou documenté ne
    couvre-t-il pas justement le cas que la PR prétend fermer ?

### P3 — le test

13. `intent.test.ts` « une écriture qui ment » : force-t-il un vrai
    `tool.execute` qui rend un succès sans écrire, ou mocke-t-il ? La mutation
    annoncée (retirer l'observation du seam ⇒ rouge) tient-elle en lisant le
    test ? Le test voisin « écriture RÉELLE » dépend-il du timing (écriture et
    empreinte dans la même milliseconde) — est-il potentiellement instable ?

## Hors périmètre

Le typage `document`/`code_project` lui-même (PR #66) ; le vérificateur de
document ; le coût d'un tour de chat ; style, nommage, formulation des
commentaires.

## Ce dont je doute moi-même

La granularité de `mtimeNs` selon le système de fichiers (Q1) et l'étanchéité
des clés entre intention et observation (Q6-7). Si l'un des deux cède, la PR
produit des faux négatifs silencieux — ce qui est pire que le bug qu'elle
corrige.

## Forme du rapport

Les constats d'abord (fichier:ligne, comment le déclencher, gravité
bloquant / important / mineur), puis les treize questions avec « tient » /
« constat » / « NON TRANCHÉ ». Terminer par UNE ligne : « rien de neuf » ou
« des constats ».
