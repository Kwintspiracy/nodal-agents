# Demande de review — PR #98 « Un Postgres est à nous par son dossier de données », passe 1

Branche `fix/orphan-probe-kills-foreign-postgres`, un commit au-dessus de
`main` (`498d3367`). **PR OUVERTE, non mergée.** Closes #97.

C'est du code du LANCEUR : `nodal-agents up` décide, au démarrage, quels
processus il a le droit de tuer. Le 14/09/2026 il a tué le Postgres de
l'installation principale en appelant ça du ménage de routine. Une erreur ici
ne se rattrape pas — la base d'un tiers est déjà morte.

Sandbox lecture seule. Deux verdicts valent : **le constat tient** (fichier,
ligne, ce qui casse, comment le déclencher) ou **le constat est faux**. « Ça a
l'air bien », « conforme aux bonnes pratiques », « je confirme » ne comptent
pas.

Lire `git show 498d3367`, puis `apps/cli/src/lib/orphans.ts`,
`apps/cli/src/lib/postgres.ts` (`postgresPidsForDataDir`),
`apps/cli/src/commands/up.ts` (la section orphelins) et
`apps/cli/src/tests/orphan-ownership.test.ts`.

## Ce que la PR affirme

1. **La propriété se décide par le DOSSIER DE DONNÉES, et par rien d'autre.**
   Le chemin du binaire embarqué (`@embedded-postgres`) n'est plus une preuve :
   deux installations qui partagent un `node_modules` (un worktree à jonctions,
   la façon supportée de relire une branche sous Windows) résolvent le MÊME
   chemin.
2. Un `--forkchild="io_worker"` n'a aucun dossier de données sur sa ligne de
   commande : il est jugé par **ascendance**, en remontant `ParentProcessId`
   dans les seules lignes `postgres.exe`, jusqu'à un postmaster qui porte notre
   dossier. Sans un tel ancêtre : passé, et DIT
   (`ORPHAN_PROBE_FOREIGN_POSTGRES_SKIPPED`).
3. **Le port est MESURÉ.** Un pid ne reçoit un port que si la sonde d'écoute
   l'a réellement rendu pour ce port ; sinon la ligne dit « listening on none
   of our ports ».
4. Un postgres qui écoute sur notre port configuré sans être à nous est
   **refusé**, pas tué — la règle déjà appliquée à `web` et `runner`.
5. Hors Windows, `postgresPidsForDataDir` rend `[]` : un postgres sur notre
   port n'est reconnu que par `postmaster.pid`. Sans ce fichier, `up`
   **refuse** au lieu de tuer. Changement de comportement assumé et nommé.
6. Preuve : 10 cas sur des lignes en forme de ce que WMI rend ; deux mutations
   vérifiées.

## Déjà trouvé et corrigé sur cette branche — à relire aussi

`527c5148` : le dossier de données était cherché par **sous-chaîne**
(`includes`), donc une installation voisine à `…\pg-data2` ou un
`…\pg-data.bak` gardé à côté voyait son postmaster ET ses workers réclamés
comme nôtres — l'incident #97 par une autre porte, sur la branche même qui le
ferme. Mesuré sur la fonction pure avant de toucher quoi que ce soit. La
correspondance doit désormais finir sur une **frontière de chemin** ;
`normalise` retire aussi un séparateur final.

**Ce correctif fait partie du périmètre de cette review.** Sa fonction
`namesDirectory` est-elle juste ? Un chemin court 8.3 (`PROGRA~1`), un chemin
UNC, un `-D` sans guillemets suivi d'une tabulation, un chemin cité avec des
guillemets simples : la frontière couvre-t-elle tout, ou en refuse-t-elle un
qui était accepté avant (une régression qui empêcherait de trouver NOTRE
postmaster, donc un `up` qui ne nettoie plus rien) ?

## Questions, par priorité

### P0 — un pid étranger peut-il encore être attribué à cette installation ?

C'est LA question. Tout le reste est secondaire.

