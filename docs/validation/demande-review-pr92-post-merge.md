# Demande de review — PR #92 (`qa/triage-parcours-rouges-2`), relue APRÈS merge

## Pourquoi cette demande existe

La PR #92 a été mergée dans `main` le 13/09 **sans passe Codex** — le binaire
était indisponible. Dette suivie par l'issue #88. Les commits sont dans `main` ;
la branche `qa/triage-parcours-rouges-2` est conservée pour délimiter le
périmètre. Un constat fondé se corrigera par une nouvelle PR : rends des
constats **exécutables** (fichier, ligne, cas de casse).

## Le périmètre exact

Plage : `d9ff2490..6ddef802` (8 commits) sur `qa/triage-parcours-rouges-2`.

Fichiers, **et rien d'autre** :

- `apps/web/tests/e2e/agent-tool-assignment.spec.ts` (le gros du lot)
- `apps/web/tests/e2e/agent-recipes.spec.ts`
- `apps/web/tests/e2e/brique31-flows.spec.ts`
- `apps/web/tests/e2e/mcp-connectors.spec.ts`
- `apps/web/tests/e2e/tools-tab.spec.ts`
- `apps/web/tests/e2e/webhooks-flows.spec.ts`

**Aucun code produit n'est touché.** Si tu penses qu'un constat impose d'en
toucher, dis-le explicitement : ça deviendra une issue produit, pas un correctif.

## Ce que la PR affirme

Neuf parcours réparés, et — c'est sa différence avec la #84 — **tous rejoués sur
une pile isolée**, pas seulement relus. Chaque commit prétend nommer une cause
constatée à l'exécution :

