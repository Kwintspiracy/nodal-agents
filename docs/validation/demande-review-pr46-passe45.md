# Demande de review — PR #46, passe 45 (les constats de la passe 43 sur P11)

Périmètre : **un commit**, `80ee7a8d` (`packages/checkpoints/src/checkpoints.ts`, son test, le
rapport 43), qui répond à la passe 43 (`docs/validation/rapport-review-pr46-passe43.md`). Un
agent code P12 en parallèle dans d'autres fichiers (xlsx, presenters, tool-cards,
conversation-actions, ConversationFeedView), NON committé : relire l'état COMMITTÉ, jamais
l'arbre.

- `gitRawCapped` : après `child.kill()` (coupe atteinte, ou délai), la promesse ne se règle
  qu'à `close` ; `timedOut` mémorisé et rejeté à `close` ; un `code` non nul APRÈS une coupe
  volontaire n'est pas une erreur.
- `cutAtUtf8Boundary(buf, max)` : recule depuis `max` tant que l'octet est un octet de
  continuation (`10xxxxxx`), puis coupe — aucun U+FFFD, la borne en octets est vraie.
- `diffFile` (arbre de travail) : l'index jetable part VIDE (plus de `read-tree`), `add -A --
  relPath`, `ls-files --cached -- relPath`, `diff --cached <fromSha> -- relPath`.
- Tests : suppression d'un fichier depuis l'instantané → `-un`, `-deux`, pas de `+` ; coupe au
  milieu d'un « é » (lignes de 15 octets, 200 000 mod 15 = 5 → au milieu du 3e caractère) →
  `truncated`, ≤ 200 000 octets, aucun U+FFFD ; les 26 cas précédents inchangés (index du
  dossier intact, aucun `.diff-*` restant, diff géant).

## Réponses aux constats de la passe 43

| Constat 43 | Réponse |
|---|---|
| Bloquant — résolution avant `close`, index orphelin sous Windows | réglé à `close`, délai compris |
| P2 — U+FFFD dépasse la borne | frontière UTF-8 |
| Q1 — `read-tree` inutile | retiré ; index vide + pathspec |
| Q3 — tour CLI calculé avant les verrous | INCHANGÉ : noté ; un tour `read` n'écrit rien, et deux tours `write` du même job sont sérialisés par le verrou de dossier (à confirmer par toi : le nombre calculé avant l'attente du verrou reste-t-il le bon après l'attente ? Le `cli_runs` du tour précédent est inséré APRÈS son exécution, donc AVANT que le suivant n'obtienne le verrou — mais le suivant a calculé son tour AVANT d'attendre) |

## Mesuré

checkpoints 28 ; lint 0. Mutation rouge : coupe brute sans frontière UTF-8 → le test « la coupe
ne tranche jamais un caractère » rougit.

## Questions

1. **Q3 de la passe 43, précisément** : deux tours `write` du même job lancés à quelques
   secondes d'écart — le second calcule `cliTurn` AVANT `acquireWorkspaceLocks`, attend, puis
   s'exécute avec un numéro déjà pris par le premier (dont la ligne `cli_runs` est arrivée
   pendant l'attente). Conséquence : `job_checkpoints (job, turn, workspace)` → `ON CONFLICT
   DO NOTHING` garde le sha du PREMIER, et les lignes d'audit du second pointent l'état d'avant
   du premier — un diff faux. Est-ce atteignable (deux `runCliRuntimeJob` pour le même job en
   même temps : la réclamation du job l'interdit-elle en amont) ? Si oui, le tour doit être
   calculé APRÈS l'obtention des verrous (vérifier que `onEvent` peut alors le lire par une
   variable assignée avant `binding.run`).
2. `close` après `kill()` sur Windows : `child.kill()` sans signal envoie `SIGTERM` → sur
   Windows Node termine le processus ; `close` arrive-t-il toujours (même si git a déjà tout
   écrit) ? Un cas où `close` ne vient pas et la promesse ne se règle jamais (le `timer` est
   levé à `close` seulement) ?

## Ce qui n'est PAS attendu

Le style. Un constat désigne un fichier, une ligne, et ce qui casse.
