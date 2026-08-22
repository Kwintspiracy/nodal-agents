# Rapport de review - PR A, passe 2

Passe 2 effectuée en lecture seule sur `9b61e79`. Deux constats nouveaux.

1. Bloquant — le résultat final Claude disparaît dès que le flux verbeux dépasse 400 000 caractères

- `packages/tools/src/builtin/code-task/process.ts:25`
- `packages/tools/src/builtin/code-task/process.ts:193–201`
- `packages/tools/src/builtin/code-task/process.ts:225–231`
- `packages/tools/src/builtin/code-task/providers.ts:284–309`

`stream-json --verbose` place l’événement `type: "result"` à la fin du JSONL. Or `runCli` ne conserve que les 400 000 premiers caractères de stdout. Le parseur final n’analyse pas les lignes livrées en direct : il reparcourt uniquement `run.stdout`, déjà amputé.

Ce qui casse concrètement : une session Claude suffisamment longue pour produire plus de 400 000 caractères d’événements — notamment avec des résultats de `Read` ou de commandes volumineux — peut s’exécuter correctement et être visible en direct, mais `parseClaudeOutput` ne trouvera jamais son événement final. `code_task` échouera avec `stream ended without a result event` au lieu de rendre le résultat réel.

Le passage de `json` agrégé à `stream-json --verbose` rend cette régression nouvelle : auparavant, le buffer contenait seulement l’objet final compact.

Les tests de `parseClaudeOutput` utilisent encore uniquement les anciens objets agrégés :

- `packages/tools/src/tests/code-task.test.ts:39–42`
- `packages/tools/src/tests/code-task.test.ts:152–191`

Aucun test ne passe un vrai JSONL Claude comportant plusieurs événements, ni un flux dépassant le plafond.

2. Majeur — le découpage live contourne le plafond mémoire sur une vraie ligne `stream-json`

- `packages/tools/src/builtin/code-task/process.ts:203–223`
- `packages/tools/src/builtin/code-task/live-events.ts:38–43`
- `packages/tools/src/builtin/code-task/live-events.ts:55–77`
- `packages/tools/src/builtin/code-task/live-events.ts:157`
- Trace réelle : `apps/runner/src/tests/cli-runtime/stream-fixture.jsonl:10`

`lineBuf` est hors du buffer plafonné et ne possède aucun plafond propre. Il conserve toute la ligne jusqu’au prochain `\n`. Dans un vrai flux Claude, un `tool_result` est un unique objet JSONL : la fixture réelle montre déjà que le contenu du fichier apparaît dans `message.content` et de nouveau dans `tool_use_result`.

Ce qui casse concrètement : un outil renvoyant une très grosse sortie fait grossir `lineBuf` jusqu’à la taille complète de l’objet JSON, puis force `JSON.parse` sur cet objet entier. Le plafond de 400 000 caractères ne protège donc pas ce chemin. Le plafonnement à 8 000 caractères intervient seulement après réception et parsing de la ligne complète. Une sortie pathologique peut provoquer un pic mémoire important, voire épuiser le processus runner.

L’impact mémoire exact sur une session réelle est **NON VÉRIFIÉ** : aucun benchmark ni test avec une ligne JSONL volumineuse n’est présent, et aucun CLI réel n’a été exécuté pendant cette passe.

Hors de ces deux points, je n’ai trouvé aucun autre défaut neuf dans les corrections ciblées. Le découpage reconstruit correctement les lignes réparties sur plusieurs chunks, y compris le `stream-json` réel de la fixture.
