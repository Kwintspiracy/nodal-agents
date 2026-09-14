# Demande de review — PR #98, passe 3

Passe 1 : 7 constats, tous vrais, tous corrigés (`45e1e05f`).
Passe 2 : 4 constats neufs sur ces correctifs, tous vrais, tous corrigés
(`e6be0126`). Cette passe relit **les correctifs de la passe 2**.

Deux passes de suite ont trouvé des bloquants dans les correctifs de la passe
précédente. Ce n'est plus une boucle de vérification qui converge, c'est un
signe. **Si cette passe trouve encore un bloquant dans `e6be0126`, dis-le
explicitement à la dernière ligne** : la question deviendra la FORME de ce
code, pas ce constat-là.

Sandbox lecture seule. Deux verdicts : **le constat tient** ou **le constat est
faux**.

Lire `git show e6be0126`, le rapport de la passe 2
(`docs/validation/rapport-review-pr98-passe2.md`), puis le code d'aujourd'hui :
`apps/cli/src/lib/orphans.ts`, `apps/cli/src/lib/postgres.ts`,
`apps/cli/src/commands/up.ts` et les deux fichiers de tests.

## Ce que les correctifs de la passe 2 affirment

| Constat | Ce qui a changé |
|---|---|
| R1 | `dataDirArgument` garde le DERNIER `-D`, plus le premier. |
| R2 | `-c data_directory=…` / `--data-directory=…` l'emporte sur `-D`. |
| R3 | `stopOrphanPostgres` lance `pg_ctl stop -D … -m fast -w -t 30` lui-même, résolu par `resolvePgCtl()` ; il rend `false` et journalise `PG_CTL_STOP_FAILED` / `PG_CTL_NOT_FOUND` au lieu de mentir. |
| R4 | L'époque PowerShell est en UTC (`(Get-Date '…Z').ToUniversalTime()`). |

## Questions, par priorité

### P0 — les nouveaux correctifs

1. **`resolvePgCtl`.** Il résout `embedded-postgres` par `require.resolve`, puis
   importe `binary.js` PAR CHEMIN (le paquet n'exporte que `./dist/index.js`).
   Est-ce solide sous pnpm avec des liens, dans le paquet PUBLIÉ (`nodal-agents`
   installé depuis npm, pas le dépôt), et après un `npm i -g` ? Si le chemin
   change d'une version à l'autre, on retombe sur `PG_CTL_NOT_FOUND` — bruyant,
   mais plus aucun arrêt gracieux. Y a-t-il un chemin d'accès supporté que
   j'aurais dû utiliser à la place ?
2. **`pg_ctl stop -m fast -w -t 30` avec `timeout: 40_000`.** Que fait `up` si
   `pg_ctl` reste bloqué 40 s — l'utilisateur voit-il quelque chose pendant ce
   temps ? Et si `pg_ctl` rend non-zéro parce que le cluster est DÉJÀ arrêté :
   `false` déclenche-t-il quelque chose d'inutile ou de dangereux chez
   l'appelant ?
3. **`pg_ctl` sans le bon utilisateur / la bonne locale.** Il est lancé sans
   `env` particulier. Manque-t-il `PGDATA`, `PGPASSWORD`, une variable que le
   binaire embarqué attend ? Sous Windows, `pg_ctl stop` sur un cluster démarré
   par un AUTRE compte échoue-t-il, et avec quel code ?
4. **`data_directory` dans `postgresql.conf`.** Le correctif R2 ne voit que la
   ligne de commande. Notre propre cluster a un `postgresql.conf` dans notre
   dossier : pourrait-il contenir un `data_directory` qui pointe ailleurs, et
   ferait-on alors un contresens ? Le lire serait-il raisonnable, ou est-ce le
   genre de complexité qui crée le prochain incident ?

### P1 — ce que la passe 2 a laissé ouvert

5. Q5 et Q6 de la passe 2 étaient **NON TRANCHÉES** (une ligne WMI sans
   `CreationDate` ; deux dates égales). Peux-tu les trancher maintenant, ou
   restent-elles hors de portée d'une lecture ? Si elles le restent, dis-le :
   « non exécuté » est un résultat.
6. **`up.ts`, l'ordre des destructions.** R3 a rendu l'arrêt gracieux réel.
   Change-t-il quelque chose au constat R3 de la passe 2 sur l'ordre — tuer un
   worker avant son postmaster ? La boucle parcourt la liste de la sonde
   initiale : un `pg_ctl stop` réussi la rend-elle entièrement périmée (tous
   morts, `isPidAlive` faux partout), ou reste-t-il un cas où l'on tire sur un
   pid recyclé entre la sonde et le kill ?

### P2 — la forme

7. `dataDirArgument` fait maintenant trois choses (tokeniser, lire `-D`, lire
   un réglage). Est-elle encore juste sur les formes déjà couvertes — la passe
   2 avait listé espaces non cités, 8.3, UNC, `^` ? Rien n'a régressé ?

## Hors périmètre

Le reste de `up.ts` ; style, nommage.

## Ce dont je doute moi-même

La question 1 : je charge un fichier interne d'une dépendance par son chemin.
Ça marche ici, dans un worktree à jonctions. Je n'ai PAS vérifié le paquet
publié.

## Forme du rapport

Les constats d'abord (fichier:ligne, déclenchement, gravité), puis les sept
questions avec « tient » / « constat » / « NON TRANCHÉ ». Terminer par UNE
ligne : « rien de neuf », ou « des constats », ou « la forme est en cause ».
