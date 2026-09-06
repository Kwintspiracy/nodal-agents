## Réponses aux trois questions

### 1. Porte d’approbation

Oui, le commentaire est exact.

`register_project` déclare `riskLevel: 'write'` à `packages/tools/src/builtin/register-project.ts:98` et `defaultApproval: 'require_approval'` à `packages/tools/src/builtin/register-project.ts:155`.

Sans règle explicite, `packages/tools/src/execute.ts:215` initialise donc `effectiveAction` à `require_approval` :

- `propose_confirm` : aucune relaxation ne s’applique ; l’appel reste soumis à approbation.
- `destructive_gate` : à `packages/tools/src/execute.ts:247`, l’outil est évalué selon son `riskLevel`. Comme celui-ci vaut `write`, et non `destructive`, `effectiveAction` devient `auto_approve`.
- `fully_autonomous` : à `packages/tools/src/execute.ts:245`, l’appel devient `auto_approve`, car `register_project` n’appartient pas aux outils d’exécution de code.
- Une règle explicite garde la priorité grâce à la condition `!matchedRule` de `packages/tools/src/execute.ts:244`.

Les planchers durs suivants ne re-gatent que `run_command`, `create_mcp` en transport stdio et `ask_user`, à partir de `packages/tools/src/execute.ts:317`, `:332` et `:357`. Aucun ne vise `register_project`.

**Conclusion, déduite sans exécution :** la porte se comporte comme annoncé.

### 2. Carte d’approbation

`buildApprovalCardBody` appelle bien `explainApprovalRequest` à `apps/runner/src/approvals/notify.ts:70`, puis rend son résultat à `apps/runner/src/approvals/notify.ts:84`.

En revanche, aucune explication spécialisée n’existe pour `register_project`.

**[P2, non bloquant, déduit sans exécution] — `packages/shared/src/approval-impact.ts:132`**

`register_project` tombe dans le `default` et la carte affiche donc :

```text
register_project: irreversible or destructive action.
```

Le chemin reste visible dans les arguments techniques, mais la ligne d’impact ne dit pas « creates the folder X and registers it as a project » et qualifie à tort cette écriture d’irréversible ou destructive. De plus, `packages/shared/src/approval-explain.ts:248` ne renseigne pas `target` pour cet outil.

L’explication doit être branchée dans :

- `packages/shared/src/approval-impact.ts`, dans `computeApprovalImpactLine`, avec un `case 'register_project'` ;
- idéalement aussi `packages/shared/src/approval-explain.ts:248`, afin de classer explicitement l’effet comme `write` et d’exposer `input.path` comme cible.

Ce défaut n’annule pas la sécurité de la porte : le chemin apparaît toujours dans les arguments de la carte. Il rend toutefois son explication déterministe trompeuse.

### 3. Disparition de la liaison textuelle

La logique de liaison est entièrement retirée des fichiers de production commités :

- plus de `jobAnsweredForProject` ;
- plus de `fold(` ;
- plus de consigne positive « exactly the name » dans le prompt ou la description de l’outil.

Il reste une seule occurrence, dans une assertion négative :

**[P3, non bloquant, déduit sans exécution] — `packages/orchestration/src/tests/system-prompt.test.ts:1091`**

```ts
expect(bloc).not.toContain('EXACTLY the name of the new project');
```

Elle mentionne encore littéralement l’ancienne formule, mais uniquement pour empêcher sa réintroduction. Elle ne restaure aucune liaison textuelle.

## Clôture du constat bloquant de la passe 41

Le constat est clos par cette forme.

À `packages/tools/src/builtin/register-project.ts:155`, l’autorisation ne dépend plus du nom d’affichage, du chemin, du texte choisi ni d’une question précédente. La collision décrite en passe 41 — sélectionner le projet existant « Notes », puis créer silencieusement `new-notes` avec le même `name` — aboutit désormais à `awaiting_approval` en l’absence de règle ou de niveau d’autonomie permissif.

Le test central le couvre à `packages/tools/src/tests/builtin/register-project.test.ts:544` : même une question répondue qui nomme exactement le projet ne déverrouille plus l’appel. La reprise après approbation est couverte à `packages/tools/src/tests/builtin/register-project.test.ts:616`.

## Éléments hors demande

Je n’ai trouvé aucun autre défaut de correction dans le commit. La matrice locale teste l’absence de règle, la règle explicite, `fully_autonomous` et la reprise, mais pas directement `destructive_gate` dans `packages/tools/src/tests/builtin/register-project.test.ts:592`. Son comportement découle néanmoins sans ambiguïté de la porte commune à `packages/tools/src/execute.ts:247`.

Je n’ai exécuté aucun test, afin de ne pas faire intervenir l’arbre de travail non committé. La revue porte sur le commit `5171c706` et les versions `HEAD:<chemin>` demandées.

## Constats bloquants

Aucun constat bloquant.