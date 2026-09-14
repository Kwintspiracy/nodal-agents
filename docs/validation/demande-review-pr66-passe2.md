# Demande de review — PR #66, passe 2 (les correctifs des neuf constats)

La passe 1 post-merge a rendu neuf constats (`rapport-review-pr66-post-merge.md`).
**Les neuf ont été vérifiés à la source, les neuf tenaient, les neuf sont
corrigés**, un commit par constat, sur la branche `fix/review-debt-runtime`.
Cette passe relit LES CORRECTIFS, pas la PR d'origine.

Sandbox lecture seule. Deux verdicts valent : **le constat tient** (fichier,
ligne, ce qui casse, comment le déclencher) ou **le constat est faux**. « Ça a
l'air bien » ne compte pas.

Lire `git log --oneline origin/main..HEAD` puis chaque commit. Chaque message
dit le constat, la preuve, et la mutation.

## Ce que les correctifs affirment

| Constat | Commit | Ce qui a changé |
|---|---|---|
| C1 (bloquant) | `793aeef1` | `manifestHash` d'un document = règles + empreinte du fichier (taille, mtimeNs). La comparaison existante de `finalize.ts` refuse alors le vert si le fichier a bougé pendant la preuve. |
| C2 | `08a6f747` | `VerifierTarget.displayPath` (depuis `display_path_snapshot`) : la preuve ouvre le chemin réel, la clé reste l'identité. |
| C3 | `a3f84cc0` | `file_write` / `file_edit` lisent le type AVANT d'écrire, comme le hook. |
| C4 | `41fb8a66` | `projects/declared.ts` : une racine déclarée vaut manifeste, pour la clé comme pour le type — partagé par l'intention ET l'observation (#75). |
| C5 | `fb153d29` | Markdown ramené au LF ; blocs de code clôturés retirés avant de chercher le titre. |
| C6 | `6b1da443` | XML : le niveau `error` compte autant que `fatalError`. |
| C7 | `fec04208` | CSS : un antislash échappe le caractère suivant. |
| C8 | `4afb5abf` | HTML : `<script>` et `<style>` restent du texte brut DANS un `<svg>`. |
| C9 | `702add24` | Un handoff vide ne rend rien. |

**Un constat de la passe 1 était inexact et c'est dit dans le commit C8** : le
rapport affirmait que la sonde `<svg><style>…</style></svg>` passait et que
seul `foreignObject` échouait. Mesuré sur le vrai vérificateur, la forme
simple échouait aussi.

## Questions, par priorité

### P0 — les correctifs introduisent-ils pire que ce qu'ils ferment ?

1. **C1, le coût du vert.** `manifestHash` contient maintenant `mtimeNs`. Un
   job qui écrit un document puis le finalise : l'empreinte est-elle STABLE
   entre la transaction 1 et la transaction 2 quand PERSONNE n'écrit ? Un
   antivirus, un indexeur, un `stat` qui touche l'atime, une synchro cloud
   (OneDrive, Dropbox) peuvent-ils changer `mtime` sans changement de contenu —
   et rendre tout document éternellement `dirty` ? C'est le risque de
   régression le plus cher de ce lot : un vert qui ne peut plus jamais tomber.
2. **C1, la granularité.** L'empreinte est `size:mtimeNs`. Sur un système de
   fichiers dont le mtime a une granularité à la seconde, une réécriture de
   même taille dans la même seconde reste invisible. C'est dit dans le code.
   Est-ce le bon compromis, ou faut-il un hash du contenu ? Combien coûterait
   un hash sur un document de quelques Ko, deux fois par finalisation ?
3. **C4, la symétrie.** `projectRootPredicate` est injecté dans `intent.ts` ET
   `observed.ts`. En reste-t-il un TROISIÈME qui calcule une clé de projet avec
   `hasMarker` seul — `projects/attach.ts`, `written-file-type.ts`, l'écran
   Code, `finalize.ts` ? Un endroit oublié rend une clé différente des deux
   autres, et le symptôme est un `produced` faux ou une carte orpheline.
4. **C4, le coût en base.** `loadDeclaredCodeRoots` est appelé par
   `writeMutationIntent` ET par le seam d'observation, soit deux requêtes de
   plus par appel d'outil mutant, en plus des deux de
   `deliverableTypeForWrittenFile`. Sur une session à cinquante écritures, est-ce
   mesurable ? Une lecture par tour suffirait-elle, et où la mémoriser sans
   réintroduire un cache périmé ?
5. **C2, la portée.** `displayPath` est `string | null | undefined`. Tous les
   états ont-ils un `display_path_snapshot` ? Un état ANCIEN (écrit avant que
   la colonne soit remplie) retombe sur la clé : correct, ou faut-il le dire
   par un code ?

### P1 — les règles de forme

6. **C5, le retrait des blocs clôturés.** La regex
   `^[ \t]{0,3}(```+|~~~+)[^\n]*\n[\s\S]*?(?:^[ \t]{0,3}\1[ \t]*(?:\n|$)|$)/gm`
   utilise une rétro-référence : une clôture PLUS LONGUE que l'ouverture (permis
   par CommonMark) est-elle reconnue ? Un bloc indenté de quatre espaces (bloc
   de code indenté, pas clôturé) contenant `# x` compte-t-il encore à tort ?
   Un fichier dont le SEUL titre est dans une clôture jamais fermée ?
