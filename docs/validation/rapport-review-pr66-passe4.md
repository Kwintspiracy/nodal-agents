## Constats

- **R1 — important — `apps/runner/src/verification/document.ts:580`, `:594`.** L’empreinte couvre les octets lus, mais le constat `not-empty` porte encore sur un `stat` antérieur. Déclenchement : `race.css` contient `body{}` ; après le constat `exists`, un autre job vide le fichier ; la preuve lit ensuite zéro octet. **Reproduit : quatre constats verts, empreinte prouvée égale à l’empreinte finale du fichier vide.** `finalize.ts:495` accepte donc cette preuve. Le nouveau hash ne suffit pas à garantir que **tous** les constats décrivent son contenu.

- **R2 — bloquant — `apps/runner/src/job/finalize.ts:491`, `:494`.** L’epoch partagé du projet ne couvre pas une écriture dont l’intention précède la transaction 1. Ordonnancement permis par le code :
  1. B pose son intention et incrémente l’epoch à 8 (`packages/tools/src/verification/intent.ts:465`).
  2. B attend son checkpoint ; l’écriture vient ensuite (`packages/tools/src/execute.ts:636`, `:662`).
  3. A capture l’epoch 8, puis prouve l’ancien contenu.
  4. B écrit un contenu invalide.
  5. A relit l’epoch 8 et le même manifeste de commandes : **green périmé**.

  La génération de A reste inchangée. Il s’agit d’une faiblesse **préexistante**, pas créée par le champ facultatif, mais l’affirmation « son epoch suffit » est fausse. Ordonnancement établi par lecture du chemin d’exécution ; pas de reproduction DB.

