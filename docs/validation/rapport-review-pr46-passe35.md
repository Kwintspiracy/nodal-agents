## P0

### 1. Borne et lecture suivante

Le contrat d’éventuelle cohérence — lire après cinq secondes ce qui est déjà enregistré, puis laisser le backfill rattacher éventuellement le job — est acceptable en tant que compromis fonctionnel explicite.

La borne ne garantit toutefois pas la propriété annoncée « audit jamais bloquant ».

**Constat P0 — déduit sans exécution.**  
[`apps/runner/src/cli-runtime/run-job.ts:73`](D:/APPS/NodalAI/apps/runner/src/cli-runtime/run-job.ts:73) abandonne uniquement l’attente de l’insertion : le `Promise.race` ne l’annule pas. La requête PostgreSQL et la connexion qu’elle occupe continuent après le timeout. Le pool est limité par défaut à dix connexions dans [`packages/db/src/client.ts:28`](D:/APPS/NodalAI/packages/db/src/client.ts:28), sans `statement_timeout`.

Scénario concret : dix tours rencontrent chacun une insertion `tool_calls` dont la connexion reste établie mais ne répond plus. Chaque tour franchit sa première borne de cinq secondes, mais les dix connexions demeurent occupées. Le prochain `harnessEdits` attend alors une connexion libre sans aucune borne ; le tour reste de nouveau bloqué avant sa finalisation. Les écritures tardives peuvent également s’accumuler et épuiser le pool ou la mémoire, même si chaque attente locale a expiré.

Il faut annuler réellement la requête à la borne, isoler l’audit dans une ressource bornée, ou garantir une limite côté base/transport. La seule cessation de l’`await` ne suffit pas.

Concernant la ligne orpheline elle-même : oui, elle correspond au contrat documenté, avec la limite déjà reconnue que le backfill ne couvre que la fenêtre de `SCAN_LIMIT`. Un job trop ancien au prochain boot peut donc rester définitivement avec `project_id = NULL`.

### 2. `Promise.race` et nettoyage du timer

Pas de piège dans `clearTimeout` :

- si `allSettled` gagne, le timer encore planifié est annulé ;
- si le timer gagne, il est déjà consommé et `clearTimeout` est sans effet ;
- aucune exception ni fuite de timer n’en résulte.

En revanche, les réactions attachées par `Promise.allSettled` restent associées aux promesses qui n’aboutissent jamais. C’est une conséquence du défaut d’annulation décrit ci-dessus, pas une fuite du timer lui-même.

## P1

### 3. `uncRoot` pour `//serveur/x.ts`

Le comportement est cohérent. En syntaxe UNC, `//serveur/x.ts` désigne la racine d’un partage nommé `x.ts`, et non un fichier placé directement sous un serveur sans partage. La fonction tente cette racine une fois ; si elle n’existe pas, elle rend le chemin normalisé sans jamais sonder `//serveur`.

Un prétendu fichier sous un serveur sans nom de partage est invalide et indiscernable lexicalement d’une racine de partage. Il n’y a donc pas de comportement supplémentaire pertinent à implémenter ici.

### 4. Mock de `node:fs`

Le mock couvre correctement l’import nommé utilisé par `markers.ts` sous Vitest : le namespace réel est étalé, puis l’export `realpathSync` est remplacé par une fonction portant elle-même une propriété `native`. `existsSync` reste l’export réel.

Il n’y a pas de risque produit lié à un autre bundler : ce fichier est un test Vitest et `vi.mock` est transformé et hissé par Vitest. Ce double n’est pas destiné à être exécuté par le bundler du runner.

## Vérification des constats de la passe 34

- **P0 — attente sans limite : partiellement traité.** Le job n’attend plus directement la promesse au-delà de cinq secondes, mais la requête n’est pas annulée et peut épuiser le pool, puis rebloquer `harnessEdits`. Le constat P0 reste donc ouvert sous une forme indirecte.
- **P1 — test temporel non déterministe : non traité complètement.**

  **Constat P1 — déduit sans exécution.**  
  [`apps/runner/src/tests/cli-runtime/intent-cli-runtime.test.ts:589`](D:/APPS/NodalAI/apps/runner/src/tests/cli-runtime/intent-cli-runtime.test.ts:589) remplace 80 ms par 1 500 ms, mais repose toujours sur le temps calendaire. L’assertion de durée ne prouve pas que `settleAuditWrites` a causé l’attente.

  Scénario concret : sur une CI bloquée plus de 1,5 seconde entre le début du tour et `harnessEdits`, l’insertion retardée se termine avant la lecture. Si l’appel à `settleAuditWrites` est supprimé, le projet est quand même déclaré et la durée totale dépasse quand même `DELAI - 50` ; la mutation fautive reste verte.

  Un test déterministe peut être construit sans point d’accroche de production, par exemple avec un double de DB qui retient l’insertion et détecte/interdit le `select` de `tool_calls` tant que cette insertion n’a pas été libérée.
- **P1 — remontée UNC : traité.** [`packages/tools/src/projects/markers.ts:53`](D:/APPS/NodalAI/packages/tools/src/projects/markers.ts:53) empêche bien toute sonde plus courte que `//serveur/partage`.
- **P1 — casse Windows rappendue : aucun constat antérieur à corriger.**
- **P1 — proxy sans `.returning()` : choix assumé et toujours acceptable.** Une évolution incompatible ferait échouer explicitement le test.

## Constats hors questions

Je n’ai pas trouvé d’autre constat dans les fichiers committés touchés par `4f084c21` et `a03a2c34`.

Les tests n’ont pas été réexécutés : l’arbre de travail contient les modifications étrangères signalées et la session ne permet pas de créer un worktree propre. L’analyse ci-dessus est donc fondée exclusivement sur les commits et les versions `HEAD`, via `git show`.

## Constats bloquants

- **P0 — [`apps/runner/src/cli-runtime/run-job.ts:73`](D:/APPS/NodalAI/apps/runner/src/cli-runtime/run-job.ts:73) : la borne cesse d’attendre mais n’annule pas les insertions figées ; celles-ci peuvent épuiser le pool, après quoi `harnessEdits` bloque de nouveau sans limite.**
- **P1 — [`apps/runner/src/tests/cli-runtime/intent-cli-runtime.test.ts:589`](D:/APPS/NodalAI/apps/runner/src/tests/cli-runtime/intent-cli-runtime.test.ts:589) : le test de la course reste temporel et peut rester vert après suppression de l’attente.**