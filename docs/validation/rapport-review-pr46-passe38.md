# Revue PR #46 — passe 38

Revue statique du commit `36dd5c92` et exclusivement de l’état committé (`git show HEAD:<chemin>`). Les tests n’ont pas été exécutés dans l’environnement en lecture seule ; les constats sont donc marqués comme déduits sans exécution.

## Réponses aux trois questions

### 1. `question_without_call_id` peut-il provoquer une boucle ?

Non sur les chemins vivants du runner.

**Conclusion — déduite sans exécution.**  
[packages/tools/src/execute.ts:375](D:/APPS/NodalAI/packages/tools/src/execute.ts:375)

Sans `ctx.toolCallId`, `executeTool` écrit désormais un résultat d’audit `{ outcome: 'error', error: 'question_without_call_id' }` puis retourne immédiatement, sans créer d’`approval_request`. Il n’existe donc plus de nouvelle question impossible à reprendre.

Le modèle peut rappeler `ask_user`, mais les appels produits dans la boucle du runner portent `call.id`. La répétition éventuelle serait alors une décision du modèle face à un résultat d’erreur, pas une boucle mécanique de suspension/reprise. Les gardes anti-boucle générales restent en outre applicables.

### 2. `wouldRequireApproval` sert-il ailleurs ?

Non.

**Conclusion — déduite sans exécution.**  
[apps/runner/src/job/execute.ts:3114](D:/APPS/NodalAI/apps/runner/src/job/execute.ts:3114)

`wouldRequireApproval` est une fonction locale à `runJob`. Ses consommateurs servent uniquement à déterminer quels appels peuvent entrer dans le pré-passage parallèle. Son `true` pour `asksUser` n’alimente ni compteur, ni trace, ni décision d’approbation persistée. Le nom est légèrement plus large que son emploi, mais cela ne casse rien.

### 3. Le `[DEFERRED]` restant est-il un comportement nouveau ?

Non.

**Conclusion — déduite sans exécution.**  
[apps/runner/src/job/execute.ts:3120](D:/APPS/NodalAI/apps/runner/src/job/execute.ts:3120) et [apps/runner/src/tests/job/ask-user-flow.test.ts:287](D:/APPS/NodalAI/apps/runner/src/tests/job/ask-user-flow.test.ts:287)

La seconde question est traitée comme toute action postérieure à une suspension : elle reçoit son résultat `[DEFERRED]`, apparié à son propre `toolCallId`, et n’est pas exécutée automatiquement lors de la reprise. Le modèle doit la reformuler s’il en a encore besoin. Le nouveau test vérifie bien une seule ligne pending, un marqueur d’attente, un marqueur différé et l’attribution de la réponse à `tc-q-a`.

## Vérification des constats de la passe 37

1. **P0 — reprise sans `toolCallId` : traité.**  
   [packages/tools/src/execute.ts:375](D:/APPS/NodalAI/packages/tools/src/execute.ts:375) refuse maintenant l’appel avant toute suspension et écrit la ligne d’audit. Le test vérifie également l’absence d’`approval_request` avec `tool_call_id IS NULL`.

2. **P0 — plusieurs `ask_user` dans un même tour : traité.**  
   [apps/runner/src/job/execute.ts:3123](D:/APPS/NodalAI/apps/runner/src/job/execute.ts:3123) retourne `true` pour `def.asksUser`, ce qui exclut ces appels du pré-passage parallèle. Le test ajouté couvre précisément deux questions dans le même tour et la bonne attribution de la réponse.

3. **Sécurité des boutons : aucun constat précédent à corriger.** Aucun changement pertinent dans ce commit.

4. **Validation de `answer` côté web : aucun constat précédent à corriger.** Aucun changement pertinent.

5. **Deux lignes `tool_calls` pour le même appel : réponse précédente maintenue.** Aucun défaut n’avait été relevé.