- **R3 — important — `apps/runner/src/verification/document.ts:149`, `:158`, `:171`.** La boucle ignore les conteneurs Markdown et accepte trop de caractères après une clôture. Trois résultats reproduits :
  - `"- ~~~\n  # faux\n  ~~~\n"` → **green**, alors que le seul titre apparent appartient au code dans la liste.
  - `"- ~~~\n  code\n  ~~~\n\n# vrai\n"` → **red** : l’ouverture préfixée par `- ` est ignorée, puis sa clôture devient une ouverture qui absorbe le vrai titre.
  - `"~~~\ncode\n~~~\u00a0\n# faux\n"` → **green** : `trim()` accepte l’espace insécable comme fin de clôture. CommonMark autorise seulement espaces ordinaires et tabulations. [CommonMark — blocs clôturés](https://spec.commonmark.org/0.31.2/#fenced-code-blocks)

- **R4 — important — `apps/runner/src/verification/document.ts:448`.** La recherche de déclaration accepte une autre entité ou une déclaration inexistante :
  - `<!DOCTYPE svg [<!ENTITY x "ok">]><svg>&X;</svg>` → **green**. Le parseur nomme correctement `X`, mais le drapeau `i` trouve la déclaration de `x`. Les noms XML sont sensibles à la casse. [XML — comparaison des noms](https://www.w3.org/TR/xml/#sec-terminology)
  - `<!-- <!ENTITY x "ok"> --><svg>&x;</svg>` → **green**.
  - `<svg><![CDATA[<!ENTITY x "ok">]]>&x;</svg>` → **green**.

  Les trois sont reproduits. Le trou commentaire/CDATA est annoncé, mais **reste incompatible avec le contrat de XML bien formé et avec C6**.

- **R5 — important — `apps/runner/src/verification/document.ts:442`, `:474`.** Le parseur ne formule pas toutes les plaintes sur des références d’entités sous la forme attendue. Déclenchement :
  `<!DOCTYPE svg [<!ENTITY a.b "ok">]><svg>&a.b;</svg>`.
  **Reproduit : red**, avec `EntityRef: expecting ;`, malgré le point-virgule présent. Le parseur installé découpe mal cette référence ; l’exception ne reconnaît donc pas l’entité déclarée. `a.b` est pourtant un nom XML permis. Même diagnostic sondé pour `a:b` et `a-b`. [XML — production Name](https://www.w3.org/TR/xml/#NT-Name)

- **R6 — mineur — `apps/runner/src/verification/document.ts:78`, `:446`, `:464`, `:510`, `:531`.** Des commentaires contredisent toujours le code :
  - « une lecture de plus » : deux lectures supplémentaires via les deux `loadConfig` ;
  - « aucun métacaractère » dans un nom XML : le point est autorisé ;
  - « devant un sous-ensemble interne […] `fatalError` seul » : le filtre traite désormais chaque plainte ;
  - « ne verra jamais […] la configuration a bougé » : le hash sert précisément à cela ;
  - « le chemin est la clé canonique elle-même » : la preuve ouvre `config.subject`, alimenté prioritairement par `displayPath`.

## Les sept questions

1. **tient — les cinq correctifs de la passe 3 existent dans `d7f7456d`.**
   - R1 : champ dans `types.ts:113`, empreinte des octets lus dans `document.ts:594`, restitution à `:562`, comparaison dans `finalize.ts:491`.
   - R2 : boucle dans `document.ts:144`, règles d’ouverture à `:157`, fermeture à `:167`.
   - R3 : blanchiment à `document.ts:160` et `:172`.
   - R4/R5 : extraction du nom à `document.ts:442`, recherche de déclaration à `:448`, filtrage ciblé à `:474`.

   Leur présence tient ; leur suffisance est réfutée ci-dessus.

2. **constat — R2.** Pour une intention posée **entre** les deux transactions, l’epoch monotone ferme bien A → B → A : restaurer les fichiers ne restaure pas l’epoch. Mais une intention déjà commise avant la première lecture, suivie d’une écriture tardive, échappe au dispositif. Le test `finalize.test.ts:1117` incrémente pendant `runProof` ; il ne couvre pas cet ordonnancement. Ajouter simplement le hash du manifeste de commandes au résultat ne résoudrait pas cette faiblesse.

3. **constat — R3.** Résultats des sondes demandées :

   | Cas | Résultat |
   |---|---|
   | Bloc dans une liste, faux titre intérieur | **green à tort** |
   | Même structure, vrai titre extérieur | **red à tort** |
   | Ouverture en tildes, info contenant des tildes | **red**, correct sans titre extérieur |
   | Bloc avec fins de ligne CRLF | **red**, correct ; normalisation préalable |
   | Fichier constitué uniquement d’un bloc non fermé | **red**, correct |
   | Clôture suivie d’espaces puis d’un commentaire HTML | **red**, correct : cette ligne ne ferme pas le bloc |
   | Clôture suivie d’un espace insécable | **green à tort** |

4. **constat — R4, R5.** Avec `@xmldom/xmldom` **0.9.12 installé**, `one`, `two` et `_x` produisent des messages séparés `entity not found:&nom;`, correctement extractibles. Déclarer seulement `one` laisse bien la plainte sur `two` et rend rouge. En revanche, les noms ponctués produisent un autre diagnostic. Le trou commentaire/CDATA est confirmé et n’est pas acceptable pour déclarer C6 corrigé.

5. **constat.** C5 reste contournable par les listes et l’espace insécable ; C6 par la casse et les pseudo-déclarations. Les tests lus ne couvrent aucun de ces déclenchements. La course vers un fichier vide de R1 manque également. Les tests après-preuve et A → B → A ajoutés protègent leurs scénarios précis, mais pas l’ensemble des lectures effectuées par la preuve.

6. **constat — R6.** Plusieurs commentaires antérieurs restent inexacts ; celui sur le traitement global des erreurs XML est désormais directement contredit par le nouveau filtre.

7. **constat.** Des défauts supplémentaires sont reproduits. Sondes exécutées en mémoire sur le source transpillé, avec les vrais parseurs installés ; frontières filesystem simulées pour `runProof` et la course vers le fichier vide. Suites Vitest, architecture et intégration DB non exécutées dans ce sandbox en lecture seule.

la forme est en cause