## P0 — sécurité et exactitude du diff

### 1. Confinement du chemin

Pas de traversée lexicale exploitable identifiée.

`resolveScannedPath` peut produire un chemin contenant `..`, mais [file-diff.ts:206](D:/APPS/NodalAI/apps/runner/src/routes/file-diff.ts:206) le repasse par `relative(workspace, abs)` et [file-diff.ts:207](D:/APPS/NodalAI/apps/runner/src/routes/file-diff.ts:207) refuse ensuite tout résultat commençant par `../`. Un chemin absolu extérieur ne sélectionne par ailleurs aucune racine à [file-diff.ts:184](D:/APPS/NodalAI/apps/runner/src/routes/file-diff.ts:184).

Pour un lien symbolique interne pointant dehors, la route n’applique effectivement pas la protection `realpath` de [workspace.ts:151](D:/APPS/NodalAI/packages/tools/src/builtin/file-ops/workspace.ts:151). Cependant, le contenu est lu exclusivement par Git avec un pathspec relatif : Git versionne le lien lui-même et ne suit pas un lien symbolique dans un composant du chemin. Je n’ai donc pas trouvé de scénario permettant de lire le fichier cible extérieur.

Conclusion : pas de constat sur ce point.

### 2. Index Git partagé et concurrence

- **[P0, déduit sans exécution] [checkpoints.ts:300](D:/APPS/NodalAI/packages/checkpoints/src/checkpoints.ts:300) — une simple lecture de diff peut faire échouer un prochain tour d’écriture.**  
  `diffFile` exécute `git add` sur le même `GIT_INDEX_FILE` par workspace que `snapshot` ([checkpoints.ts:111](D:/APPS/NodalAI/packages/checkpoints/src/checkpoints.ts:111), [checkpoints.ts:198](D:/APPS/NodalAI/packages/checkpoints/src/checkpoints.ts:198)), sans verrou partagé avec celui-ci. Scénario concret : deux panneaux sont ouverts pendant que le tour suivant prend son instantané ; une commande détient `index.lock`, le `git add -A` du snapshot échoue, puis le runtime refuse entièrement le tour avec `checkpoint_failed`. La lecture concurrente peut également échouer silencieusement puisque son `git add` est absorbé par `.catch(() => '')`, puis rendre transitoirement `not_in_snapshot` ou `unchanged` depuis un index périmé. Git protège normalement l’index contre une corruption physique, mais le comportement fonctionnel reste incorrect et le GET a un effet de bord bloquant.

Il faut sérialiser toutes les opérations utilisant l’index d’un workspace, ou calculer le diff avec un index temporaire propre à la requête.

### 3. Tour des lignes CLI

- **[P0] [audit.ts:44](D:/APPS/NodalAI/apps/runner/src/cli-runtime/audit.ts:44) et [run-job.ts:413](D:/APPS/NodalAI/apps/runner/src/cli-runtime/run-job.ts:413) — tous les diffs du harnais CLI sont indisponibles.**  
  `buildCliAuditRow` ne possède ni argument ni champ `turn`, et l’insertion de `run-job.ts` n’en ajoute pas. La colonne nullable reçoit donc `NULL`. À [file-diff.ts:187](D:/APPS/NodalAI/apps/runner/src/routes/file-diff.ts:187), la route répond systématiquement `no_checkpoint` avant même de rechercher la ligne prise par `takeCliTurnCheckpoints`. Scénario concret : Claude Code ou Codex écrit `src/a.ts`, la carte « fichiers » apparaît, mais son ouverture affiche « No diff: written before snapshots were kept » malgré l’instantané correctement inséré.

Le numéro calculé par `takeCliTurnCheckpoints` doit être retourné ou calculé une seule fois, puis transmis à toutes les lignes `tool_calls` du tour.

### 4. Fichier neuf ou créé puis supprimé

Un fichier neuf encore présent fonctionne : `git add -A -- <relPath>` le place dans l’index, puis `git diff --cached <fromSha>` produit un diff intégralement en `+`. Avec un instantané suivant, `ls-tree` le retrouve également.

Un fichier créé puis supprimé dans le même tour est absent des deux bornes ; [checkpoints.ts:305](D:/APPS/NodalAI/packages/checkpoints/src/checkpoints.ts:305) le classe donc `not_in_snapshot`. Le système ne conserve aucun état intermédiaire permettant d’en reconstruire le contenu. C’est une limitation réelle, mais cohérente avec un modèle « avant/après le tour » ; elle devrait seulement être documentée si ces fichiers éphémères doivent apparaître dans le fil.

