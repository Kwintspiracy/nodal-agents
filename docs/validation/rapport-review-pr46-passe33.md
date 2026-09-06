## P0

### 1. Transaction et trois sites d’appel

Aucun des trois appelants ne transmet une transaction existante :

- [`packages/tools/src/execute.ts:411`](D:/APPS/NodalAI/packages/tools/src/execute.ts:411) transmet directement `ctx.db`.
- [`apps/runner/src/cli-runtime/run-job.ts:548`](D:/APPS/NodalAI/apps/runner/src/cli-runtime/run-job.ts:548) transmet le `db` reçu par `runCliRuntimeJob`.
- [`apps/runner/src/cli-runtime/run-chat.ts:327`](D:/APPS/NodalAI/apps/runner/src/cli-runtime/run-chat.ts:327) transmet le `db` reçu par `runCliRuntimeChatTurn`.

Dans ces trois chemins, `attachProductionToProject` ouvre donc une transaction de premier niveau. Je ne trouve pas de risque actuel de transaction imbriquée ou de SAVEPOINT inattendu.

### 2. `attach_registered_not_matched`

Les deux passages couvrent les cas ordinaires :

1. comparaison lexicale entre la cible originale et les racines enregistrées ;
2. comparaison après `realPathOf` des deux côtés pour les jonctions et alias résolvables.

Il subsiste un cas où une déclaration peut être immédiatement annulée.

**Constat P1 — déduit sans exécution.**  
[`packages/tools/src/projects/attach.ts:245`](D:/APPS/NodalAI/packages/tools/src/projects/attach.ts:245) transforme la cible avec `realPathOf` seulement après l’échec lexical, puis [`packages/tools/src/projects/attach.ts:257`](D:/APPS/NodalAI/packages/tools/src/projects/attach.ts:257) lève `attach_registered_not_matched`. Si le fichier cible a déjà disparu et si sa graphie est un alias que `realPathOf` ne peut plus résoudre, la cible conserve cet alias tandis que la racine existante est résolue sous une autre graphie.

Scénario concret : le workspace enregistré est `C:/Developpement/app`, l’outil rapporte puis supprime `C:/DEVELO~1/app/src/temp.ts`. `rebaseOntoLexicalRoots` permet de dériver et déclarer `C:/Developpement/app`, mais le premier rattachement échoue entre les deux graphies ; le fichier supprimé empêche ensuite de résoudre `C:/DEVELO~1/...`, alors que la racine devient son chemin long. Les deux comparaisons échouent, la transaction annule la déclaration et rend `attach_registered_not_matched`.

Ce n’est pas un rollback systématique pour une jonction ou un nom court : tant que la cible existe, le second passage fonctionne. C’est la combinaison « alias différent + cible disparue avant le rattachement » qui reste perdue.

### 3. Projet déjà déclaré sans ancre valide

Le comportement est cohérent avec le contrat annoncé. À [`packages/tools/src/projects/attach.ts:303`](D:/APPS/NodalAI/packages/tools/src/projects/attach.ts:303), l’absence de job et la conversation introuvable ne provoquent un rollback que si cet appel vient de déclarer une ligne.

Pour un projet déjà déclaré, la fonction rend donc toujours `attached` avec `conversation: 'not_found'`. Rien dans les trois appelants ne dépend d’une déclaration effectuée avant la validation des ancres : ils ignorent tous l’issue du registre, conformément au caractère non bloquant de celui-ci.

## P1

### 4. Chemins relatifs avec plusieurs workspaces

La divergence est réelle et peut attribuer une production au mauvais projet.

**Constat P1 — déduit sans exécution.**  
[`apps/runner/src/cli-runtime/run-job.ts:180`](D:/APPS/NodalAI/apps/runner/src/cli-runtime/run-job.ts:180) appelle `resolveScannedPath(..., () => true)`. Avec plusieurs workspaces et un chemin relatif non labellisé, le premier candidat est donc toujours retenu.

[`apps/runner/src/cli-runtime/codex-turn.ts:244`](D:/APPS/NodalAI/apps/runner/src/cli-runtime/codex-turn.ts:244) recopie le champ `path` de l’événement Codex dans `file_path`, sans le rendre absolu ni lui ajouter le label du workspace. Le commentaire du fichier précise par ailleurs que cette forme a été déduite des symboles du binaire et non observée sur un flux d’écriture réel. Le code ne permet donc pas d’affirmer que les chemins Codex sont toujours absolus.

Scénario concret : un agent possède `[app-a, app-b]`, Codex reçoit `app-b` par `--add-dir` et rapporte `src/index.ts` après y avoir écrit. `harnessEdits` fabrique `app-a/src/index.ts`. Si `app-a` porte un manifeste, le mauvais projet est déclaré ou rattaché ; `app-b` ne l’est pas. L’onglet Code peut simultanément attribuer la même ligne à `app-b` si seul ce fichier existe sur disque.

