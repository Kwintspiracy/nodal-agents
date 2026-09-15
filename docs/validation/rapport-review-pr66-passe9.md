## Constats

- **R1 — important — FAUX VERT — `apps/runner/src/verification/document.ts:201`.** La conjonction accepte deux titres différents, chacun illégitime selon le contrat retenu :
  ````markdown
  ---
  # commentaire YAML

  ```
  ---
  # faux dans le code
  ```
  ````
  La lecture brute reconnaît le commentaire placé après l’ouverture — explicitement exclu comme titre par la passe 8. La lecture après retrait reconnaît le titre dans le code, dont l’ouverture a été supprimée à `:151`. Les deux booléens valent `true`, sans qu’un même titre légitime survive aux deux lectures. **`runProof` retourne `green`, avec `well-formed:markdown` vert.** C’est la combinaison des deux cas de passe 8, testés seulement séparément.

- **R2 — important — FAUX ROUGE — `apps/runner/src/verification/document.ts:201`.** Un en-tête YAML valide peut ouvrir un bloc de code dans la lecture brute et masquer un vrai titre situé après l’en-tête :
  ````markdown
  ---
  example: |
    ```
  ---
  # Vrai
  ````
  Le parseur YAML installé confirme que `example` contient la chaîne de trois backticks. Le titre appartient bien au corps du document, hors métadonnées et hors code. Pourtant, la lecture Markdown brute traite les backticks indentés comme une ouverture non refermée : `false`. Après retrait de l’en-tête : `true`. **`runProof` retourne `red`, avec `no title: expected a top-level heading`.**

## Les six questions

1. **tient.** Les correctifs existent :
   - Double lecture : `document.ts:194–202`.
   - Régressions de passe 8 : `document.test.ts:374` et `:380`. Les deux sondes rendent effectivement rouge, conformément à la décision demandée.
   - Commentaire du manifeste corrigé : `document.ts:50–57`, cohérent avec sa construction à `:536`.

2. **constat — R1.** Oui, selon la qualification du commentaire YAML expressément retenue par la demande. Deux témoins différents suffisent à rendre la conjonction vraie ; elle ne prouve pas qu’un titre légitime existe.

3. **constat — R2.** Oui. Le document reproduit possède un en-tête YAML valide et un vrai titre dans son corps. La lecture brute lui oppose une structure de code créée artificiellement par les métadonnées.

4. **constat — R1.** C5 reste accessible : un commentaire de métadonnées et un titre dans du code suffisent ensemble. Les **29 cas du tableau de régression Markdown passent**, malgré ce faux vert. Cela établit une lacune ; les dix-neuf correctifs ne sont pas intégralement recertifiés.

5. **constat — R2.** `document.ts:190` affirme : « Un titre qui n’apparaît qu’après le retrait était dans le code ». Le YAML valide de R2 réfute cette affirmation : le titre est dans le corps, et seuls les backticks appartiennent aux métadonnées.

6. **constat.** Deux défauts reproduits sur le source transpillé en mémoire, avec les vrais parseurs installés et les lectures de fichiers simulées pour `runProof`. Les 29 régressions ont été rejouées par cette méthode ; aucune suite Vitest complète exécutée, aucun fichier modifié.

des constats