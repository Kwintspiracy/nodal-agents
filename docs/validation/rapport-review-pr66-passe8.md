## Constats

- **R1 — important — FAUX VERT — `apps/runner/src/verification/document.ts:149`.** Un délimiteur situé dans un bloc de code est pris pour la fermeture d’un front-matter :
  ````markdown
  ---

  ```
  ---
  # faux
  ```
  ````
  Le document original ne contient aucun titre selon `remark-parse`. La boucle retire pourtant tout jusqu’au deuxième `---`, ouverture du bloc comprise. **`runProof` retourne `green`, avec `well-formed:markdown` vert.** Le comportement C5 de la passe 1 réapparaît : un titre dans du code suffit à valider le document.

- **R2 — important — FAUX ROUGE — `apps/runner/src/verification/document.ts:149`.** La même recherche peut supprimer un vrai titre :
  ````markdown
  ---
  # Vrai

  ```
  ---
  ```
  ````
  Le parseur reconnaît un titre dans le document original. Le retrait consomme ce titre jusqu’au filet situé dans le code. **`runProof` retourne `red`**, avec `no title: expected a top-level heading`.

- **R3 — mineur — commentaire inexact ; sens : ni faux vert ni faux rouge directement — `apps/runner/src/verification/document.ts:50`.** Le commentaire présente le manifeste comme la version des règles et affirme qu’il ne change que lorsque ce fichier de code change. Une simple modification du document change pourtant le manifeste produit à **`:524`**, via `fileStamp`. Ce commentaire décrit encore le manifeste constant antérieur à C1.

## Les cinq questions

1. **tient.** Les correctifs existent :
   - YAML fermé par `...` et TOML : `document.ts:138`, recherche à `:149`.
   - En-tête vide : recherche dès la deuxième ligne, à `:148`.
   - Cinq cas ajoutés : `document.test.ts:362`, `:363`, `:364`, `:367`, `:369`.
   - Quatre commentaires corrigés : `document.ts:435`, `:457`, `:507`, `:532`.

2. **constat — R1 et R2.** Sondes exécutées :
   - Ouverture `  ---` : **vert**, texte conservé.
   - Ouverture `---`, fermeture `+++` : **vert**, texte conservé.
   - Ces deux verts ne suffisent pas à établir une erreur : **NON TRANCHÉ** pour leur qualification comme métadonnées ; ils ne correspondent pas aux délimiteurs reconnus par le contrat actuel.
   - `---\n---\n` seul : **rouge**, absence de titre.
   - CRLF isolé : **rouge**, absence de titre.
   - Fichier vide : **rouge**, arrêt à `not-empty`.
   - Fermeture dans un bloc de code : **faux vert R1**, et **faux rouge R2**.

3. **constat — R1.** Oui : C5 reste reproductible sans faire échouer les **27 cas sur 27** du tableau de régression Markdown actuel. Aucun cas de ce tableau ne combine un filet initial et un délimiteur dans du code. Les dix-sept correctifs ne sont pas intégralement recertifiés par ces sondes.

4. **constat — R3.** Le commentaire du manifeste contredit toujours sa construction actuelle.

5. **constat.** Nouveaux défauts reproduits sur le source transpillé en mémoire, avec les vrais parseurs installés et les lectures de fichiers simulées pour `runProof`. Aucune suite Vitest complète exécutée ; aucun fichier modifié.

des constats