1. un picker portant **deux** boutons « Close » (croix d'en-tête + pied) ;
2. l'onglet Skills qui ne liste plus que l'ATTACHÉ, la bibliothèque ayant
   déménagé dans la modale « + Attach skills » (décision du 24/08) ;
3. un bouton de ligne nommé « Rotate secret », pas « Rotate » ;
4. les skills devenus des **lignes de tableau** et non des cartes ;
5. « 2 tools discovered » déplacé dans la modale ;
6. le formulaire de création d'agent qui exige un modèle ;
7. l'assignation d'un connecteur qui se prouve sur l'onglet, pas sur des cases ;
8. un garde-fou dont le motif `/recipe|profile|template/i` attrapait
   `taskContextTemplate` — une colonne d'orchestration sans rapport avec la
   provenance d'un agent — et ne pouvait donc jamais passer.

## Questions, par priorité

### P0 — le test prouve-t-il encore quelque chose

1. **Le garde-fou de provenance** (dernier commit, `agent-recipes.spec.ts`).
   Le motif a été restreint pour ne plus attraper `taskContextTemplate`.
   A-t-il été restreint **trop** ? Nomme les colonnes que l'ancien motif
   attrapait légitimement et que le nouveau laisse passer. C'est exactement la
   forme d'erreur qu'une réparation « faite pour passer » produit.
2. **Assertions affaiblies.** Pour chacun des 8 commits, compare AVANT/APRÈS :
   la réparation change-t-elle le SÉLECTEUR (légitime : l'interface a bougé) ou
   l'AFFIRMATION (suspect) ? Un `toContain` devenu un `||` entre deux surfaces,
   un `expect` devenu un `if`, une assertion devenue un `test.skip` : dis-le.
3. **Le cas Skills sur DEUX surfaces** (commit « l'onglet Skills ne montre que
   l'attaché »). Le cas accepte désormais `command-execution` « attaché OU
   attachable », et s'ignore si la bibliothèque est vide. Un OU sur deux
   surfaces est-il encore une preuve, ou le cas peut-il passer dans un état du
   produit qui devrait le faire rougir ? Et la garde « bibliothèque vide »
   peut-elle être vraie en permanence sur une installation neuve — auquel cas
   le cas est mort.
4. **Données d'assertion pré-seedées.** Tout `insert` en base (ou appel d'API)
   qui pose la donnée même que le test affirmera ensuite avoir été produite par
   le parcours. Fixture = légitime ; cible d'assertion = le test ne prouve plus
   rien.
5. **Étiquettes `@cap:<slug>/ecran`.** Elles ne vivent que dans les TITRES
   (`CLAUDE.md`). Une étiquette perdue ou dont le slug a changé pendant la
   réparation fait mentir le portail qualité. Compare avant/après sur la plage.

### P1 — sélecteurs et unicité

6. **Le piège des deux « Close » est-il refermé partout ?** La PR l'a corrigé à
   un endroit. Cherche dans les six fichiers **tous** les
   `getByRole('button', { name: … })` dont le nom peut désigner plus d'un
   élément de la page ou de la modale — « Close », « Delete », « Cancel »,
   « Save », « Add ». Une expression non ancrée (`'Close'` au lieu de
   `/^close$/`) est le symptôme.
7. **`getByRole('row')` + `hasText`.** Le commit sur les lignes de tableau dit
   vérifier l'unicité avant le clic. Est-ce vrai pour TOUTES les occurrences,
   ou seulement celle qui avait échoué ? Un `hasText` sur un nom court peut
   attraper une ligne voisine, et un tableau vide rend `first()` silencieux.
8. **Les noms tirés de `title` / `aria-label`.** Deux commits reposent sur le
   fait que le `title` d'un `RowActionButton` sert d'`aria-label`. Est-ce vrai
   dans tous les cas — y compris quand le bouton porte aussi du texte visible,
   où l'un des deux l'emporte ?

### P2 — attente et hygiène

9. **`waitForTimeout`.** Le lot prétend n'en avoir introduit aucun. Vérifie-le
   sur la plage, et dis si une attente a été remplacée par autre chose d'aussi
   arbitraire (`waitForLoadState('networkidle')` sur une page qui garde une
   connexion ouverte, un `expect` à timeout allongé pour masquer une course).
10. **`test.skip` ajoutés par le lot.** Chacun doit énoncer une condition
    d'environnement vraie et vérifiable. Signale ceux dont la condition serait
    vraie *toujours*.

## Hors périmètre

- `packages/tools`, `apps/runner`, `apps/qa`, `helpers.ts` — d'autres
  relectures sont en cours dessus (la PR #84 fait l'objet d'une demande
  séparée : `demande-review-pr84-post-merge.md`).
- Tout code produit.
- « Ces parcours passent-ils » : le rejeu est de mon côté. Ne conclus jamais un
  résultat d'exécution par lecture.

## Ce qui n'est PAS attendu

Style, nommage, formatage, longueur des commentaires, préférence d'API
Playwright. La langue française des commentaires est un choix du dépôt.

## Ce dont je doute moi-même

- **Le rejeu couvrait-il vraiment les neuf cas ?** La PR affirme un rejeu sur
  pile isolée. Si un commit ne pouvait matériellement pas être rejoué (chemin
  demandant un service externe, un OAuth réel, un LLM), dis lequel : je le
  rapporterai comme non rejoué.
- **Une réparation « jusqu'à ce que ça passe ».** Le commit sur le garde-fou
  raconte une cause trouvée *au rejeu, une fois le cas capable d'aller jusqu'au
  bout* : c'est la bonne démarche, mais c'est aussi la démarche qui, mal menée,
  fabrique une assertion taillée pour le résultat observé. Regarde les huit
  commits avec ce soupçon-là.
- **`tsconfig` d'`apps/web` exclut `tests`** : aucun de ces fichiers n'est
  type-vérifié. Y a-t-il là-dedans une erreur de type qu'un compilateur aurait
  attrapée ?

## Forme attendue du rapport

Un fichier Markdown. Pour chaque constat :

```
### [P0|P1|P2] Titre court
- Fichier : chemin:ligne
- Ce qui casse : …
- Dans quel cas : …
- Preuve : l'extrait, ou la comparaison avant/après
```

Deux verdicts seulement : **le constat tient** ou **le constat est faux**.
Interdits : « ça a l'air bien », « conforme aux bonnes pratiques »,
« je confirme ». Rien trouvé sur un axe ⇒ une ligne, et au suivant.

Tu es en **lecture seule** : tout ce que tu n'as pas pu vérifier se rapporte
comme **NON VÉRIFIÉ**, jamais comme conclu.
