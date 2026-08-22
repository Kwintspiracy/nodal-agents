# Rapport de review - PR #8, passe 3

Deux constats nouveaux dans `bb08527`. Aucun fichier modifié.

1. Bloquant — le baseline réintroduit des consignes visant des outils absents

- [agent-baseline.ts:90](D:/APPS/NodalAI/packages/orchestration/src/agent-baseline.ts:90)
- [agent-baseline.ts:107](D:/APPS/NodalAI/packages/orchestration/src/agent-baseline.ts:107)
- [agent-baseline.ts:111](D:/APPS/NodalAI/packages/orchestration/src/agent-baseline.ts:111)
- Exemples injectés : [verify-before-done.ts:39](D:/APPS/NodalAI/packages/catalog/src/skills/verify-before-done.ts:39), [verify-before-done.ts:110](D:/APPS/NodalAI/packages/catalog/src/skills/verify-before-done.ts:110), [workspace-hygiene.ts:45](D:/APPS/NodalAI/packages/catalog/src/skills/workspace-hygiene.ts:45)

`nodalTools: false` retire seulement les blocs mémoire et rôle. Le `catalogBlock` est rendu intégralement, alors que ses skills baseline imposent encore `file_read`, `file_write`, `skill_view`, `run_skill_script`, `create_task` et `list_tasks`.

Ce qui casse concrètement : le prompt CLI ordonne à nouveau d’appeler des outils inexistants, notamment après chaque écriture et avant de conclure sur un travail délégué. La correction restaure donc les règles générales, mais aussi les parties outillées qu’elle devait précisément exclure.

2. Majeur — l’inlining aveugle des skills injecte leurs builtins Nodal dans la CLI

- [system-prompt.ts:561](D:/APPS/NodalAI/packages/orchestration/src/system-prompt.ts:561)
- [system-prompt.ts:568](D:/APPS/NodalAI/packages/orchestration/src/system-prompt.ts:568)
- Cas concret : [code-review.ts:17](D:/APPS/NodalAI/packages/catalog/src/skills/code-review.ts:17), [code-review.ts:30](D:/APPS/NodalAI/packages/catalog/src/skills/code-review.ts:30)

Tout skill assigné est maintenant inline sans adaptation à la surface. Par exemple, `code-review` requiert `review_verdict` et ordonne ensuite `return_result`, deux outils non exposés par `runClaudeTurn`.

Ce qui casse concrètement : un reviewer CLI reçoit enfin le contenu de son skill, mais ne peut pas produire la livraison exigée par celui-ci. Le même problème touche notamment `command-execution`, qui prescrit `run_command`.

Le test ne détecte aucun de ces cas : sa fixture utilise un contenu neutre, et l’assertion ne recherche que quatre formulations exactes au lieu des ordres réellement injectés.
