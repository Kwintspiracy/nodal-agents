# Demande de review — PR #46, passe 41 (réponse à la passe 40 sur P10b)

Périmètre : **un commit**, `147159ff` (5 fichiers), qui répond à la passe 40
(`docs/validation/rapport-review-pr46-passe40.md`). L'arbre de travail contient le chantier
P11 NON committé (checkpoints, seam, runner, web) : relire l'état COMMITTÉ (`git show
147159ff`, `git show HEAD:<chemin>`), jamais l'arbre.

- `packages/tools/src/builtin/register-project.ts` : `jobAnsweredForProject` compare par
  ÉGALITÉ après `fold` (un `Set` des aiguilles acceptées : `name` foldé, dernier segment du
  `path` foldé ; `accepted.has(fold(answer))`) ; `orderBy(desc(resolvedAt))` avant `limit(50)` ;
  rollback : `rmdir` n'ignore que `ENOTEMPTY`/`ENOENT` (`err.code`), tout autre échec →
  `PROJECT_ROLLBACK_DIR_FAILED key=… code=…` ; suppression de ligne en échec →
  `PROJECT_ROLLBACK_ROW_FAILED` ; raison `attach_failed:<code>;rollback_failed` dès que l'un a
  raté. Description de l'outil : « the option the person picked must be exactly this project's
  name or folder ».
- `packages/orchestration/src/system-prompt.ts` : « offer up to five relevant registered
  projects by name, plus one option that is exactly the name of the new project you propose
  (say in the question itself that this one would be created) ».
- Tests : `register-project.test.ts` (21 : « Add notes to the README » + `notes` → suspend ;
  « Veille IA » = name → passe ; « veille-ia » = dossier → passe ; « New project: veille-ia »
  NE passe plus ; « ÉTÉ 2026 » vs « Été 2026 » → passe ; `ENOTEMPTY` ignoré ; `EACCES`
  journalisé et `;rollback_failed` ; suppression de ligne qui lève → `;rollback_failed` ; 61
  questions, la bonne étant la plus récente), `system-prompt.test.ts` (37),
  `attach-seam.test.ts` (une ligne : l'option nue dans le bout en bout).

## Réponses aux constats de la passe 40

| Constat 40 | Réponse |
|---|---|
| P0 — sous-chaîne | égalité stricte après repli ; l'intention « nouveau » portée par la question |
| P1 — `rmdir` avale tout | `ENOTEMPTY`/`ENOENT` seuls ignorés, le reste journalisé et remonté |
| P1 hors demande — rollback de ligne muet | `PROJECT_ROLLBACK_ROW_FAILED` + `;rollback_failed` |
| P2 — `limit` sans ordre | `orderBy(desc(resolvedAt))` |

## Mesuré

register-project 21 ; system-prompt 37 ; tools 936 ; orchestration 239 ; typecheck 33/33 ;
deps 0 ; lint 0 erreur. Mutations rouges (agent 6 ; orchestrateur M39 : retour à `includes` →
« Add notes to the README » et « libellé préfixé » rougissent).

## Questions

1. **L'égalité stricte et l'usage réel** : l'agent doit écrire l'option EXACTEMENT comme le
   `name`/dossier qu'il passera ensuite. La consigne le dit ; la description de l'outil aussi.
   Un cas où l'agent, suivant la consigne, produit une option légitime que la règle refuse
   (un nom avec ponctuation, un dossier `veille-ia` proposé sous le nom « Veille IA » sans
   passer `name`) ? Ce n'est jamais un refus, seulement la carte d'approbation — acceptable ?
2. **`fold` et les espaces internes** : « Veille  IA » (double espace) ≠ « Veille IA ». Réel
   mais bénin (carte d'approbation). Faut-il replier les espaces ?
3. Rien d'autre ne bouge : confirmer que la passe 40 est close.

## Ce qui n'est PAS attendu

Le style. Un constat désigne un fichier, une ligne, et ce qui casse.
