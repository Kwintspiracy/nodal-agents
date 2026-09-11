# Demande de review — PR #66 « Créer, c'est prouver », 1re passe (HEAD `b98c6a12`)

Branche `feat/creer-c-est-prouver`, 1 commit au-dessus de `origin/main`
(`c37885be`). Sandbox lecture seule. Deux verdicts : **le constat tient**
(fichier, ligne, ce qui casse, comment le déclencher) ou **le constat est
faux**. « Ça a l'air bien » ne compte pas.

Lire d'abord `docs/plans/creer-c-est-prouver.md` (le plan, et sa section « Ce
que la vérification a corrigé »), puis `git show b98c6a12`.

## Ce que la PR affirme

1. `apps/web/.../spaces/FileDiff.tsx` `FileName` : nom devant, dossier derrière
   tronqué par la gauche (`dir="rtl"` + `<bdi dir="ltr">`), chemin complet en
   `title`. Utilisé sur la ligne dépliable ET sur la ligne d'un fichier lu
   (`ConversationFeedView.tsx`).
2. `apps/web/.../spaces/Handoff.tsx` : composant client, `DisclosureButton`,
   texte dans le flux replié comme déplié.
3. `packages/tools/src/verification/written-file-type.ts` : `code_project` si
   le fichier est sous un projet déclaré (`registered_at` non nul, `kind =
   'code'`) OU si sa racine (`resolveProjectRoots`) porte un manifeste
   (`hasMarker`) ; sinon `document`. Le chemin est rebasé sur la racine
   lexicale avant. `file-write.ts` / `file-edit.ts` l'appellent dans
   `resolveMutationTargets` ET dans `execute()` (pour poser `deliverable_key`
   sur la sortie, donc sur la carte). `intent.ts` canonicalise `document`
   comme `office_file` (le fichier lui-même).
4. `apps/runner/src/verification/document.ts` : `loadConfig` toujours `ready`
   (`commands: []`, `manifestHash` constant, `epoch: 0`, `subject` = la clé) ;
   `runProof` émet jusqu'à quatre `ProofCommandRecord` (`exists`, `not-empty`,
   `utf8`, `well-formed:<type>`), arrêt au premier rouge. `ReadyConfig` gagne
   `subject?: string` (`types.ts`). Branché dans `registry.ts`.
5. `ApprovalActions.tsx` en anglais.

## Questions, par priorité

### P0 — la finalisation et la concurrence

1. `finalize.ts` compare `current.epoch` / `current.manifestHash` après la
   preuve pour détecter « la configuration a bougé ». Pour un document, les
   deux sont CONSTANTS : une réécriture du fichier PENDANT la preuve est-elle
   attrapée par la garde de génération (`dirtyGeneration`), ou peut-on obtenir
   un `green` sur un contenu qui n'est plus celui du disque ? Tracer le chemin
   exact : `writeMutationIntent` → `dirty_generation` → `finalize` transaction 2.
2. `document.ts` `loadConfig` est appelé DANS la transaction 1 sous les verrous
   `code_projects` pris par les autres vérificateurs (ordre type/clé). Il ne
   prend aucun verrou et ne lit rien : y a-t-il un ordre d'appel où il
   provoque quand même une attente ou une incohérence ?
3. `canonicalKey` d'un document = `projectKey(path)` = chemin REPLIÉ EN CASSE
   sur Windows. `runProof` ouvre le fichier PAR CETTE CLÉ. Sur un volume Windows
   sensible à la casse (possible depuis Windows 10 par dossier), ou sur un
   chemin UNC, la clé désigne-t-elle encore le fichier ? Est-ce dit quelque part ?

### P1 — le typage

4. `deliverableTypeForWrittenFile` est appelé DEUX fois par écriture (hook +
   execute). Entre les deux, le registre peut changer (P5b déclare des projets
   à l'attach, qui court APRÈS l'exécution ; un autre job peut déclarer). Un
   écart entre le type de l'état posé et la présence/absence de
   `deliverable_key` sur la carte est-il possible ? Quel serait le symptôme ?
5. Le rebasage lexical : `rebaseOntoLexicalRoots` est appelé avec
   `deliverableType: 'document'` uniquement pour porter le chemin. Puis
   `classifyWrittenFile` refait `resolveProjectRoots` avec le chemin rebasé.
   Cas des DEUX racines qui se contiennent (test « la plus SPÉCIFIQUE nomme le
   projet » dans `intent.test.ts`) : le type rendu est-il cohérent avec la clé
   que l'intention posera ?
6. `attach.ts:373` ne déclare (P5b) que les cibles `code_project`. Avec la
   nouvelle règle, quel est le PREMIER fichier d'un dépôt neuf qui devient
   `code_project` ? Le `package.json` lui-même (sa racine porte-t-elle déjà le
   manifeste au moment du hook, AVANT l'écriture) ? Si non, le dépôt se
   déclare-t-il quand même à la deuxième écriture ?

### P2 — les constats

7. `htmlCloses` : les modes RAWTEXT ne sont posés que hors contenu étranger
   (`foreign === 0`). Un `<style>` dans un `<svg>` inline ? Un `<script>`
   contenant la chaîne `</div>` hors svg est-il bien lu comme du script ?
   Un `<template>` ? Un `<p>` qui contient un `<div>` (la norme ferme le `<p>`
   implicitement — le `<div>` reste dans la pile : est-il compté à tort comme
   non fermé quand `</div>` arrive ?).
8. `markdownHasTitle` : le setext accepte `-+` sous une ligne — une ligne de
   liste `- item` suivie de `---` (règle horizontale) passe-t-elle pour un
   titre ? Un front-matter YAML `---` en tête de fichier ?
9. `cssParses` : `css-tree` en mode tolérant rapporte-t-il vraiment
   l'accolade jamais refermée du test, ou l'erreur trouvée est-elle autre (le
   test n'exige que « une erreur avec une ligne ») ? Une `@media` imbriquée
   valide en CSS moderne (nesting) est-elle rapportée comme erreur ?
10. `xmlParses` : `@xmldom/xmldom` 0.9 — `onError` reçoit-il bien
    `(level, message)` dans cette version, ou le constat repose-t-il seulement
    sur le `catch` ? Une entité externe / un DOCTYPE dans un SVG : le parseur
    tente-t-il de résoudre quelque chose (réseau, disque) ?

### P3 — l'écran

11. `FileName` : `dir="rtl"` sur un `span` avec `truncate` — le texte contient
    des `/`, `.`, `-`, `_`. Avec `<bdi dir="ltr">` à l'intérieur, l'ordre des
    caractères est-il garanti dans Chrome ET Firefox ? Le point de troncature
    (`…`) tombe-t-il bien à GAUCHE ?
12. `Handoff.tsx` : `aria-expanded`, focus, et le `·` séparateur quand le
    texte est vide.
13. `DeliverableNote` s'affiche sous un fichier `document` ; un fichier
    `code_project` n'a pas de clé donc rien. Un fichier `document` dont l'état
    est `dirty` (job encore en cours) affiche « Not yet verified » : est-ce le
    bon mot pendant que le job tourne encore ?

## Hors périmètre

Le coût d'un tour de chat ; les commandes découvertes dans le canal (v7-C) ;
le vérificateur d'envoi (`outbound_action`) ; style, nommage.

## Forme du rapport

Constats (fichier:ligne, déclenchement, gravité bloquant / important / mineur),
puis les treize questions avec « tient » / « constat » / « NON TRANCHÉ ».
Terminer par UNE ligne : « rien de neuf » ou « des constats ».
