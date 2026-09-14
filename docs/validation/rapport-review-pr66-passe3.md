## Constats

- **R1 — bloquant — `apps/runner/src/verification/document.ts:85`, `:510`.** Le hash ne lie toujours pas la preuve au contenu vérifié. Déclenchement : transaction 1 hache `oops\n` ; un autre job écrit `# ok\n` ; `runProof` lit ce titre et retourne **green** ; l’autre job rétablit `oops\n` avant la transaction 2. **Reproduit : preuve verte et manifestes identiques.** La comparaison de `apps/runner/src/job/finalize.ts:490` accepte donc ces valeurs ; la génération du premier job n’a pas changé. Le correctif ferme le résidu taille/mtime, mais cette succession A → B → A conserve un vert périmé.

- **R2 — important — `apps/runner/src/verification/document.ts:156`.** La regex accepte des clôtures interdites et des ouvertures inexistantes :
  - `"```\ncode\n```~\n# faux\n"` retourne **green** : la clôture mixte est invalide, le titre reste dans le code. Même défaut avec `"~~~\ncode\n~~~`\n# faux\n"`.
  - `"``` info`x\n# vrai\n"` retourne **red** : une info contenant un backtick interdit cette ouverture ; le titre est extérieur.
  - `"\t```\n# vrai\n"` retourne **red** ; `"```\ncode\n\t```\n# faux\n"` retourne **green**. Une tabulation initiale représente quatre colonnes, pas une indentation autorisée pour ces clôtures.

  Verdicts reproduits. Ces règles sont explicites dans [CommonMark](https://spec.commonmark.org/0.31.2/#fenced-code-blocks).

- **R3 — important — `apps/runner/src/verification/document.ts:157`, `:160`.** Supprimer entièrement un bloc fabrique un titre setext entre deux lignes auparavant séparées. Déclenchement : `"texte\n```\ncode\n```\n---\n"`. Le vérificateur transforme cela en `"texte\n---\n"` et accepte un titre inexistant : **green**. Initialement, le document contient un paragraphe, un bloc de code puis un filet horizontal. Reproduit sur la fonction extraite du fichier. [CommonMark](https://spec.commonmark.org/0.31.2/#setext-headings)

- **R4 — important — `apps/runner/src/verification/document.ts:396`, `:401`.** La détection désactive **toutes** les erreurs non fatales sans établir qu’une entité est déclarée. Deux déclenchements reproduits, tous deux **green** :
  - `<!DOCTYPE svg []><svg>&nope;</svg>`
  - `<!-- <!DOCTYPE svg [ --> <svg>&nope;</svg>`

  Un sous-ensemble vide suffit ; un simple commentaire suffit également. Une chaîne dans une section CDATA produit le même contournement. C6 est donc rouvert : une entité inconnue passe pour du XML bien formé.

- **R5 — important — `apps/runner/src/verification/document.ts:396`.** La détection manque un sous-ensemble interne si l’identifiant système contient `>` entre guillemets. Déclenchement : `<!DOCTYPE svg SYSTEM "urn:a>b" [<!ENTITY x "ok">]><svg>&x;</svg>`. Résultat reproduit : **red**, `entity not found:&x;`. Le caractère `>` est autorisé dans la production XML `SystemLiteral` ; il ne termine pas le DOCTYPE à cet endroit. Le faux rouge de la passe 2 subsiste pour cette forme. [XML 1.0 — littéraux](https://www.w3.org/TR/xml/#sec-common-syn)

- **R6 — mineur — `apps/runner/src/verification/document.ts:77`, `:435`, `:458`.** Plusieurs commentaires contredisent le code :
  - « une lecture de plus » : ce sont **deux** lectures supplémentaires par finalisation ;
  - « ne laisse rien passer » : R1 le réfute ;
  - « ne verra jamais “la configuration a bougé” » : le manifeste sert désormais précisément à cela ;
  - « le chemin est la clé canonique elle-même » : `runProof` utilise `config.subject`, alimenté prioritairement par `displayPath`.

## Les sept questions

1. **tient — présence des trois correctifs.** SHA-256 du contenu à `document.ts:85–87` ; fin d’input et clôture plus longue à `:156` ; exception XML à `:396–401`. Leur présence est établie, leur suffisance est réfutée par R1 à R5.

2. **constat — R2, R3.** Résultats des sondes demandées :

   | Cas | Résultat |
   |---|---|
   | Bloc entièrement indenté de quatre espaces, seul faux titre dedans | **red**, correct |
   | Même bloc suivi d’un vrai titre extérieur | **green**, correct |
   | Clôture indentée de trois espaces, vrai titre après | **green**, correct |
   | Ouverture `~~~`, tentative de clôture avec trois backticks | **red**, correct |
   | Info contenant un backtick après une ouverture en backticks | **red** à tort |
   | Deux blocs successifs, uniquement des titres dans le code | **red**, correct |
   | Vrai titre entre deux blocs | **green**, correct |
   | Bloc dans une citation `>`, sans titre extérieur | **red**, correct |
   | Même citation suivie d’un vrai titre extérieur | **green**, correct |

   La regex ne retire pas les blocs préfixés par `>` ; ces exemples passent parce que la recherche de titre ignore également ces lignes. Les sondes supplémentaires trouvent les clôtures mixtes, les tabulations et le titre setext fabriqué.

3. **tient sur le coût linéaire ; NON TRANCHÉ pour un seuil opérationnel précis.** Pour un fichier de taille N : **3N octets lus**, dont **2N hachés**. Mesure locale, SHA-256 seul sur buffers déjà en mémoire, moyenne de dix passages : environ **0,45 ms/Mio**, **4,17 ms/10 Mio**, **42 ms/100 Mio**. À 100 Mio, les deux hashes ajoutent donc environ **84 ms**, hors lectures et allocations, dans les transactions.

   Des centaines de Mio peuvent compter ; le Gio davantage. `file_write` et `file_edit` limitent leur sortie à **1 Mio** (`workspace.ts:54`), mais le vérificateur n’impose aucun plafond au fichier reçu. Son contrat ne garantit donc pas « quelques kilo-octets ». Aucun benchmark disque distant ni test de charge effectué.

4. **constat — R4, R5.** Le `>` dans un identifiant système cité entraîne un faux négatif. Commentaires et CDATA entraînent des faux positifs ; un `[` dans un identifiant système peut également être pris pour le début du sous-ensemble. Une chaîne brute dans un attribut correspond à la regex, mais ma sonde reste **red** : le `<` non échappé déclenche une erreur fatale. La forme échappée `&lt;!DOCTYPE…` ne correspond pas. Le trou effectivement reproduit est l’acceptation d’entités inconnues par suppression globale des erreurs non fatales.

5. **constat.** C1 et C6 restent contournables par R1 et R4 ; C5 par R2 et R3. Les tests lus ne couvrent pas ces déclenchements. Le nouveau test de hash change la longueur identiquement, mais ne fige pas le mtime : il ne distingue pas à lui seul SHA-256 d’une empreinte taille+mtime.

   Par ailleurs, les constats **R4/R5 de la passe 2** figurent bien dans son rapport et restent présents : `intent.ts:176` conserve `hasMarker` seul et `code-projects.ts:198` conserve sa dérivation distincte. `e3e7735b` ne les modifie pas.

   Sondes exécutées en mémoire avec le vrai vérificateur et le parseur installé ; pour les dernières variantes Markdown, fonction extraite du source. Suites Vitest et intégration DB non exécutées dans ce sandbox en lecture seule.

6. **constat — R6.** Les commentaires sur les lectures, la détection de changement et le chemin d’ouverture sont obsolètes. À `document.ts:395`, « le crochet ouvrant […] déclare des entités » est également faux : un sous-ensemble peut être vide ou ne déclarer que des éléments.

7. **constat.** De nouveaux défauts sont reproduits ; la condition « rien de neuf » n’est pas remplie.

des constats