7. **C7, l'antislash.** La branche est posée AVANT le commentaire et la chaîne.
   Un antislash à l'intérieur d'un commentaire `/* \ */` ou juste avant la fin
   du fichier : la boucle sort-elle proprement ? Un antislash avant `*/` ne
   mange-t-il pas la fermeture du commentaire ?
8. **C8, le texte brut en contenu étranger.** Le mode est posé pour `script` et
   `style` même dans un `<svg>`, sauf auto-fermant. Un `<svg><style>` jamais
   refermé mange-t-il tout le reste du fichier en silence, et le verdict final
   dit-il quelque chose d'utile ? Et `<title>` dans un `<svg>` — resté hors de
   l'exception : est-ce le bon choix ?
9. **C6, le niveau `error`.** Sept entrées ont été sondées. En manque-t-il une
   qui produirait un `error` sur un SVG parfaitement valide (un espace de noms
   non déclaré, un attribut `xml:lang`, une DTD interne) et ferait rougir du
   travail correct ?

### P2 — les tests

10. Chacun des neuf correctifs a-t-il un test qui rougit VRAIMENT sans lui ?
    Lire les tests, pas les messages de commit. Celui de C2 (unitaire) assume
    de ne pas pouvoir montrer la conséquence sur un volume insensible à la
    casse : est-ce assumé au bon endroit, ou est-ce un test qui ne prouve rien ?
11. Le test de C1 enveloppe `runProof` du VRAI vérificateur pour écrire pendant
    la preuve. Prouve-t-il bien le chemin de `finalize.ts` (comparaison de
    `manifestHash`) et pas autre chose — par exemple la garde de génération ?
12. Le test de C4 assert `produced === true`. Est-ce la seule assertion qui
    lie les deux calculs de clé, ou reste-t-il un chemin où ils divergent sans
    qu'aucun test ne le voie ?

## Hors périmètre

Les PR #75, #73, #74, #91, #87, #77 (relues séparément) ; `apps/qa` ;
`apps/web/tests/e2e/` ; style, nommage.

## Ce dont je doute moi-même

Q1 : que `mtimeNs` soit stable quand personne n'écrit. Si ce n'est pas vrai
sous Windows, C1 transforme un vert périmé rare en un vert impossible — un
échange qui n'en vaut pas la peine.

## Forme du rapport

Les constats d'abord (fichier:ligne, comment le déclencher, gravité
bloquant / important / mineur), puis les douze questions avec « tient » /
« constat » / « NON TRANCHÉ ». Terminer par UNE ligne : « rien de neuf » ou
« des constats ».
