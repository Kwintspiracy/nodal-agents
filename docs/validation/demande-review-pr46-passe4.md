# Demande de review — PR #46 « Vérifier & Corriger — PR① » (passe 4)

Branche `feat/verifier-corriger-pr1`, base `main`. Passes précédentes : rapports
`docs/validation/rapport-review-pr46-passe1.md` à `-passe3.md` ; traitements dans les trois
derniers commits (`git log -3 -p`).

## Ce que la passe 3 a obtenu

`rebaseOntoLexicalRoots` (packages/tools/src/verification/intent.ts) choisit la racine la plus
SPÉCIFIQUE (plus long chemin réel), et une cible déjà sous une racine lexicale n'est pas réécrite ;
test à deux racines imbriquées (lien vers le conteneur + projet du conteneur attaché à part).

## Question pour cette passe

Une seule : après trois passes qui ont chacune affiné la même fonction, reste-t-il un cas où la clé
posée par l'intention diffère de celle que l'onglet Code (apps/web/src/lib/code-projects.ts,
`projectUnderWorkspace`) dérive pour le même appel d'outil ? Si oui : le cas exact, avec les deux
clés. Si non : dis-le en une ligne — c'est le résultat attendu d'une boucle qui converge.

Rien d'autre n'est demandé ; ne rouvre pas un constat déjà traité sauf si le traitement est faux.
