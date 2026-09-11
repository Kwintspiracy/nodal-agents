# Demande de review — PR #51, 3e passe (HEAD `a38491ec`)

Branche `qa/etat-zero-tests`, 12 commits au-dessus de `origin/main` (`44f72be6`).
Sandbox lecture seule. Deux verdicts valent : **le constat tient** (fichier,
ligne, ce qui casse, comment le déclencher) ou **le constat est faux**. « Ça a
l'air bien » ne compte pas.

## Ce que la PR affirme

Un portail qualité statique (`apps/qa/`) rendu à partir de mesures que la CI
écrit dans `apps/qa/data/` :

- `collect.mjs` rassemble (couverture par paquet, rapport Playwright, banc,
  issues/PR GitHub via `gh`) → `history.ndjson`, `tests.ndjson`, `latest.json`.
- `lib.mjs` porte les jugements purs (121 tests dans `lib.test.mjs`).
- `capacites.mjs` + `porte.mjs` : 24 capacités produit ; chaque test déclare
  `@cap:<slug>` dans son TITRE ; `pnpm capacites:check` (porte de `ci.yml`)
  refuse une étiquette inconnue et une capacité exigée sans preuve.
- `alerte.mjs --appliquer` : UNE issue GitHub ouverte / mise à jour / fermée
  selon ce qui est rouge sur main.
- `build.mjs` rend `apps/qa/dist/` ; `serve.mjs` le sert en local.
- Workflows : `qa.yml` (mesure nocturne, pousse les données sur main),
  `qa-pages.yml` (publie sur Cloudflare Pages, déclenché par `workflow_run`),
  `ci.yml` (+ `capacites:check` et banc bloquants).

## Deux passes précédentes, dix constats, tous corrigés

Passe 1 (`f17156ad`) : `qa-pages.yml` jamais déclenché (push avec
`GITHUB_TOKEN`), alerte sans `issues: write`, Kanban écrasé par `?? []` quand
`gh` échoue, régression fraîche invisible, unitaires sans capacité, `pnpm
build` faussant la mémoire.

Passe 2 (`a38491ec`) : `workflow_dispatch` depuis une branche poussait tout son
code sur main, mesure perdue si main avance, banc non lu par `ecartsDe`,
billet d'alerte cherché dans 50 issues seulement.

## Questions, par priorité

### P0 — les correctifs de la passe 2 tiennent-ils ?

1. `qa.yml`, étape « Enregistrer la mesure » : `git reset --hard origin/main`
   puis recopie de `$RUNNER_TEMP/mesure/` et `git push HEAD:main`. Y a-t-il un
   chemin où cette boucle pousse autre chose que `apps/qa/data/` ? Où elle
   perd la mesure sans `::error` ? Le `git diff --quiet -- apps/qa/data` initial
   est-il fiable quand des fichiers sont NOUVEAUX (non suivis) ?
2. `qa.yml`, `ref: main` au checkout : les étapes qui suivent (`pnpm bench`,
   Playwright, `collect.mjs`) mesurent-elles bien main, ou l'une d'elles
   dépend-elle encore de `github.ref` / `GITHUB_SHA` (qui, en
   `workflow_dispatch` depuis une branche, désignent la BRANCHE) ? Vérifier
   notamment ce que `collect.mjs` inscrit comme commit dans `history.ndjson`.
3. `alerte.mjs` : recherche du billet par titre EXACT côté serveur. Que fait
   `gh issue list --search` avec un titre contenant des guillemets, un tiret
   cadratin ou un `:` ? Un titre approchant peut-il passer pour exact ?
4. `lib.mjs` `verdictDuBanc` et son branchement dans `ecartsDe` : un rapport
   de banc absent (le `|| true` a tout avalé) est-il distingué d'un banc vert ?
   Un rapport partiel (une section en panne) ?

### P1 — ce dont je doute moi-même

5. `qa-pages.yml` : `workflow_run` sur `qa.yml`, `ref: main` au checkout. Si
   la mesure a poussé son commit de données, ce checkout le voit-il, ou
   publie-t-il le commit d'AVANT (course entre le push et le déclenchement) ?
6. `collect.mjs` sur un runner neuf : quelles commandes `gh` / lectures de
   fichiers peuvent échouer, et chacune échoue-t-elle LOUD (le portail marque
   ABSENT) plutôt qu'en silence (zéro ou liste vide présentés comme mesurés) ?
7. `porte.mjs` : le scan des titres. Un `describe` étiqueté dont les `it` sont
   `.skip` ou `.todo` compte-t-il comme preuve ? Une étiquette dans un titre
   construit par template (`` `… ${x}` ``) est-elle lue ? Un fichier de test
   hors des dossiers scannés (`apps/qa/lib.test.mjs` lui-même ?) ?
8. `tests.ndjson` (mémoire test par test) : une clé de test est-elle stable
   entre deux nuits si un `describe` est renommé, si un test est paramétré
   (`test.each`), si le même titre existe dans deux fichiers ?

### P2 — le reste, avec un œil neuf

9. `build.mjs` (850 lignes) : tout ce qui est injecté dans le HTML vient de
   données que d'autres écrivent (titres d'issues, noms de tests, messages
   d'erreur Playwright). Est-ce échappé ? Le portail sera public derrière
   Cloudflare.
10. Les modifications hors `apps/qa` : `ci.yml`, `.gitignore`, `CLAUDE.md`,
    les 27 fichiers `apps/web/tests/e2e/*.spec.ts` (ajout d'étiquettes dans les
    titres). Un titre modifié casse-t-il un `--grep` existant ailleurs
    (`ci.yml`, `playwright.config.ts`, scripts) ?

## Hors périmètre

- Les secrets Cloudflare (`CLOUDFLARE_API_TOKEN`, `CLOUDFLARE_ACCOUNT_ID`) :
  absents, connu, geste de Quentin. `qa-pages.yml` échoue loud sans eux.
- Les 25 parcours e2e rouges que la première mesure a révélés : ce sont des
  MESURES, pas des défauts de cette PR.
- Style, nommage, longueur des commentaires.

## Forme du rapport

Pour chaque constat : fichier:ligne, ce qui casse, comment le déclencher,
gravité (bloquant / important / mineur). Terminer par la liste des questions
ci-dessus avec, pour chacune, « tient » ou « constat » — et si une question n'a
pas pu être tranchée par lecture, le dire tel quel : NON TRANCHÉ.
