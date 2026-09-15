## Constats

- **R1 — important — FAUX VERT — `apps/runner/src/verification/document.ts:144`.** Le retrait du front-matter disparaît, mais aucun traitement YAML ne le remplace. Déclenchement :
  ```markdown
  ---
  # commentaire YAML
  title: x
  ---

  corps sans titre
  ```
  Le commentaire YAML devient un `heading` de profondeur 1. **`runProof` retourne `green`, avec `well-formed:markdown` vert**, en LF comme en CRLF. Le parent de `ec549645` refuse cette entrée : **régression confirmée**. Les tests de front-matter sans commentaire ne la détectent pas.

- **R2 — important, déjà signalé — FAUX ROUGE — `apps/runner/src/verification/document.ts:419`.** `<!DOCTYPE svg [<!ENTITY a.b "ok">]><svg>&a.b;</svg>` retourne toujours **`red`, `EntityRef: expecting ;`**. Le constat XML de la passe 5 reste reproduisible ; ce commit ne le modifie pas.

- **R3 — mineur — commentaires inexacts ; sens : ni faux vert ni faux rouge directement.** `apps/runner/src/tests/verification/document.test.ts:316` décrit encore une boucle de lignes ; `:360` affirme que les lignes sont blanchies. Ces mécanismes ont disparu. `apps/runner/src/verification/document.ts:378` affirme encore qu’une déclaration dans un commentaire ou une CDATA compte, alors que `:393` les retire.

## Les six questions

1. **tient.** Le remplacement de l’algorithme existe à `document.ts:144`, avec filtrage H1 à `:146`. `blankFencedBlocks` disparaît. Précision factuelle : le symbole `markdownHasTitle` subsiste à `:143`.

2. **constat — R1.** Faux vert reproduit dans le front-matter. Les sondes HTML brut, commentaire HTML, `&#35;`, tableau et tâche GFM restent rouges. Le BOM suivi de `# Titre` donne correctement vert. Les **19 entrées du tableau de régression** donnent les résultats attendus, mais ne couvrent pas R1.

3. **NON TRANCHÉ.** Dépendances présentes dans le manifeste et les importeurs du lockfile. Elles ne figurent pas dans `EXTERNALS` : le build prévoit donc leur incorporation au bundle, sans dépendance supplémentaire nécessaire dans le manifeste du pack. Cependant, le bundle en mémoire échoue sur un refus d’accès ; `deps:check` échoue avec `EPERM` en chargeant `semver`. **Installation propre, pack et smoke non validés.** Ces échecs ne prouvent pas une incompatibilité des nouvelles dépendances.

4. **constat — R1.** Le comportement C5 « métadonnées prises pour titre » redevient possible sans faire échouer les cas existants. Cela suffit à réfuter la couverture complète des correctifs ; les quinze correctifs ne sont pas tous recertifiés ici.

5. **constat — R3.** Des commentaires décrivent toujours des mécanismes absents ou contredisent le code actuel.

6. **constat.** R1 est nouveau et reproduit avant/après le commit. Sondes sur le source transpillé en mémoire, vrais parseurs installés et filesystem simulé pour `runProof`. Aucune suite Vitest complète exécutée.

des constats