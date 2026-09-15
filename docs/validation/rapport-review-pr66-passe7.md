## Constats

- **R1 — important — FAUX VERT — `apps/runner/src/verification/document.ts:154`.** La fermeture YAML `...` échappe au retrait. Déclenchement :
  ```markdown
  ---
  # commentaire
  title: x
  ...
  corps sans titre
  ```
  **`runProof` retourne `green`, avec `well-formed:markdown` vert.** Le commentaire des métadonnées devient le titre. Cette fermeture est notamment admise par [Pandoc](https://pandoc.org/MANUAL.html#extension-yaml_metadata_block). Même résultat pour `+++\n# commentaire\ntitle = "x"\n+++\ncorps\n`, front-matter TOML employé par [Hugo](https://gohugo.io/content-management/front-matter/). Les nouveaux tests couvrent uniquement `---` fermé par `---`.

- **R2 — important — FAUX ROUGE — `apps/runner/src/verification/document.ts:154`.** Un front-matter vide peut faire avaler le vrai titre :
  ```markdown
  ---
  ---
  # Vrai
  ---
  corps
  ```
  **`runProof` retourne `red`.** L’expression exige deux sauts de ligne distincts entre les délimiteurs ; elle manque la fermeture immédiatement après l’ouverture et consomme jusqu’au troisième `---`, titre compris.

- **R3 — mineur — commentaires inexacts ; sens : ni faux vert ni faux rouge directement.**
  - `apps/runner/src/verification/document.ts:430` affirme encore qu’un sous-ensemble interne fait retenir uniquement `fatalError`. À `:440`, les erreurs restent retenues sauf plainte nommant une entité reconnue comme déclarée.
  - `:476–479` affirme que la primitive ne verra jamais changer la configuration d’un document ; `:488` incorpore pourtant l’empreinte du contenu.
  - `:497–499` présente la clé canonique comme chemin ouvert ; `:482` privilégie `displayPath`.
  - `:404` exclut tout métacaractère de regex des noms XML, alors que le point, discuté à `:391`, en est un.

## Les six questions

1. **tient.** Le correctif existe dans `5583d9c0` : normalisation à `document.ts:153`, retrait à `:154`, analyse du résultat à `:155`. Les trois nouveaux cas sont à `document.test.ts:355–357`.

2. **constat — R1 et R2.** Sondes exécutées :
   - YAML fermé par `...` et TOML `+++` : **faux verts**.
   - `---` seul : rouge attendu.
   - Ligne `  ---` dans un scalaire YAML indenté : rouge attendu, aucun titre fabriqué.
   - Bloc placé après de la prose : non retiré, `# titre` donne vert. Ce résultat ne constitue pas un défaut pour un contrat limité au front-matter initial ; accepter des métadonnées ailleurs demanderait de préciser le dialecte.
   - Front-matter vide suivi d’un titre puis d’un filet : **faux rouge R2**.

3. **tient, pour le refus de masquer ce diagnostic.** Les trois entrées suivantes rendent exactement `EntityRef: expecting ;` :
   - `<!DOCTYPE svg [<!ENTITY a.b "ok">]><svg>&a.b;</svg>`
   - `<svg>&a.b;</svg>`
   - `<svg>&foo</svg>`

   Le message seul ne permet pas de distinguer les cas. L’impossibilité générale est toutefois excessive : un parseur comprenant les références XML et le sous-ensemble interne pourrait les distinguer. Cela demande une autre capacité d’analyse, pas de supprimer ce diagnostic.

4. **constat — R1.** Le comportement C5 « métadonnées prises pour titre » reste possible sans casser le tableau actuel : **22 cas sur 22 donnent leur verdict attendu**, tandis que les variantes `...` et `+++` passent à tort. Les seize correctifs ne sont pas tous recertifiés par cette passe.

5. **constat — R3.** Les commentaires corrigés dans le commit le sont effectivement ; d’autres contradictions subsistent aux lignes indiquées.

6. **constat.** Nouveaux cas reproduits sur le source transpillé en mémoire, avec les vrais parseurs installés et les lectures de fichiers simulées pour `runProof`. Aucune suite Vitest complète exécutée ; aucun fichier modifié.

des constats