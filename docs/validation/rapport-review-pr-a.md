# Rapport de revue — PR A

Verdict global : **le constat principal de la PR ne tient pas pour Claude**. Le mécanisme live parse du `stream-json`, mais `code_task` lance Claude avec une sortie JSON agrégée. La session reste donc invisible pendant son exécution. Plusieurs autres défauts concernent la confidentialité, la troncature et la valeur probante des tests.

Aucun fichier n’a été modifié.

## Constats bloquants

### 1. Claude n’émet pas le flux que `parseLiveToolEvent` attend

- Fichier : `packages/tools/src/builtin/code-task/providers.ts`
- Ligne : 139
- Fichier : `packages/tools/src/builtin/code-task/live-events.ts`
- Lignes : 48–72
- Sévérité : bloquante
- Verdict : **LE CONSTAT TIENT**

`buildProviderArgs` lance Claude avec :

```text
-p --output-format json
```

Or le parseur live ne reconnaît que les enveloppes de `stream-json`, avec `message.content[].type === "tool_use"` ou `"tool_result"`.

Le propre commentaire de l’analyseur final confirme que `--output-format json` produit un seul objet final :

- `packages/tools/src/builtin/code-task/providers.ts:259`

La documentation officielle distingue bien `json` de `stream-json` et précise que le second transmet les messages au fil de leur réception : [documentation Claude Code](https://docs.anthropic.com/en/docs/claude-code/cli-usage).

Une trace réelle du dépôt confirme la forme attendue lorsque `stream-json` est effectivement activé :

- `apps/runner/src/tests/cli-runtime/stream-fixture.jsonl:8` : `tool_use`
- `apps/runner/src/tests/cli-runtime/stream-fixture.jsonl:10` : `tool_result`
- `apps/runner/src/cli-runtime/claude-turn.ts:110–112` : activation explicite de `stream-json`

Ce qui casse concrètement : pendant un `code_task` Claude, aucun événement interne n’est écrit dans `tool_calls`. L’onglet Code reste vide jusqu’à la fin, soit exactement le défaut que la PR prétend corriger.

Le test Claude ne détecte pas cette rupture parce qu’il appelle directement `parseLiveToolEvent` avec une ligne synthétique de `stream-json` sans vérifier les arguments réellement passés au CLI :

- `packages/tools/src/tests/code-task-live-events.test.ts:12–43`

---

### 2. Les sorties d’outils sont enregistrées sans aucune redaction

- Fichier : `packages/tools/src/builtin/code-task/live-events.ts`
- Lignes : 142–143
- Sévérité : bloquante sécurité
- Verdict : **LE CONSTAT TIENT**

L’entrée passe par `redactSecretsForAudit`, mais la sortie est enregistrée directement :

```ts
toolInput: redactSecretsForAudit(started.input),
toolOutput: parsed.event.output ?? '',
```

Ce qui casse concrètement : un `Read`, une commande shell ou un autre outil qui retourne le contenu d’un fichier comportant un jeton, mot de passe ou secret écrit ce secret en clair dans `tool_calls.tool_output`. Cette valeur est ensuite renvoyée par la couche web :

- `apps/web/src/lib/actions.ts:11430`

Elle peut donc être affichée dans le détail de l’activité.

---

### 3. Une troncature de `stderr` peut être attribuée à tort au plafond de sortie

- Fichier : `packages/tools/src/builtin/code-task/process.ts`
- Lignes : 183–191
- Fichier : `packages/tools/src/builtin/code-task/index.ts`
- Lignes : 368–383
- Sévérité : majeure
- Verdict : **LE CONSTAT TIENT**

Le même booléen `truncated` est positionné par `append` pour stdout et stderr. Le message spécial est ensuite choisi uniquement à partir de ce booléen lorsqu’un `CliOutputError` survient.

Scénario concret :

1. `stderr` dépasse 50 000 caractères : `run.truncated` devient vrai.
2. `stdout` est invalide pour une raison réellement imputable au CLI.
3. L’analyseur lève `CliOutputError`.
4. Le message affirme que « output exceeded the capture cap » et que « the CLI is not at fault ».

Le plafond stdout peut n’avoir jamais été atteint. Le diagnostic accuse donc Nodal à tort et masque une sortie CLI réellement invalide.

---

### 4. Une troncature peut passer complètement inaperçue

- Fichier : `packages/tools/src/builtin/code-task/index.ts`
- Lignes : 360–383
- Fichier : `packages/tools/src/builtin/code-task/providers.ts`
- Lignes : 298–366
- Sévérité : majeure
- Verdict : **LE CONSTAT TIENT**

`run.truncated` n’est consulté que dans le `catch` de l’analyseur. Si le préfixe capturé reste syntaxiquement acceptable, la troncature n’est jamais signalée.

Cas concret avec Codex : le buffer peut contenir un `turn.completed` complet, puis atteindre le plafond sur des lignes ultérieures. `parseCodexOutput` a déjà vu `turn.completed`, donc il réussit. Le résultat retourne normalement malgré `run.truncated === true`.

Même principe avec une troncature causée uniquement par stderr : si stdout se parse, aucune alerte n’est produite.

Le « quatrième cas » recherché existe donc : **troncature avec préfixe encore accepté par l’analyseur**.

## Constats majeurs

### 5. Le chemin Codex dépend d’un événement d’ouverture qui n’est pas établi par les preuves présentes

- Fichier : `packages/tools/src/builtin/code-task/live-events.ts`
- Lignes : 77–94
- Sévérité : majeure potentielle
- Verdict : **NON VÉRIFIÉ pour la version actuelle du CLI**

Le recorder exige :

1. `item.started` avec un `id` pour ouvrir `pending`;
2. `item.completed` avec le même `id` pour fermer la paire.

Les traces réelles conservées dans le dépôt montrent des `item.completed` de type `command_execution`, mais pas leur `item.started` :

- `docs/validation/rapport-review-pr6.md:140`
- `docs/validation/rapport-review-pr6.md:173`

Ces exemples ne comportent d’ailleurs pas de champ `id` visible. Sur ces lignes exactes, `parseLiveToolEvent` retourne `null` à cause du contrôle de `live-events.ts:82`.

Je n’ai pas trouvé de documentation officielle OpenAI établissant la paire `item.started`/`item.completed` pour `command_execution` et `file_change`. L’exécution du CLI installé a été refusée par l’environnement de lecture seule. Le comportement de la version actuellement installée reste donc **NON VÉRIFIÉ**.

Ce qui casserait concrètement si la trace représentative n’émet que `item.completed` : aucun outil Codex ne serait enregistré, car chaque résultat serait soit rejeté pour absence d’`id`, soit abandonné faute d’entrée correspondante dans `pending`.

---

### 6. `pending` est sans plafond et conserve toutes les ouvertures non fermées

- Fichier : `packages/tools/src/builtin/code-task/live-events.ts`
- Lignes : 116–127
- Sévérité : majeure sur session hostile ou défectueuse
- Verdict : **LE CONSTAT TIENT**

Chaque événement `use` ajoute ou remplace une entrée dans une `Map`. Aucun plafond, délai d’expiration ni vidange de fin de session n’existe.

Ce qui casse concrètement : mille identifiants distincts ouverts sans résultat laissent mille objets d’entrée en mémoire jusqu’à la fin du processus CLI. La mémoire est récupérable après la session, mais sa consommation pendant la session est non bornée par ce code.

---

### 7. `toolCallId` peut se répéter entre plusieurs `code_task` du même job

- Fichier : `packages/tools/src/builtin/code-task/live-events.ts`
- Ligne : 145
- Fichier : `packages/db/src/schema/tool_calls.ts`
- Lignes : 8–29
- Sévérité : majeure pour la corrélation
- Verdict : **LE CONSTAT TIENT**

Le recorder stocke directement l’identifiant local du CLI. Le schéma ne possède ni contrainte unique ni namespace incluant le run ou la session.

La fixture Codex utilise déjà un identifiant local générique :

- `packages/tools/src/tests/code-task.test.ts:48` : `item_0`

Deux invocations Codex du même job peuvent donc produire le même `toolCallId`.

Ce qui casse concrètement : `jobId + toolCallId` ne permet plus d’identifier une invocation unique. Toute jointure future ou diagnostic fondé sur cette paire peut associer un résultat au mauvais `code_task`. L’affichage actuel utilise toutefois la clé primaire `tool_calls.id`, donc je n’ai pas constaté de collision visuelle immédiate dans la vue actuelle.

## Découpage du flux

### 8. Une ligne coupée entre deux chunks est correctement reconstruite

- Fichier : `packages/tools/src/builtin/code-task/process.ts`
- Lignes : 196–212
- Verdict : **LE CONSTAT EST FAUX** — pas de défaut trouvé

`lineBuf` conserve le suffixe sans `\n`. Le chunk suivant y est concaténé avant la nouvelle recherche de séparateur. Une ligne JSON coupée au milieu n’est donc pas envoyée prématurément au parseur.

---

### 9. `\r\n` ne laisse pas passer de `\r` dans les lignes émises

- Fichier : `packages/tools/src/builtin/code-task/process.ts`
- Lignes : 201–205
- Verdict : **LE CONSTAT EST FAUX** — pas de défaut trouvé

La découpe se fait sur `\n`, puis `.trim()` retire le `\r` final. La vidange finale applique également `.trim()`.

Limite comportementale : `.trim()` retire aussi les espaces significatifs en début et fin de ligne. Pour les objets JSON attendus, cela ne change pas leur sens.

---

### 10. La vidange finale n’émet pas deux fois la même ligne

- Fichier : `packages/tools/src/builtin/code-task/process.ts`
- Lignes : 273–292
- Verdict : **LE CONSTAT EST FAUX** — pas de défaut trouvé

`settled` est vérifié puis positionné synchroniquement avant la vidange. Si `close` et le minuteur appellent tous deux `finish`, seul le premier passe. JavaScript n’interrompt pas cette section synchrone entre le test et l’affectation.

---

### 11. `outDecoder.end()` ne casse pas le stdout normal, mais sa sortie n’est pas ajoutée au transcript

- Fichier : `packages/tools/src/builtin/code-task/process.ts`
- Lignes : 282–284
- Fichier : `packages/tools/src/builtin/code-task/process.ts`
- Lignes : 294–300
- Verdict : **LE CONSTAT TIENT dans le cas d’une séquence UTF-8 finale incomplète**

La valeur retournée par `outDecoder.end()` est utilisée pour le callback de dernière ligne, mais n’est jamais ajoutée à `stdout`.

Ce qui casse concrètement : si le processus termine au milieu d’une séquence UTF-8, `StringDecoder.end()` produit le caractère de remplacement pour le callback, tandis que le `stdout` retourné ne contient pas cette fin. Le flux live et le transcript final divergent.

Pour des caractères multi-octets complets, même coupés entre deux chunks, `StringDecoder.write()` conserve les octets incomplets et restitue correctement le caractère au chunk suivant. Ce chemin est correct.

---

### 12. Les cas chunk partagé, CRLF et UTF-8 partagé ne sont pas couverts par les tests

- Fichier : `packages/tools/src/tests/code-task-stream.test.ts`
- Lignes : 16–77
- Sévérité : couverture insuffisante
- Verdict : **LE CONSTAT TIENT**

Les quatre tests couvrent :

- livraison avant la fin ;
- dernière ligne sans `\n` ;
- exception du callback ;
- comportement sans callback.

Ils ne forcent pas :

- une ligne répartie sur deux chunks ;
- un `\r\n` réparti entre deux chunks ;
- un caractère UTF-8 réparti entre deux chunks ;
- la concurrence `close`/grace timer ;
- la cohérence entre le tail du décodeur et `stdout`.

Ce qui casse concrètement côté assurance : les mutations de ces comportements peuvent rester vertes.

## Analyse des échecs de troncature

### 13. Les trois messages d’échec cités existent bien

- Fichier : `packages/tools/src/builtin/code-task/providers.ts`
- Lignes : 269, 316, 351–355
- Verdict : **LE CONSTAT TIENT**

Les analyseurs peuvent bien produire :

- Claude : `stdout is not valid JSON`;
- Codex : `non-JSON line in JSONL stream`;
- Codex : `stream ended without turn.completed or turn.failed`.

Claude possède aussi :

- `empty stdout`, ligne 263 ;
- `JSON is not a result object`, ligne 272.

Cependant, le message de `index.ts:369–372` laisse entendre que les trois erreurs citées sont les seules formes pertinentes. Ce n’est pas exhaustif.

## Valeur probante des tests

### 14. La livraison au fil de l’eau est effectivement verrouillée

- Fichier : `packages/tools/src/tests/code-task-stream.test.ts`
- Lignes : 16–40
- Verdict : **LE CONSTAT TIENT**

Le test compare les temps de réception de la première et de la troisième ligne. Une implémentation qui livre tout à la fin réduit cet écart à presque zéro et doit échouer.

Exécution dans cet environnement : **NON VÉRIFIÉE**, car le lancement de Vitest a été refusé par la politique de lecture seule.

---

### 15. La vidange de la dernière ligne est verrouillée

- Fichier : `packages/tools/src/tests/code-task-stream.test.ts`
- Lignes : 42–56
- Verdict : **LE CONSTAT TIENT**

La suppression de la vidange ferait disparaître l’unique ligne dépourvue de `\n`; l’assertion attend explicitement cette ligne.

Exécution effective : **NON VÉRIFIÉE**.

---

### 16. Faire retourner `null` au parseur Claude est verrouillé, mais pas le produit Claude réel

- Fichier : `packages/tools/src/tests/code-task-live-events.test.ts`
- Lignes : 12–43
- Verdict : **LE CONSTAT TIENT pour la fonction isolée, mais pas pour l’intégration**

Les assertions échoueraient si `parseLiveToolEvent('claude', ...)` retournait toujours `null`.

En revanche, elles restent vertes si le produit continue à lancer Claude avec `--output-format json`. C’est précisément la rupture présente. Le test prouve le parseur sur une donnée fabriquée, pas que cette donnée lui parvient réellement.

---

### 17. Aucun test ne verrouille `providers` dans les requêtes ni dans les actions

- Fichier : `apps/web/src/lib/actions.ts`
- Lignes : 10948–10956, 11031, 11276–11288, 11511
- Fichier : `apps/web/src/app/(dashboard)/code/CodeProcessesTable.tsx`
- Lignes : 134–145
- Verdict : **LE CONSTAT TIENT**

La recherche des tests web ne trouve aucune assertion sur les nouveaux champs `providers`.

Ce qui casse concrètement : retirer `provider` du `select`, du regroupement ou de la construction de la réponse peut laisser l’interface afficher `—` ou perdre un des deux fournisseurs sans qu’aucun test ne rougisse.

Un test de la couche action est dû. Il doit au minimum établir le résultat réel pour :

- un job avec un seul provider ;
- un pipeline utilisant Claude et Codex ;
- le détail d’un job ;
- idéalement l’absence réelle de `cli_runs`, qui doit produire `[]`.

Tester seulement le composant ne verrouillerait pas la requête qui constitue la source de la donnée.

## Performance et charge DB

### 18. Coût perceptible du `JSON.parse` par ligne

- Fichier : `packages/tools/src/builtin/code-task/live-events.ts`
- Lignes : 38–43
- Verdict : **NON VÉRIFIÉ**

Aucun benchmark ni run CLI instrumenté n’est présent. L’environnement n’a pas permis d’exécuter une session réelle. Je ne conclus pas à un ralentissement perceptible ou négligeable.

---

### 19. Résistance du pool à mille insertions concurrentes

- Fichier : `packages/tools/src/builtin/code-task/live-events.ts`
- Lignes : 134–150
- Verdict : **NON VÉRIFIÉ**

Les insertions sont lancées sans attente et sans limite de concurrence. Le code peut donc avoir un grand nombre de promesses DB simultanément en vol.

Aucun test de charge contre le pool configuré n’est fourni, et je n’ai pas pu en exécuter. La survie du pool reste **NON VÉRIFIÉE**.

Conséquence établie indépendamment de la capacité du pool : la session peut se terminer et rendre son résultat avant que toutes les insertions aient fini, puisqu’aucune attente de vidange n’existe. Une lecture immédiate après la fin peut momentanément manquer des événements, et la fin du processus runner peut perdre les écritures encore en vol.

## Conclusion

La PR ne remplit pas son objectif principal pour Claude : le parseur live et le format réellement demandé au CLI sont incompatibles. Pour Codex, le contrat `item.started` → `item.completed` n’est pas suffisamment démontré par une trace réelle complète ou une documentation officielle.

Les autres défauts avérés sont :

- sortie d’outil non expurgée, avec fuite possible de secrets ;
- confusion stdout/stderr dans le diagnostic de troncature ;
- troncature silencieuse lorsque le préfixe reste analysable ;
- mémoire `pending` non bornée ;
- identifiants CLI non namespacés entre les runs ;
- aucune couverture de la couche action pour `providers`.

Les mesures de performance et de résistance du pool restent **NON VÉRIFIÉES**.