6. **Sous-agent et cron : réponse précédente maintenue.** Aucun défaut n’avait été relevé.

7. **Déclinaison depuis les canaux : limitation déjà documentée, sans régression dans ce commit.**

8. **Repli WhatsApp : limitation déjà documentée, sans régression dans ce commit.**

9. **`present()` et ligne suspendue : comportement jugé cohérent à la passe 37, inchangé.**

10. **P2 — textes utilisateur codés en dur dans le runner : non traité.**  
    **Constat P2 — déduit sans exécution.**  
    [apps/runner/src/approvals/notify.ts:104](D:/APPS/NodalAI/apps/runner/src/approvals/notify.ts:104), [apps/runner/src/telegram/approval-callback.ts:264](D:/APPS/NodalAI/apps/runner/src/telegram/approval-callback.ts:264), [apps/runner/src/channels/discord/approval-callback.ts:227](D:/APPS/NodalAI/apps/runner/src/channels/discord/approval-callback.ts:227) et [apps/runner/src/channels/slack/approval-callback.ts:225](D:/APPS/NodalAI/apps/runner/src/channels/slack/approval-callback.ts:225)

    La réponse fournie explique l’intention, mais ne respecte pas la formulation littérale de l’invariant nº 2 : « No hardcoded user-facing text in runner ». La présence de textes historiques comparables ne crée pas d’exception à cet invariant.

    La frontière cohérente est la suivante : le runner peut produire des codes et des données structurées ; le chrome utilisateur doit être fourni par l’agent ou rendu dans la couche de présentation — adaptateur de livraison ou web — éventuellement depuis des données configurées en base. Selon la même règle, les textes historiques du runner constituent aussi une dette à déplacer, mais cela n’exonère pas les nouveaux textes.

11. **P2 — `o012` : répondu.**  
    [apps/runner/src/telegram/approval-callback.ts:88](D:/APPS/NodalAI/apps/runner/src/telegram/approval-callback.ts:88) et [apps/runner/src/telegram/approval-callback.ts:101](D:/APPS/NodalAI/apps/runner/src/telegram/approval-callback.ts:101)

    Le commentaire indique maintenant explicitement que le suffixe porte un index numérique non borné par le parseur et que la borne fonctionnelle vient des options de la ligne. Le point documentaire de la passe 37 est traité.

## Éléments trouvés hors demande

### P0 — le commit embarque un déplacement P10b incomplet qui casse le build web

**Constat P0 — déduit sans exécution.**  
[apps/web/src/lib/project-actions.ts:43](D:/APPS/NodalAI/apps/web/src/lib/project-actions.ts:43)

Le commit supprime `apps/web/src/lib/project-path.ts`, mais `project-actions.ts` continue d’importer `./project-path.ts`. Ce module n’existe donc plus dans `HEAD`, et la compilation de l’application web échouera à la résolution de l’import.

Le déplacement vers `packages/shared` est lui-même incomplet :

- [packages/shared/src/tests/project-subfolder.test.ts:8](D:/APPS/NodalAI/packages/shared/src/tests/project-subfolder.test.ts:8) importe `../project-path.ts`, alors que le fichier ajouté s’appelle `project-subfolder.ts`.
- [packages/shared/src/project-subfolder.ts:8](D:/APPS/NodalAI/packages/shared/src/project-subfolder.ts:8) importe `normalizePath` depuis son propre package au lieu d’un module interne.
- `packages/shared/src/index.ts` n’exporte pas `project-subfolder.ts`.

Ces fichiers P10b sont bel et bien présents dans `36dd5c92`, alors que la demande les annonçait comme non committés et hors périmètre.

## Constats bloquants

- P0 — suppression committée de `apps/web/src/lib/project-path.ts` sans mise à jour de ses consommateurs, avec déplacement incomplet vers `packages/shared`.
- P2 — textes utilisateur codés en dur dans le runner, toujours contraires à l’invariant nº 2.