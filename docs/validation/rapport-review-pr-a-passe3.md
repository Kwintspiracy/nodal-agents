# Rapport de review — PR A, passe 3

Lecture seule. Deux constats nouveaux.

## 1. Bloquant — une ligne surdimensionnée peut entraîner la perte du résultat suivant

- Fichier : `packages/tools/src/builtin/code-task/process.ts`
- Lignes : 220–234

Lorsque `lineBuf` dépasse 200 Ko, le code cherche le **dernier** `\n`, conserve seulement ce qui le suit, puis retourne sans traiter les lignes complètes présentes dans le chunk.

Scénario concret :

1. `lineBuf` contient presque 200 Ko d’un gros `tool_result`.
2. Le chunk suivant contient la fin de ce résultat, puis l’événement Claude `type:"result"` complet.
3. `lineBuf.length` dépasse le plafond.
4. `lastIndexOf('\n')` pointe après l’événement final.
5. Tout ce qui précède — y compris le résultat final valide — est jeté.

Si le tampon stdout de 400 Ko était déjà saturé, `makeEssentialCapture` ne reçoit jamais le résultat et le repli sur `run.stdout` ne le contient pas davantage. `code_task` échoue alors avec `stream ended without a result event` après une session pourtant réussie.

Le commentaire ligne 223 affirmant que seule « la ligne courante » est perdue est donc faux : des lignes complètes suivantes peuvent aussi disparaître.

## 2. Majeur — le plafond du capteur Codex peut supprimer le `thread.started` indispensable

- Fichier : `packages/tools/src/builtin/code-task/live-events.ts`
- Lignes : 172, 183–188, 209–215
- Fichier : `packages/tools/src/builtin/code-task/providers.ts`
- Lignes : 342, 355–356, 393–395
- Test insuffisant : `packages/tools/src/tests/code-task-live-events.test.ts:157–175`

Le capteur conserve au maximum 4 000 lignes en jetant systématiquement le début. C’est valide pour Claude, dont le seul résultat nécessaire est terminal, mais pas pour Codex : `thread.started`, situé au début, fournit le `sessionId`.

Scénario concret : un tour Codex émet `thread.started`, puis plus de 3 999 `agent_message`, puis `turn.completed`. Le plafond évince `thread.started`. L’analyse réussit, mais renvoie `sessionId: null`; la session ne peut donc pas être persistée puis reprise. Les premiers messages sont également retirés du `resultText`.

Le test ne couvre qu’un `agent_message` et ne fait jamais tomber le plafond Codex.

## Valeur du test de câblage

- Fichier : `packages/tools/src/tests/code-task-wiring.test.ts`
- Lignes : 40–57, 74–85, 113–132

Le test prouve bien le câblage de la correction de passe 2 : `codeTaskTool` exécute un processus réel et retrouve un résultat placé après les 400 Ko du tampon.

Il ne prouve toutefois pas le couplage réel entre l’argv Claude et le format produit : la fausse CLI ignore entièrement ses arguments et émet toujours du `stream-json`. Une régression remettant `--output-format json` laisserait ce test vert. Cette mutation reste couverte séparément par le test unitaire de `buildProviderArgs`, mais pas par le test présenté comme « de bout en bout ».

Tests non exécutés : leur exécution créerait une base et des fichiers temporaires, incompatible avec la contrainte de lecture seule.