Pour Claude Code, les événements usuels fournissent des chemins absolus, mais aucune normalisation au seam ne garantit ce contrat non plus.

### 5. Fenêtre de scan et cache

La limite est fonctionnelle mais doit être décrite comme un backfill borné, pas comme un rattachement exhaustif de l’historique :

- seuls les jobs représentés dans les 1 500 dernières lignes d’édition peuvent être rattachés ;
- un cache construit juste avant une nouvelle ligne peut l’omettre pendant 60 secondes ;
- les nouvelles productions passent normalement par le rattachement au fil de l’eau.

Les jobs anciens exclus de la fenêtre ne seront jamais récupérés par ce backfill. C’est acceptable si le besoin est explicitement « rattacher l’historique encore visible dans l’onglet Code ». Cela ne satisfait pas une promesse d’historique complet.

### 6. Correction de `registered_at` en base de développement

Pas de doute supplémentaire dans le périmètre indiqué. La version erronée n’ayant jamais été publiée, une migration corrective générale modifierait inutilement les installations. Le code committé utilise désormais l’instant du backfill à [`apps/runner/src/bootstrap/backfill-registered-projects.ts:108`](D:/APPS/NodalAI/apps/runner/src/bootstrap/backfill-registered-projects.ts:108).

## P2

### 7. Double journalisation de la panne de `markJob`

Ce n’est pas gênant fonctionnellement :

- `markJob` journalise la cause précise ;
- le `catch` journalise l’annulation transactionnelle avec le même code et les identifiants du contexte.

Cela produit deux événements pour un seul incident et peut gonfler un compteur naïf fondé sur les lignes de logs, mais aucune donnée ni issue retournée n’est fausse. Non bloquant.

## Vérification des constats de la passe 32

- **Tour réussi sans édition déclarant le terrain : traité.** Les cibles `dir` ne déclarent plus ; elles peuvent seulement rattacher à une ligne existante.
- **`agent_id` non déterministe : traité.** Plusieurs détenteurs donnent `NULL`.
- **`registered_at` représentant la dernière activité : traité.** Le backfill utilise `new Date()`.
- **Fichier écrit puis supprimé : traité pour le cas courant relatif au `cwd`.** La résolution ne consulte plus son existence. Le cas d’un alias devenu irrésolvable reste couvert par le constat P1 ci-dessus.
- **Deux alias lexicaux d’une jonction : non traité, explicitement reporté à D10.** Le doublon physique demeure possible.
- **Compteur `skipped` trop pauvre : traité.** Les quatre raisons sont séparées.
- **Déclaration avant validation des ancres : traité.** Déclaration, job et conversation partagent la transaction ; une nouvelle déclaration sans ancre est annulée.
- **Déclaration partielle de plusieurs racines : traitée.** Les upserts et rattachements sont dans la même transaction.

## Constats hors questions

**Constat P1 — déduit sans exécution : course entre l’audit CLI et `harnessEdits`.**  
[`apps/runner/src/cli-runtime/run-job.ts:355`](D:/APPS/NodalAI/apps/runner/src/cli-runtime/run-job.ts:355) lance chaque insertion `tool_calls` avec `void db.insert(...)`, sans conserver ni attendre la promesse. Après la fin du processus, [`apps/runner/src/cli-runtime/run-job.ts:545`](D:/APPS/NodalAI/apps/runner/src/cli-runtime/run-job.ts:545) interroge immédiatement ces lignes avec `harnessEdits`.

Scénario concret : le dernier événement Codex ou Claude modifie `terrain/app/src/a.ts`, puis le processus termine aussitôt. L’insertion asynchrone est encore en vol lorsque `harnessEdits` exécute son `SELECT`. `edits` est vide ; si le tour a produit du texte, le repli transmet seulement les workspaces comme cibles `dir`. Le nouveau projet `terrain/app` n’est donc pas déclaré malgré une écriture réelle. L’insertion finit ensuite, trop tard pour ce tour.

La correction de la passe 32 rend cette course plus visible : auparavant le repli `dir` pouvait déclarer le terrain ; désormais il ne peut volontairement plus déclarer quoi que ce soit. Il faut attendre toutes les insertions d’audit du tour avant d’appeler `harnessEdits`, sans pour autant rendre leur éventuel échec bloquant pour le travail exécuté.

Aucun test n’a été exécuté : le profil de cette session est en lecture seule. Les constats sont issus de l’inspection statique des commits et des fichiers `HEAD`.

## Constats bloquants

Aucun constat bloquant.