1. **Reste-t-il une autre attribution par ressemblance ?** La sous-chaîne du
   dossier de données est fermée (ci-dessus). Cherche les autres : une
   comparaison de chemins qui ignore les liens et jonctions (deux chemins
   différents désignant le MÊME dossier — notre cas d'usage, les worktrees),
   un `realpath` absent d'un côté et présent de l'autre, un chemin relatif.
   Deux installations dont l'une voit le dossier de l'autre par une jonction
   sont-elles distinguées ?
2. **`livePostmasterPid() === pid`** dans `up.ts` : un second chemin pour
   déclarer « à nous » un pid qui ÉCOUTE sur notre port. `postmaster.pid` peut
   être PÉRIMÉ (le fichier survit à un crash) et son pid peut avoir été
   recyclé par le système. Un processus étranger qui écoute sur notre port
   configuré et dont le pid coïncide avec un `postmaster.pid` périmé est-il
   tué ? Le fichier est-il validé (date, `pg_ctl status`, nom du processus)
   avant d'être cru ?
3. **L'ascendance.** La remontée reste dans les lignes `postgres.exe`. Un
   `io_worker` dont le parent DIRECT n'est pas le postmaster (un worker de
   worker, un processus intermédiaire d'un autre nom, un parent déjà mort dont
   le pid a été recyclé PAR UN AUTRE `postgres.exe` — celui du voisin) :
   peut-il se retrouver rattaché à notre postmaster par hasard ? Le `seen`
   arrête les cycles, il n'empêche pas une mauvaise attribution.
4. **Le sens de l'erreur.** Dans chaque cas douteux, la fonction se trompe-t-elle
   du côté « je n'y touche pas » ou du côté « je tue » ? Nommer tout chemin où
   l'incertitude aboutit à un `kill`.

### P1 — l'analyse de la sortie PowerShell, jamais exercée

5. Le format est `"$($_.ProcessId)|$($_.ParentProcessId)|$($_.CommandLine)"`.
   **Aucun test ne part d'une vraie sortie PowerShell** : les tests
   construisent les lignes déjà découpées. Que se passe-t-il si
   `CommandLine` est `$null` (processus d'un AUTRE utilisateur, accès refusé —
   le cas d'une seconde installation lancée par un autre compte) ? La ligne
   devient-elle `pid|ppid|` ? Est-elle alors « pas à nous » — la bonne
   direction — ou tombe-t-elle dans un piège ?
6. `Get-CimInstance` peut-il rendre une ligne de commande contenant un saut de
   ligne, un `|`, ou des caractères non-ASCII mal encodés (la sortie
   PowerShell arrive dans quel encodage) ? Les deux premiers `indexOf('|')`
   suffisent-ils ? Une ligne coupée en deux produit-elle un pid faux ?
7. `{ reject: false, timeout: 10_000 }` : si PowerShell échoue, expire, ou
   n'existe pas, `stdout` est vide ⇒ aucun pid ⇒ aucun orphelin signalé.
   Est-ce dit, ou est-ce un silence (invariant #4) ? Le cas « la sonde n'a pas
   pu répondre » se distingue-t-il de « il n'y a rien » ?

### P2 — le changement de comportement hors Windows

8. Sur Linux et macOS, un Postgres sur notre port sans `postmaster.pid`
   lisible fait désormais **refuser** `up`. Nous l'assumons : refuser plutôt
   que deviner. La question n'est pas s'il faut le faire, mais :
   **existe-t-il un chemin où une installation SAINE ne démarre plus ?**
   Par exemple : `postmaster.pid` présent mais illisible (droits), un Postgres
   démarré par nous dans un conteneur (pid namespace : le pid du fichier n'est
   pas celui que voit l'hôte), un redémarrage après un crash où le fichier a
   été supprimé mais le processus vit, un `up` relancé deux fois de suite.
   Tracer le code de `livePostmasterPid` et dire ce que l'utilisateur voit.
9. Le message de refus dit-il quoi FAIRE ? Un `up` qui refuse sans chemin de
   sortie est un produit cassé, même s'il est prudent.

### P3 — le rapport et l'attente

10. `orphans` porte maintenant `port: number | null`. La boucle d'attente
    (`while (Date.now() < deadline)`) saute les pids sans port : on tue, puis
    on n'attend rien. Le processus peut-il être encore vivant quand `up`
    enchaîne sur le démarrage du sien, et que se passe-t-il alors ?
11. `strangers` : un postgres étranger sur notre port est refusé. Le message
    distingue-t-il « ce n'est pas à moi » de « je n'ai pas pu savoir » ?

## Hors périmètre

Le reste de `up.ts` (santé, migrations) ; le choix des ports par défaut ;
`apps/qa` ; style, nommage, formulation des commentaires.

## Ce dont je doute moi-même

Que la frontière de chemin de `527c5148` soit complète. J'ai fermé la forme
que j'ai su nommer (`pg-data` / `pg-data2`) ; une deuxième façon de confondre
deux dossiers — jonctions, chemins courts, casse d'un volume sensible à la
casse — coûterait exactement aussi cher, et mes tests n'en diraient rien.

## Forme du rapport

Les constats d'abord (fichier:ligne, comment le déclencher, gravité
bloquant / important / mineur), puis les onze questions avec « tient » /
« constat » / « NON TRANCHÉ ». Terminer par UNE ligne : « rien de neuf » ou
« des constats ».
