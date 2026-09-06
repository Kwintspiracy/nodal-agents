# Demande de review — PR #46 « Vérifier & Corriger — PR① » (passe 3)

Branche `feat/verifier-corriger-pr1`, base `main`. Passes précédentes :
`docs/validation/rapport-review-pr46-passe1.md`, `…-passe2.md` ; traitements dans les deux
derniers commits (`git log -2 -p`) et la table « Progression de PR① » du plan.

## Ce que la passe 2 a obtenu

Le seul constat (P0) est tenu : `packages/tools/src/verification/intent.ts` compare désormais sur
les chemins réels (`realPathOf`) mais NOMME le projet par la racine lexicale
(`rebaseOntoLexicalRoots`) — la même identité que l'onglet Code dérive. Le test par lien attend la
clé du lien, pas celle du dossier réel.

## Questions pour cette passe

- `rebaseOntoLexicalRoots` : une cible sous DEUX racines (racines imbriquées, l'une lien de
  l'autre), une cible qui n'existe pas encore (fichier à créer sous un dossier existant), une
  racine inexistante, la casse Windows — la réécriture peut-elle produire une clé que ni le web ni
  la finalisation ne connaissent ?
- Reste-t-il un point où l'identité d'un projet est dérivée autrement que par
  `projectKey(racine lexicale…)` des deux côtés (web : apps/web/src/lib/code-projects.ts et
  actions.ts ; runner : apps/runner/src/job/code-projects.ts ; tools : intent.ts) ?
- Un constat neuf sur le reste du diff, ou rien de neuf : dis-le en une ligne.

## Ce qui est attendu
Constats `fichier:ligne`, TIENT/FAUX, ce qui casse, vérifié vs déduit. Une passe sans constat neuf
est un résultat : dis-le.
