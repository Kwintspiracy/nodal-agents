# Demande de review — PR #98, passe 5

Passe 4 : 4 constats bloquants, tous vrais, tous corrigés (`2cd93674`). Ils
portaient sur les BORDS de la forme renversée — les endroits où elle se
rouvrait — et non sur une cinquième façon d'attribuer un cluster étranger.

Cette passe relit `2cd93674`.

Sandbox lecture seule. Deux verdicts : **le constat tient** ou **le constat est
faux**.

Lire `git show 2cd93674`, le rapport de la passe 4
(`docs/validation/rapport-review-pr98-passe4.md`), puis
`apps/cli/src/lib/orphans.ts`, `apps/cli/src/lib/postgres.ts`,
`apps/cli/src/commands/up.ts` et les deux fichiers de tests.

## Ce que la passe 4 a changé

| Constat | Correctif |
|---|---|
| R1 | `up` n'a plus de seconde source : `isOurPostmasterPid` = appartenance à `ownedPgPids`. La sonde couvre elle-même le cas « table illisible » (`unconfirmedReading`), et un pid vivant réclamé mais refusé est DIT à l'écran. |
| R2 | Une date manquante REFUSE — sur le postmaster et sur chaque lien d'ascendance. |
| R3 | Tolérance 60 s → 2 s, et le commentaire qui la justifiait par « un disque lent » est corrigé : la ligne 3 est `MyStartTime`, pas l'heure d'écriture. |
| R4 | L'appartenance est redemandée sur une table fraîche JUSTE avant le `SIGKILL`. |
| tests | La ligne 3 lue sur disque est assertée ; le test `pg_ctl` est neutralisé en root et remplacé par son miroir. |

## Questions, par priorité

### P0 — reste-t-il un chemin vers un `SIGKILL` non confirmé ?

1. **Trace à nouveau le chemin complet**, en partant de `up.ts`. Avec les
   correctifs R1 et R4, tout pid tué est-il dans `ownedPostgresPids(...).owned`
   d'une lecture **fraîche** ? Nomme tout chemin restant — y compris
   `strangers`, la rotation de ports, `down.ts`, et le `taskkill /T` de la
   boucle non-postgres (un arbre peut-il contenir un postgres étranger ?).
2. **`unconfirmedReading`.** Hors Windows, elle rend `owned: [pid]` sur la
   seule foi de `livePostmasterPid` — donc ligne 2 vérifiée, mais **pas** la
   date (aucune table). C'est le trou de R2 rouvert sur cette plateforme.
   Faut-il refuser aussi là, au prix de ne plus jamais nettoyer sous Linux ?
   Dis ce que tu recommandes, et ce que ça coûte.
3. **La double lecture de R4.** `postgresProcessesForDataDir()` est rappelée
   après l'arrêt gracieux. Si cette seconde lecture ÉCHOUE (`read: false`), elle
   retombe sur `unconfirmedReading` : le postmaster est alors encore « à nous »
   par le fichier seul, et on tue. Est-ce le bon repli, ou faut-il ne rien tuer
   quand la revérification n'a pas pu se faire ?

### P1 — les effets de bord des refus

4. **Le cas « refusé mais vivant ».** `up` l'affiche et continue. Il démarre
   ensuite Postgres sur le même dossier, qui échouera sur le FATAL de mémoire
   partagée. Le message affiché aide-t-il vraiment, et arrive-t-il AVANT
   l'échec ? Que faudrait-il de plus pour que quelqu'un s'en sorte seul ?
5. **Les workers sans date.** Un `io_worker` réel porte-t-il toujours une
   `CreationDate` sous WMI ? Si non, R2 vient de rendre les workers
   inatteignables, et le cas de 2026-08-21 (worker survivant) n'est plus
   nettoyé du tout. C'est mon doute principal.
6. **2 secondes.** Est-ce assez pour une machine chargée, une VM, un démarrage
   à froid ? Entre `InitProcessGlobals` et la création du processus vue par
   Windows, quel écart réel peut-on attendre au pire ?

### P2 — le reste

7. `down.ts` utilise encore `livePostmasterPid` (constat 8 de la passe 4).
   Peut-il recommander l'arrêt d'un pid recyclé ? Si oui, c'est hors du
   périmètre de cette PR — dis-le, je le porterai en issue.
8. Les tests : chacun rougit-il sans son correctif ? En particulier celui de
   R4 (revérification avant kill) — existe-t-il seulement ?

## Hors périmètre

Le reste de `up.ts` ; style, nommage.

## Ce dont je doute moi-même

La question 5. En refusant une date manquante j'ai peut-être rendu le nettoyage
des workers impossible en pratique, c'est-à-dire cassé le cas pour lequel la
sonde a été écrite — sans qu'aucun test ne le voie, puisque mes lignes de test
portent toutes une date.

## Forme du rapport

Les constats d'abord (fichier:ligne, déclenchement, gravité), puis les huit
questions avec « tient » / « constat » / « NON TRANCHÉ ». Terminer par UNE
ligne : « rien de neuf », « des constats », ou « la forme est en cause ».
