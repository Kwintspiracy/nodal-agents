# Demande de review — PR #114, « le cluster garde un log, aucun pid noté n'est tué sans preuve »

Branche `fix/pg-logs-and-recorded-pids`, ouverte, ferme #111 et #100.

Deux incidents du 15/09 n'ont pas pu être attribués : le cluster ne gardait
aucune trace, et la CLI tuait des pids qu'elle avait notés sans jamais demander
ce que ces numéros étaient devenus.

Sandbox lecture seule. Deux verdicts : **le constat tient** (fichier, ligne, ce
qui casse, comment le déclencher) ou **le constat est faux**.

Lire `git log origin/main..HEAD --patch`, puis le code d'aujourd'hui :
`apps/cli/src/lib/pid-confirm.ts`, `pg-logging.ts`, `processes.ts`,
`postgres.ts`, `launcher-log.ts`, `already-running.ts`, et
`apps/cli/src/commands/up.ts`, `down.ts`.

## LA question de fond

**Quel pid peut encore être tué sans preuve d'appartenance, et quel crash
Postgres resterait sans trace ?**

Suis les deux chemins jusqu'au bout :

- pour chaque endroit qui signale un processus (`down`, `sweepRecordedChildren`,
  la boucle non-postgres de `up`, `taskkill /T`, l'arrêt d'un arbre), dis quelle
  preuve est exigée AVANT le signal, et ce qui se passe quand la lecture ne
  répond pas, répond partiellement, ou répond trop tard (pid recyclé entre la
  lecture et le signal) ;
- pour le log : quel événement du cluster n'atterrit nulle part ? Une panne
  avant que la configuration soit appliquée, une rotation qui tombe pendant un
  crash, un `PANIC`, un disque plein, un démarrage qui échoue.

## Ce que la PR affirme

1. `logging_collector` est activé, les réglages sont écrits dans
   `postgresql.auto.conf`, FUSIONNÉS et non écrasés, à chaque démarrage.
2. `log_min_messages = warning` ne perd pas les lignes de crash, parce que pour
   ce réglage l'ordre est `… WARNING < ERROR < LOG < FATAL < PANIC`.
3. La disponibilité est MESURÉE (connexion, déconnexion) parce que le
   collecteur prend la sortie d'erreur que `embedded-postgres` surveillait.
4. `pid-confirm.ts` est le SEUL endroit qui décide : un pid n'est signalé que si
   une lecture fraîche s'accorde sur le nom de l'exécutable ET le tick de
   création, jamais si c'est un `postgres.exe` que notre dossier de données ne
   revendique pas.
5. Hors Windows, l'ancienne portée reste et la ligne le DIT.

## Questions, par priorité

### P0

1. La question de fond ci-dessus.
2. Le point 2 est-il vrai ? Vérifie l'ordre des niveaux pour CE réglage, pas
   pour `client_min_messages`. S'il est faux, les crashs ne sont pas journalisés
   et la PR ne ferme pas #111.
3. La fusion de `postgresql.auto.conf` : peut-elle perdre un réglage existant,
   en écrire un en double, ou casser le fichier si le démarrage est interrompu
   pendant l'écriture ?
4. La mesure de disponibilité peut-elle rendre la main trop tôt (cluster qui
   accepte une connexion puis meurt) ou boucler sans fin ?

### P1

5. Le tick de création : quelle est sa granularité, et deux processus peuvent-ils
   la partager ? Que vaut la comparaison si l'horloge recule ?
6. Les tests prouvent-ils ce qu'ils annoncent ? Y en a-t-il un qui resterait vert
   avec la garde débranchée ?

### P2

7. Si tu ne trouves **rien de neuf**, dis-le à la dernière ligne.

## Hors périmètre

Les autres PR ouvertes ; `apps/qa` ; le style et le nommage.

## Forme du rapport

Les constats d'abord (fichier:ligne, déclenchement, gravité — **BLOQUANT /
IMPORTANT / MINEUR** —, ET le SENS de l'erreur : pid tué à tort, crash perdu,
démarrage bloqué), puis les sept questions avec « tient » / « constat » /
« NON TRANCHÉ ». Terminer par UNE ligne : « rien de neuf », « des constats », ou
« la forme est en cause ».
