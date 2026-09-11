# Demande de review — PR #51, 4e passe (HEAD `d4415dbb`)

Branche `qa/etat-zero-tests`. Sandbox lecture seule. Deux verdicts valent :
**le constat tient** (fichier, ligne, ce qui casse, comment le déclencher) ou
**le constat est faux**. « Ça a l'air bien » ne compte pas.

Cette passe relit UNIQUEMENT le commit `d4415dbb`, qui répond aux six constats
de la 3e passe (`docs/validation/rapport-review-pr51-passe3.md`). Le reste de
la PR a été relu trois fois ; ne pas le refaire.

## Ce que `d4415dbb` affirme

1. `.github/workflows/qa.yml` : `bench-run.json` est effacé avant que le banc
   ne tourne ; l'étape « Enregistrer la mesure » vide `apps/qa/data/` après
   `reset --hard` avant de reposer la sauvegarde, `git add --all`, et le test
   « rien de neuf » compte les fichiers non suivis.
2. `apps/qa/lib.mjs` `ecartsDe` : un banc absent ET attendu (`s.banc.attendu
   === true`) fait un écart de gravité haute ; `apps/qa/collect.mjs` pose
   `attendu` depuis `GITHUB_ACTIONS === 'true'`.
3. `apps/qa/lib.mjs` `titresDeTest` : les blocs `/* */` et les lignes qui
   commencent par `//` sont retirés avant le scan.
4. `apps/qa/lib.mjs` `fusionnerEssais` : le n-ième homonyme d'une même salve
   prend la clé `<clé>#n` (n ≥ 2).
5. `apps/qa/collect.mjs` `chantiers` : ouvert (limite 1000) et fermé (100
   issues / 50 PR) demandés séparément, `null` si l'une des deux échoue.

## Questions

1. `qa.yml` « Enregistrer » : `rm -rf apps/qa/data` puis `cp -r` depuis
   `$RUNNER_TEMP/mesure/.` — y a-t-il un fichier de `apps/qa/data/` que la
   mesure ne PRODUIT PAS et qui devrait pourtant survivre (quelque chose que
   seul un humain y écrit) ? Vérifier avec `git ls-files apps/qa/data` et ce
   que `collect.mjs` écrit.
2. `titresDeTest` : le retrait de `/* … */` peut-il manger du code entre deux
   occurrences de `/*` et `*/` qui ne sont PAS un commentaire (une regex
   littérale contenant `/*`, une chaîne contenant `*/`) et faire disparaître un
   VRAI titre étiqueté ? Chercher un cas réel dans les 586 fichiers de test du
   dépôt (`grep -l '/\*' --include='*.test.*' --include='*.spec.*'`).
3. `fusionnerEssais` : la clé `#n` est-elle stable si un test homonyme est
   AJOUTÉ avant les autres dans le fichier (décalage de tous les rangs) ? Ce
   n'est pas un défaut bloquant si c'est dit, mais est-ce dit ?
4. `chantiers` : les deux listes sont concaténées. Un élément peut-il apparaître
   dans les deux (changement d'état entre les deux requêtes) et être compté
   deux fois par `cartesDuTableau` ?
5. `attendu` : un `workflow_dispatch` de `qa.yml` lancé à la main, ou le job
   `ci.yml`, posent aussi `GITHUB_ACTIONS`. Le collecteur tourne-t-il ailleurs
   que dans `qa.yml` en CI, où le banc ne serait PAS lancé avant lui ?

## Hors périmètre

Tout ce qui n'est pas dans `d4415dbb`. Style, nommage.

## Forme du rapport

Pour chaque constat : fichier:ligne, ce qui casse, comment le déclencher,
gravité. Puis les cinq questions avec « tient » / « constat » / « NON
TRANCHÉ ». Terminer par UNE ligne : « rien de neuf » ou « des constats ».