## P1

### 5. Échec d’instantané du harnais

Le changement peut effectivement refuser un runtime CLI auparavant fonctionnel : `snapshot` a une limite de 30 secondes à [checkpoints.ts:42](D:/APPS/NodalAI/packages/checkpoints/src/checkpoints.ts:42), et `takeCliTurnCheckpoints` transforme l’échec en refus du tour.

Les principaux répertoires régénérables sont exclus, notamment `node_modules`, mais un workspace contenant plusieurs gigaoctets non ignorés peut toujours dépasser la borne. Ce contrat est cohérent avec le filet déjà imposé aux outils Nodal et avec l’invariant « fail loud ». Je ne recommande pas une échappatoire silencieuse. Si un réglage est ajouté, il doit être explicite, visible et désactiver clairement la garantie de restauration.

### 6. Propagation de `ToolStep.jobId`

C’est cohérent avec le reste du fil : le `jobId` provient du job qui construit chaque étape, puis accompagne aussi bien les cartes normales que celles de délégation ou de question. Je n’ai pas relevé de confusion parent/enfant dans ce commit.

### 7. Rafraîchissement et état du panneau

`router.refresh()` fusionne la nouvelle réponse serveur sans réinitialiser normalement l’état des composants clients conservés. Le panneau et son cache local devraient donc survivre.

Le code utilise toutefois des clés positionnelles à [ConversationFeedView.tsx:39](D:/APPS/NodalAI/apps/web/src/app/(dashboard)/spaces/ConversationFeedView.tsx:39) et [ConversationFeedView.tsx:340](D:/APPS/NodalAI/apps/web/src/app/(dashboard)/spaces/ConversationFeedView.tsx:340). Dans le flux actuel, les nouveaux éléments et fichiers sont normalement ajoutés après les anciens, donc leurs indices restent stables. Je n’en fais pas un constat bloquant, mais une insertion ou un réordonnancement futur pourrait transférer ou perdre l’état d’un panneau.

## P2

### 8. Texte « No diff »

Conforme à l’invariant retenu : le runner ne renvoie que des codes, tandis que les phrases utilisateur vivent dans [FileDiff.tsx:25](D:/APPS/NodalAI/apps/web/src/app/(dashboard)/spaces/FileDiff.tsx:25).

### 9. Bornes annoncées

Les deux bornes sont annoncées par « … truncated » à [FileDiff.tsx:86](D:/APPS/NodalAI/apps/web/src/app/(dashboard)/spaces/FileDiff.tsx:86).

- **[P1, déduit sans exécution] [checkpoints.ts:324](D:/APPS/NodalAI/packages/checkpoints/src/checkpoints.ts:324) — la borne de 200 Ko ne protège pas les gros diffs.**  
  Le diff complet est d’abord capturé par `execFile`, dont `maxBuffer` vaut 8 Mio, et n’est tronqué qu’ensuite à [checkpoints.ts:332](D:/APPS/NodalAI/packages/checkpoints/src/checkpoints.ts:332). Scénario concret : une CLI remplace un fichier texte de 10 Mio ; `execFile` rejette la sortie avant que la coupe à 200 Ko soit appliquée, et la route affiche « folder no longer reachable » au lieu d’un diff tronqué. Il faut limiter la sortie pendant sa lecture, ou traiter spécifiquement le dépassement de tampon.

Pour `fragmentDiff`, les 2 000 lignes bornent le calcul LCS, mais le résultat contient encore l’intégralité des deux fragments sous forme de remplacement en bloc. Le libellé « truncated » signifie donc ici « diff fin abandonné », pas « contenu coupé ».

## Constats supplémentaires

- **[P2, déduit sans exécution] [checkpoints.ts:332](D:/APPS/NodalAI/packages/checkpoints/src/checkpoints.ts:332) — `DIFF_MAX_BYTES` ne mesure pas des octets.**  
  `text.length` compte les unités UTF-16 JavaScript. Scénario concret : un diff largement composé de caractères non ASCII peut produire une réponse sensiblement supérieure aux 200 000 octets annoncés. Renommer la constante en limite de caractères ou tronquer un `Buffer` rendrait le contrat exact.

## Constats bloquants

1. Les lignes `tool_calls` du harnais CLI ont `turn = NULL`, donc son diff ne fonctionne jamais.
2. Le GET de diff partage et modifie l’index des snapshots sans sérialisation, ce qui peut faire échouer un tour d’écriture ou rendre un résultat transitoirement faux.