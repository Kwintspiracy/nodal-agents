Constats sur main `9f93e07f`. Sondes exécutées en mémoire sur le code actuel et les parseurs installés ; aucune suite DB ni validation Chrome/Firefox exécutée. Le correctif de test `ef5ecd81` (#87) est présent.

- **C1 — bloquant — `apps/runner/src/verification/document.ts:349`.** Une mutation inter-jobs peut laisser une preuve périmée **verte**. Déclenchement : A lit un document valide ; pendant la persistance du constat `utf8`, B pose son intention et remplace ce fichier par un contenu invalide ; A termine. L’intention de B incrémente uniquement l’état de B (`packages/tools/src/verification/intent.ts:629`), aucun epoch partagé du document. Les constantes passent la comparaison de `finalize.ts:479`, puis la génération inchangée de A passe la garde à `finalize.ts:509`.

- **C2 — important — `apps/runner/src/verification/document.ts:347`.** La clé en minuscules sert de chemin d’ouverture. Dans un dossier Windows sensible à la casse, écrire `Rapport.md` puis vérifier `rapport.md` produit un faux « not found », ou vérifie **un autre fichier** si les deux existent. Le commentaire à la ligne 356 suppose tous les fichiers Windows insensibles à la casse ; cette hypothèse exclut une configuration [explicitement supportée par Microsoft](https://learn.microsoft.com/en-us/windows/wsl/case-sensitivity).

- **C3 — important — `packages/tools/src/builtin/file-ops/file-write.ts:152`.** Le deuxième classement peut supprimer la clé d’une carte dont l’état existe comme document. Déclenchement sans concurrence : créer le premier `package.json` dans un dossier sans marqueur ni déclaration. Le hook retourne `document`, l’écriture crée le marqueur, puis `execute()` retourne sans `deliverable_key`. La carte ne retrouve plus sa vérification. L’attach conserve les anciennes cibles (`execute.ts:703`) et ne déclare pas ce projet (`projects/attach.ts:373`). Une modification concurrente du registre provoque le même désaccord ; `file-edit.ts:171` présente aussi cette fenêtre.

- **C4 — important — `packages/tools/src/verification/written-file-type.ts:54`.** Le projet déclaré décide du type, mais son identité n’est pas transmise au canonicaliseur. Déclenchement : racines `/w` et `/w/app`, projet `/w/app` déclaré `code`, aucun marqueur, écriture `/w/app/src/x.ts`. Sonde : type `code_project`, mais clé `/w/app/src`. L’intention et la finalisation ciblent ce sous-dossier au lieu du projet déclaré et de sa configuration.

- **C5 — important — `apps/runner/src/verification/document.ts:95`.** Le front-matter n’est retiré qu’avec des fins de ligne LF. Déclenchement : `---\r\ntitle: x\r\n---\r\ncorps`. `runProof` retourne **green**, avec `well-formed:markdown` vert, sans titre Markdown. Autre faux positif confirmé à la ligne 96 : un fichier contenant uniquement un bloc de code clôturé avec `# faux titre` dedans est accepté.

- **C6 — important — `apps/runner/src/verification/document.ts:302`.** Les erreurs XML non fatales sont ignorées. Déclenchement : `<svg>&undefined;</svg>`. Le parseur appelle bien `onError('error', 'entity not found:…')`, mais le filtre conserve seulement `fatalError`. `runProof` retourne **green**, y compris pour `well-formed:xml`.

- **C7 — important — `apps/runner/src/verification/document.ts:140`.** Une accolade échappée dans un identifiant CSS est comptée comme ouverture. Déclenchement : `.foo\{ { color: red; }`. Résultat reproduit : **red**, « `'{' opened at line 1 is never closed` ». L’accolade appartient pourtant au nom de classe : les caractères syntaxiques peuvent être [échappés dans un identifiant CSS](https://www.w3.org/TR/css-syntax-3/).

- **C8 — important — `apps/runner/src/verification/document.ts:238`.** Le compteur `foreign` ignore le retour au HTML dans `foreignObject`. Déclenchement : `<svg><foreignObject><style>.a::before { content: "<div>"; }</style></foreignObject></svg>`. Le vérificateur invente un `<div>` non fermé et rougit. Le parseur complet `parse5`, sondé sur la même entrée, place correctement `style` dans l’espace HTML et son contenu dans un unique nœud texte.

- **C9 — mineur — `apps/web/src/app/(dashboard)/spaces/Handoff.tsx:26`.** Avec `text=""`, l’état replié affiche quand même `·` et propose de déplier un contenu vide. Le séparateur dépend seulement de `open`, pas de la présence de texte.

Les treize questions :

1. **constat — C1.** Pour **le même job**, `writeMutationIntent` verrouille sa ligne, incrémente `dirty_generation` et remet `dirty` ; la transaction 2 compare cette génération et refuse le vert périmé. Pour **un autre job**, l’état est distinct et aucun epoch document ne change : la protection ne tient pas.

2. **tient.** `document.loadConfig` ne réalise aucune opération DB/disque et n’ajoute aucun verrou ni ordre concurrent. Une finalisation mixte peut attendre les verrous d’un autre vérificateur, mais cet appel document ne crée pas cette attente. L’incohérence inter-jobs relève de C1.

3. **constat — C2.** Le préfixe UNC est conservé par `projectKey` ; UNC ne signifie donc pas automatiquement chemin cassé. En revanche, ses composants sont également repliés en casse : aucune garantie pour un partage sensible à la casse. Le commentaire affirme l’hypothèse Windows, sans traiter son exception.

4. **constat — C3.** Oui : état `document` sans clé sur la carte, ou clé document sans état correspondant dans le sens inverse. Le registre n’est pas figé entre les deux classements.

5. **constat — C4.** Le cas exact du test cité **tient** : il crée préalablement `app/package.json`, et les deux résolutions choisissent la racine spécifique. La variante « projet déclaré sans marqueur » ne tient pas : type décidé par le parent déclaré, clé décidée séparément par les racines.

6. **constat — C3.** Le premier manifeste est `document` au hook. Dans le cas `/w/new/package.json`, la deuxième écriture sous `/w/new` devient `code_project` et permet la déclaration après succès. Le dépôt n’est donc pas bloqué définitivement, mais sa première carte perd sa clé et sa première écriture ne le déclare pas.

7. **constat — C8.** Les sondes `<svg><style>…</style></svg>`, script contenant `"</div>"`, template correctement fermé et `<p>a<div>b</div>` passent. Le `<p>` n’entre pas dans la pile ; `</div>` retire bien le `div`. Le retour au HTML sous `foreignObject`, lui, échoue.

8. **constat — C5.** Liste suivie de `---` et front-matter **LF** sont maintenant refusés : les anciens constats sont faux sur main. Le front-matter **CRLF** reste accepté comme titre.

9. **constat — C7.** `cssParses` et `css-tree` ont été retirés. Le test actuel exige exactement l’ouverture non refermée à la ligne 1 ; la sonde reproduit cette erreur. L’imbrication `@media` passe. Le défaut actuel concerne les échappements.

10. **constat — C6.** La signature est bien `(level, message, context)` ; les erreurs fatales passent par le callback puis lèvent, donc sont aussi capturées par `catch`. Le code installé traite les identifiants de DOCTYPE comme des données, sans résolution réseau/disque. Le problème confirmé est l’acceptation des erreurs de niveau `error`.

11. **NON TRANCHÉ.** Le code pose bien `dir="rtl"`, `truncate`, un `<bdi dir="ltr">` et le chemin complet en `title`, sur les deux usages. Cela ne constitue pas une preuve du rendu et de l’ellipse à gauche dans Chrome **et** Firefox ; aucun essai visuel des deux moteurs effectué.

12. **constat — C9.** `DisclosureButton` est un bouton natif avec `aria-expanded={open}` ; il reste monté lors du basculement, sans remplacement du bouton qui ferait perdre le focus. Le défaut confirmé est le séparateur et le dépliage à vide.

13. **tient.** Pour un document sale pendant le job, « Not yet verified » décrit correctement l’absence de preuve courante. Le libellé ne prétend ni que le job est terminé ni que la vérification a échoué. L’absence de note pour les fichiers de projet est intentionnelle ; C3 constitue l’exception défectueuse.

des constats