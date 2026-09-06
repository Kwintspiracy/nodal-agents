## Réponses aux trois questions

### 1. `read-tree <fromSha>` est-il nécessaire ?

Non. Pour cette opération limitée à un seul chemin, un index initialement vide suffit :

1. créer l’index jetable vide ;
2. exécuter `git add -A -- <relPath>` ;
3. exécuter `git diff --cached <fromSha> -- <relPath>`.

Le pathspec final empêche les autres fichiers, absents de l’index vide, d’apparaître comme supprimés. Les cas utiles restent corrects :

- fichier créé : `add` l’insère ;
- fichier modifié : `add` insère son état courant ;
- fichier supprimé : il reste absent de l’index et le diff restreint au chemin produit sa suppression par rapport à `fromSha` ;
- fichier ignoré et absent de `fromSha` : il reste `not_in_snapshot`.

`read-tree` est donc correct, mais son coût proportionnel à la taille de l’arbre n’est pas nécessaire pour un clic portant sur un seul fichier.

Réponse déduite sans exécution.

### 2. Arrêt de Git et suppression de l’index jetable

`git diff --cached` ne devrait pas créer d’`index.lock` : il lit l’index sans le rafraîchir. Je ne vois pas de risque de zombie durable non plus : `child.kill()` termine le processus et Node conserve encore ses écouteurs jusqu’à l’événement `close`.

En revanche, la course de suppression Windows est réelle :

- **[P1, déduit sans exécution] [checkpoints.ts:207](D:/APPS/NodalAI/packages/checkpoints/src/checkpoints.ts:207) — le diff tronqué rend son résultat avant la fermeture effective de Git.**  
  Après `child.kill()`, `finish()` résout immédiatement la promesse. Le `finally` de [checkpoints.ts:428](D:/APPS/NodalAI/packages/checkpoints/src/checkpoints.ts:428) peut donc tenter de supprimer l’index pendant que Git possède encore son handle. Sous Windows, un `EBUSY`/`EPERM` est alors absorbé et le fichier `.diff-*` reste définitivement. Chaque fichier contient un index complet à cause de `read-tree`, donc une utilisation répétée sur de gros dépôts peut accumuler une quantité significative de données.

Il faut demander l’arrêt, mais ne résoudre qu’après `close`, en mémorisant que la sortie a été tronquée. La même course existe sur le chemin du timeout à [checkpoints.ts:188](D:/APPS/NodalAI/packages/checkpoints/src/checkpoints.ts:188).

### 3. Concurrence du tour CLI

La course existe à l’intérieur de cette fonction si deux exécutions du même job peuvent réellement l’atteindre simultanément :

- le tour est calculé à [run-job.ts:404](D:/APPS/NodalAI/apps/runner/src/cli-runtime/run-job.ts:404) ;
- le verrou d’écriture n’est pris qu’à [run-job.ts:459](D:/APPS/NodalAI/apps/runner/src/cli-runtime/run-job.ts:459) ;
- un runtime `read` ne prend aucun verrou ;
- `cli_runs` n’est inséré qu’après l’exécution, à [run-job.ts:605](D:/APPS/NodalAI/apps/runner/src/cli-runtime/run-job.ts:605).

Deux appels concurrents peuvent donc calculer le même nombre. Même deux appels `write` attendant le même verrou conserveraient le nombre calculé avant leur sérialisation.

Cela ne prouve cependant pas que la concurrence soit atteignable dans le chemin de production : l’exclusivité de réclamation du job peut l’interdire en amont. Dans le périmètre examiné, le verrou de workspace ne fournit pas cette garantie. Pour un tour `read`, la collision n’affecte pas un diff d’écriture puisqu’aucun checkpoint n’est pris et qu’aucun fichier ne devrait être modifié. Je ne classe donc pas ce point comme bloquant ici.

Réponse déduite sans exécution.

## Vérification des constats de la passe 42

| Constat de la passe 42 | État |
|---|---|
| P0 — `turn = NULL` sur les lignes CLI | Traité : `cliTurn` est calculé une fois à [run-job.ts:404](D:/APPS/NodalAI/apps/runner/src/cli-runtime/run-job.ts:404), porté par les audits à [run-job.ts:432](D:/APPS/NodalAI/apps/runner/src/cli-runtime/run-job.ts:432) et transmis au checkpoint à [run-job.ts:537](D:/APPS/NodalAI/apps/runner/src/cli-runtime/run-job.ts:537). Reste la réserve de concurrence décrite ci-dessus. |
| P0 — lecture modifiant l’index partagé | Traité : `diffFile` crée un index distinct à [checkpoints.ts:382](D:/APPS/NodalAI/packages/checkpoints/src/checkpoints.ts:382). Les snapshots ne partagent plus cet index. La suppression après interruption reste toutefois incorrectement synchronisée. |
| P1 — tampon de 8 Mio avant la coupe | Traité : le diff textuel passe désormais par le lecteur en flux de [checkpoints.ts:169](D:/APPS/NodalAI/packages/checkpoints/src/checkpoints.ts:169). |
| P2 — limite comptée en UTF-16 | Partiellement traité : la coupe porte maintenant sur un `Buffer`, mais le décodage d’une séquence UTF-8 coupée introduit un dépassement possible, décrit ci-dessous. |
| P2 — fragment annoncé comme « truncated » | Traité : [FileDiff.tsx:123](D:/APPS/NodalAI/apps/web/src/app/(dashboard)/spaces/FileDiff.tsx:123) annonce correctement que seule la comparaison ligne par ligne a été simplifiée. |
| Fichier créé puis supprimé pendant le tour | Inchangé, conformément à la demande : les deux états ne contiennent aucun contenu permettant de le reconstruire. |
| Instantané lent refusant le tour CLI | Inchangé et cohérent avec le contrat « fail loud ». |
| Clés positionnelles du fil | Inchangé, toujours non bloquant dans le comportement actuel d’ajout en fin de liste. |

## Constats supplémentaires non demandés

- **[P2, déduit sans exécution] [checkpoints.ts:197](D:/APPS/NodalAI/packages/checkpoints/src/checkpoints.ts:197) — le texte rendu peut dépasser `DIFF_MAX_BYTES` malgré la coupe du `Buffer`.**  
  Si l’octet 200 000 coupe un caractère UTF-8 multioctet, `Buffer.toString('utf8')` remplace la séquence incomplète par `U+FFFD`. Ce caractère occupe trois octets lorsqu’il est réencodé ; `Buffer.byteLength(text, 'utf8')` peut donc dépasser la limite d’un ou deux octets. Le test utilise des caractères non ASCII, mais ne garantit pas que la borne tombe au milieu d’un caractère. Il faut reculer jusqu’à une frontière UTF-8 valide ou définir explicitement que la limite porte sur les octets avant décodage.

Je n’ai pas exécuté les tests : le contrôle demandé porte sur l’état committé, tandis que l’arbre de travail contient les modifications non committées explicitement exclues.

## Constats bloquants

1. [checkpoints.ts:207](D:/APPS/NodalAI/packages/checkpoints/src/checkpoints.ts:207) — résolution avant `close` après `child.kill()`, pouvant laisser durablement des index `.diff-*` sous Windows.