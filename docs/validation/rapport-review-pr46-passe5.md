# Rapport — review Codex PR #46, passe 5 (delta v7-A)

Périmètre : les deux commits du delta v7-A (`22255204`, `5198a8ee`). Sandbox
lecture seule ; Codex n'a donc **exécuté aucune suite** et le dit lui-même sur
chaque constat. `git diff --check` a tourné, sans remontée.

## Constats traités

### P0 — le hook n'était pas obligatoire, et le seam retombait sur un littéral

**Le constat tient.** Vérifié à la source : `resolveMutationTargets` est
optionnel dans `ToolDefinition`, et `takeMutationIntent` fabriquait alors des
cibles « tous les workspaces attachés, en `code_project` ». Autrement dit, le
littéral de classement que v7-A retire du helper d'intention était réintroduit
dans le runtime, deux fichiers plus loin.

Mon message de commit annonçait « une erreur du compilateur ». C'était faux : le
compilateur impose le CHAMP sur une cible construite, pas la PRÉSENCE du hook.

**Correction appliquée.** Le repli est supprimé. Un outil mutant sans hook est
refusé (`intent_no_targets_hook`), son écriture n'a pas lieu, et un code est
journalisé. Deux tests couvrent le refus : la sonde du registre, et `file_write`
privé de son hook.

**Correction refusée, avec sa mesure.** Codex demandait un contrat discriminé
(hook obligatoire quand `mutatesWorkspace: true`). Essayé, mesuré, retiré :
l'intersection d'une union avec l'interface fait perdre la bivariance de
paramètres dont dépend tout `ToolDefinition<SchémaPrécis>` stocké dans un
registre de `ToolDefinition<z.ZodTypeAny>` — **204 erreurs**, toutes sur des
champs sans rapport (`preflight`, `computeApproval`). Le prix serait des
`as never` partout, donc un typage plus faible, pas plus fort.

Le couple est donc imposé par un test qui le dit **en toutes lettres**
(`intent-wiring.test.ts`), pas déduit de l'échec d'un autre test. Même mécanisme
que les invariants #1, #2 et #6, et la raison est écrite sur le champ.

### P0 — l'ordre de verrouillage reposait sur le type, pas sur le verrou

**Le constat tient, sans bug aujourd'hui.** Codex confirme qu'aucun interblocage
n'existe : `office_file` ne verrouille rien, et `code_project` tombe premier en
ordre alphabétique. Mais le raisonnement « je trie par (type, clé) donc mes
verrous sont ordonnés » est vrai par accident, et faux au premier type qui
partagerait `code_projects`.

**Correction appliquée.** La transaction prend désormais **tous** les verrous
dans une passe dédiée, triée par clé, sur les livrables d'une liste déclarée
(`TYPES_LOCKING_CODE_PROJECTS`). L'ordre ne dépend plus du tri des livrables.
Le tri par (type, clé) reste, pour la stabilité de la liste rendue, et son
commentaire dit maintenant qu'il ne garantit pas les verrous.

## Réponses de Codex retenues telles quelles

| Question | Réponse | Suite |
|---|---|---|
| Lot mixte dont un type est non branché | Refus intégral, seul arbitrage cohérent : l'outil mute de façon atomique après le seam | Test ajouté — le cas mixte n'était pas couvert |
| Spread dans `rebaseOntoLexicalRoots` | Aucune casse ; préserver les champs futurs est cohérent | Rien à faire |
| `office_file.runProof` qui lève | Garde utile, à garder | Rien à faire |

## Lacunes de couverture comblées

Codex a relevé que `resolveFileDeliverables` n'avait **aucun test direct**. Huit
cas ajoutés : fichier à la racine attachée, fichier niché, partage UNC avec
repli de casse, casse POSIX distincte, hors périmètre, racine de disque,
dossier passé en cible fichier, tri et déduplication.

## Copie d'écran

Codex : la phrase « is a document » sortait d'un `else`, donc elle serait fausse
le jour où un envoi atteindrait cette liste. Le branchement est maintenant
explicite par type, avec une phrase neutre par défaut, et un test le vérifie sur
`outbound_action`.

## État après la passe

| Suite | Résultat |
|---|---|
| `packages/shared` | 433 |
| `packages/tools` | 820 (+1 ignoré) |
| `apps/runner` | 1245 (+2 ignorés) |
| `apps/web` | 1048 |
| dependency-cruiser | 1768 modules, aucune violation |

Note Windows : les trois suites `*.pg.test.ts` échouent au **démontage** quand
toute la suite runner tourne en parallèle (`EBUSY: rmdir` sur le dossier
Postgres temporaire), et passent seules. Ce n'est pas un échec de test — les
1245 assertions passent dans les deux cas — et ces suites sont de toute façon
exclues du job Windows de la CI.
