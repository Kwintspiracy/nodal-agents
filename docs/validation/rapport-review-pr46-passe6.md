# Rapport — review Codex PR #46, passe 6

Périmètre : le commit `64b2c9d0`, qui traite les deux P0 de la passe 5. Sandbox
lecture seule ; Codex a tenté de lancer Vitest, la politique l'a refusé, et il
marque chaque constat **NON EXÉCUTÉ**. La revue est donc statique.

## Le constat qui a payé

### P2 — le témoin du cas UNC était insuffisant

Codex : dans mon test « les deux graphies UNC du même classeur n'en font qu'un »,
la première cible produit déjà le résultat attendu ; la seconde pouvait être
ignorée sans que rien ne rougisse.

**Il avait raison, et le trou cachait un vrai bug.** J'ai scindé le test en deux
témoins, et le témoin isolé de la graphie en antislashs a rougi aussitôt : ma
chaîne de test avait été mangée par le shell à l'écriture (`'\\SRV\part\...'`
au lieu de `'\\\\SRV\\part\\...'`), si bien que la cible ne désignait plus rien
et était silencieusement écartée. Le test de déduplication était vert parce
qu'il ne restait qu'une cible, pas parce que les deux convergeaient.

Corrigé : deux tests distincts, et l'échappement écrit avec l'éditeur, jamais
par le shell.

### P1 — le test du lot mixte ne prouvait pas la garantie de verrouillage

Codex : ce test resterait vert si la passe dédiée était supprimée, puisqu'un
seul type verrouille aujourd'hui et que l'ordre par (type, clé) coïncide avec
l'ordre par clé.

**Constat vérifié.** La règle ne pouvait pas se prouver par la base, faute d'un
second type verrouillant. Elle est donc extraite en fonction pure exportée
(`codeProjectLockOrder`) et testée avec un ensemble de types arbitraire, sur un
cas où les deux ordres diffèrent. Vérifié par mutation : retirer le tri fait
rougir le test. La déduplication par clé est ajoutée au passage — Codex notait
qu'à défaut, deux types désignant la même ligne l'incrémenteraient deux fois.

## Le constat non fermé, et pourquoi

### P0 — un outil qui écrit sans porter `mutatesWorkspace`

Codex : la garde ferme « marqué mutant mais sans hook » ; elle ne ferme pas
« écrit sans se déclarer mutant ». Le test d'architecture construit son univers
avec `filter(mutatesWorkspace === true)`, donc il ne peut pas voir ce cas.

**Le constat tient, et il est hors du périmètre de v7-A.** Il porte sur un
marqueur antérieur à toute cette PR, que le système de checkpoints utilise
depuis longtemps.

Il n'est pas fermable mécaniquement à bon compte : prouver qu'une fonction écrit
demande de l'exécuter, et les deux proxys statiques disponibles sont faux dans
les deux sens. Un import de `node:fs` est porté aussi par des outils de lecture.
`resolveAndCheckPath`, la porte d'un chemin de workspace, est partagée avec
`file_read`, `file_list` et `file_search`.

Ce que la revue a fait remonter d'actionnable : **le commentaire du champ était
faux**. Il disait « les outils qui écrivent sur le disque », plus large que la
règle réelle. `skill_file_write` écrit sur le disque, dans le dossier d'une
skill, qui n'est ni un workspace ni un livrable — correctement non marqué, et un
lecteur suivant l'ancienne formulation l'aurait marqué à tort. Le champ dit
maintenant la règle exacte et nomme ce qu'il ne garantit pas.

Le reste est un ticket, consigné dans le plan avec ses deux pistes.

## Ce que Codex a confirmé

La passe de verrous donne bien un ordre total sans interblocage, et un futur
type ajouté à l'ensemble rejoint la même passe.

## État après la passe

| Suite | Résultat |
|---|---|
| `packages/shared` | 434 |
| `packages/tools` | 824 (+1 ignoré) |
| `apps/runner` | 1245 (+2 ignorés) |
| `apps/web` | 1048 |

## Où en est la boucle

Passe 5 : deux P0 dans le code, fermés. Passe 6 : deux constats sur mes propres
tests, fermés, dont un qui cachait un bug réel ; plus un constat hors périmètre,
consigné. Aucune passe n'a redécouvert un constat déjà traité. La boucle
continue tant qu'une passe trouve du neuf.
