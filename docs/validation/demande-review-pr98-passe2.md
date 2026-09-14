# Demande de review — PR #98, passe 2 (les sept correctifs)

La passe 1 a rendu **sept constats, dont quatre bloquants**. Les sept ont été
vérifiés à la source — C1, C2 et C5 en exécutant la fonction pure, C3, C6 et C7
en traçant le chemin de la sonde jusqu'au `SIGKILL` — et **les sept tenaient**.
Tous sont corrigés dans `45e1e05f`. Cette passe relit LES CORRECTIFS.

Sandbox lecture seule. Deux verdicts valent : **le constat tient** ou **le
constat est faux**.

Lire `git show 45e1e05f`, puis `apps/cli/src/lib/orphans.ts`,
`apps/cli/src/lib/postgres.ts`, `apps/cli/src/commands/up.ts`, et les tests
`apps/cli/src/tests/orphan-ownership.test.ts` et `postmaster-pid.test.ts`.

## Ce que les correctifs affirment

| Constat | Ce qui a changé |
|---|---|
| C1, C2, C5 | `dataDirArgument` lit `-D` / `--pgdata` sur une ligne TOKENISÉE et compare la valeur ENTIÈRE. Plus aucune recherche dans la ligne. |
| C3 | `readPostmasterPid` refuse un fichier dont la ligne 2 nomme un AUTRE dossier ; `up` ne croit le fichier que si la table des processus n'a PAS pu être lue. |
| C4 | La sonde porte `CreationDate` ; la remontée s'arrête à un parent plus JEUNE que l'enfant qu'il réclame. |
| C6 | La sonde rend `{ read, owned }` ; sortie non nulle, exception et non-Windows disent `read: false` avec `ORPHAN_PROBE_UNREADABLE`. |
| C7 | TOUS les postgres annoncés sont arrêtés et vérifiés, plus seulement le premier. |
| Parsing | `parseProcessRows` est sorti de la sonde et testé sur une ligne VERBATIM de la vraie commande, exécutée sur cette machine. |

## Questions, par priorité

### P0 — les correctifs peuvent-ils refuser ce qui est à nous ?

C'est le risque qu'ils créent. Un `up` qui ne reconnaît plus son propre
postmaster ne nettoie plus rien et meurt sur le FATAL opaque.

1. **`tokenise` + `dataDirArgument`.** Quelles écritures réelles de la ligne de
   commande d'un postmaster ce couple RATE-t-il ? `-D` suivi d'un chemin
   contenant des espaces sans guillemets, un guillemet simple, un chemin UNC,
   un chemin court 8.3 (`PROGRA~1`), `--pgdata` avec `=` et guillemets, un `^`
   d'échappement cmd, un chemin avec un `"` interne. Pour chacun : le postmaster
   est-il reconnu ? La liste des formes acceptées est-elle celle que
   `embedded-postgres` produit réellement (le vérifier dans le paquet, pas le
   supposer) ?
2. **Le `..` non résolu.** Un `-D` qui nomme notre dossier via `..` lit comme
   étranger. Assumé et dit. Mais `embedded-postgres` peut-il produire une telle
   ligne ? Et un chemin via une JONCTION (le cas d'usage du dépôt) : le
   postmaster porte le chemin sous lequel il a été lancé, `PG_DATA_DIR` porte
   l'autre — les deux sont-ils comparés par égalité de chaîne, donc différents ?
   Si oui, c'est un `up` qui ne se reconnaît plus, sur le chemin même que les
   worktrees empruntent.
3. **C3 et la jonction.** Même question sur la ligne 2 de `postmaster.pid` :
   Postgres y écrit le dossier tel qu'il l'a reçu. Sous jonction, diffère-t-il
   de `PG_DATA_DIR` ? Le refus serait alors systématique sur un worktree.
4. **C3 et l'arbitre.** `isOurPostmasterPid` : quand la table A été lue et que
   notre postmaster n'y figure pas (il vient de mourir entre les deux lectures,
   ou WMI l'a raté), le pid du fichier est refusé. Est-ce le bon choix, ou
   perd-on la détection de l'orphelin sans socket que la PR #? existait pour
   attraper ?

### P1 — ce que les correctifs ne ferment pas

5. **C4 et les dates manquantes.** `startsAfter` est faux dès qu'une date
   manque. Quand `CreationDate` est-il absent en pratique (processus d'un autre
   utilisateur, accès refusé) ? Le garde retombe alors au comportement d'avant :
   est-ce dit ?
6. **C4 et l'égalité.** Le test est `>` strict. Deux processus créés dans la
   même milliseconde passent. Est-ce atteignable pour un postmaster et son
   worker, et qu'est-ce que ça autorise ?
7. **C7 et l'ordre.** `pgOrphans` est parcouru dans l'ordre où les sondes ont
   poussé. Tuer un worker AVANT son postmaster sert-il à quelque chose, ou le
   postmaster le relance-t-il ? `stopOrphanPostgres()` est appelé une fois avant
   la boucle : suffit-il pour le cluster entier ?
8. **C7 et le `throw`.** Le premier orphelin survivant lève. Les suivants ne
   sont alors jamais tentés. Voulu (on s'arrête au premier échec) ou trou ?
9. **C6 et l'appelant.** `read: false` sur non-Windows était le cas NORMAL
   avant. `isOurPostmasterPid` retombe alors sur le fichier — donc sur Linux le
   comportement est celui d'avant. Confirmer, et dire si un chemin Windows
   arrive à `read: false` sans que l'utilisateur voie la ligne
   `ORPHAN_PROBE_UNREADABLE`.

### P2 — la commande PowerShell

10. `$ms = if ($_.CreationDate) { [int64](… - [datetime]'1970-01-01T00:00:00Z').TotalMilliseconds } else { 0 }`
    — l'arithmétique de dates PowerShell rend-elle bien un `TimeSpan` ici ?
    Le `[datetime]'…Z'` est-il interprété en UTC ou en heure locale (un décalage
    de fuseau fausserait les comparaisons entre processus démarrés de part et
    d'autre d'un changement d'heure) ? La sortie a été exécutée sur cette
    machine et rend `55768|45420|1789376176154|…` : la valeur est-elle
    cohérente avec l'heure réelle ?
11. `-NonInteractive` sans `-ExecutionPolicy Bypass` : une stratégie
    d'exécution restrictive fait-elle échouer `-Command` ? Si oui, on tombe
    dans `read: false` — bruyant, mais `up` perd sa troisième sonde.

## Hors périmètre

Le reste de `up.ts` ; les ports par défaut ; style, nommage.

## Ce dont je doute moi-même

Les questions 2 et 3 : la JONCTION. Le dépôt s'en sert pour tous ses worktrees,
et je compare des chemins par égalité de chaîne des deux côtés. Si Postgres
enregistre un chemin et que `PG_DATA_DIR` en porte un autre pour le même
dossier, mes deux correctifs les plus importants refusent notre propre serveur.

## Forme du rapport

Les constats d'abord (fichier:ligne, comment le déclencher, gravité), puis les
onze questions avec « tient » / « constat » / « NON TRANCHÉ ». Terminer par UNE
ligne : « rien de neuf » ou « des constats ».
