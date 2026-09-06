## Réponses aux trois questions

1. **La liaison par le libellé n’est pas acceptable en l’état.**

**[P0, bloquant, déduit sans exécution] — [packages/tools/src/builtin/register-project.ts](D:/APPS/NodalAI/packages/tools/src/builtin/register-project.ts:160)**

`answer.includes(n)` conserve le défaut de la passe 39 sous une forme plus étroite. Une réponse approuvée sans rapport avec la création peut encore autoriser silencieusement un projet :

```text
Question : « Que faire ensuite ? »
Option choisie : « Add notes to the README »
register_project({ path: "notes" })
```

La réponse contient `notes`; la garde laisse donc créer le dossier alors que l’utilisateur n’a jamais choisi ce projet. Le scénario est explicitement reconnu par la demande et contredit toujours « rien ne se crée en silence ».

Retirer spécifiquement le préfixe `New project:` serait fragile parce que cela couple l’autorisation à une formulation. Sans autorisation structurée, la solution la plus honnête est de demander que l’option de création soit exactement le `name` ou le dernier segment du chemin après `fold`, et de faire porter l’intention « nouveau projet » par la question. Si le préfixe doit rester obligatoire, une autorisation structurée/capacité associée à l’option est nécessaire pour obtenir une liaison robuste.

2. **Ne pas supprimer une ligne déjà déclarée (`created: false`) est correct.**

L’appel n’est pas propriétaire de cette ligne. La supprimer lors d’un échec de rattachement détruirait un projet préexistant. Le rattachement rend un code explicite `attach_failed:<code>` et ses écritures SQL sont transactionnelles : la conversation et le job restent dans leur état antérieur.

Le fait que la conversation demeure sans projet courant n’est pas une incohérence introduite par cet appel : elle l’était déjà. Une nouvelle tentative ou une nouvelle question reste possible.

3. **`rmdir` peut échouer pour d’autres raisons qu’un remplissage concurrent.**

**[P1, déduit sans exécution] — [packages/tools/src/builtin/register-project.ts](D:/APPS/NodalAI/packages/tools/src/builtin/register-project.ts:337)**

Le `.catch(() => undefined)` absorbe aussi `EACCES`, `EPERM`, une erreur d’E/S ou tout autre échec de nettoyage. L’outil rend alors seulement `attach_failed:<code>`, même si le dossier vide créé par l’appel subsiste.

Il faut ignorer explicitement `ENOTEMPTY` — et raisonnablement `ENOENT` — mais au minimum journaliser ou exposer les autres erreurs. Dans sa forme actuelle, cela contrevient au principe « fail loud ».

## Vérification des constats de la passe 39

- **P0 — n’importe quelle question déverrouille : partiellement traité.**  
  Le cas exact « Bleu » → `comptabilite` est maintenant bloqué et testé. En revanche, la correspondance par sous-chaîne laisse encore une option étrangère déverrouiller un projet au nom court. Le constat bloquant n’est donc pas complètement clos.

- **P0-2 — reprise après approbation ordinaire : toujours sans constat.**  
  Le commit ne modifie pas le mécanisme de reprise concerné.

- **P0-3 — dossier absent et liens symboliques : toujours sans constat.**  
  La résolution sécurisée reste appelée avant `mkdir`.

- **P1-4 — terrain lui-même comme projet : toujours sans nouveau défaut technique.**

- **P1-5 — frontière “document” : toujours sans constat bloquant.**

- **P1-6 — projet masqué : toujours sans constat.**

- **P1-7 — chemins absolus : toujours sans constat.**

- **P2 — douze projets contre six options : traité.**  
  [system-prompt.ts](D:/APPS/NodalAI/packages/orchestration/src/system-prompt.ts:454) demande désormais au plus cinq projets pertinents plus l’option de création. L’inventaire peut donc rester plafonné à douze.

- **P1 hors demande — création non atomique : traité sur le chemin nominal, incomplet lorsque le nettoyage échoue.**  
  La ligne créée par l’appel et son dossier vide sont supprimés après l’échec de rattachement; un dossier préexistant est conservé. Toutefois, les erreurs de suppression sont absorbées.

Les tests ajoutés couvrent le cas « Bleu », le nom/dossier, accents et casse, le rollback nominal et le dossier préexistant. Ils ne couvrent ni la collision par sous-chaîne ni les erreurs de nettoyage. Je n’ai pas exécuté les tests : l’arbre contient les modifications non committées signalées par la demande; la revue ci-dessus porte exclusivement sur le contenu obtenu par `git show`.

## Constats hors demande

**[P1, déduit sans exécution] — [packages/tools/src/builtin/register-project.ts](D:/APPS/NodalAI/packages/tools/src/builtin/register-project.ts:332)**

L’échec de suppression de la ligne `code_projects` est seulement envoyé à `console.error`, puis l’outil rend quand même `attach_failed:<code>`. Il annonce donc uniquement l’échec initial sans signaler que le rollback a lui-même échoué et que le projet peut encore apparaître dans Spaces. Le résultat devrait distinguer un `rollback_failed` ou propager l’erreur de nettoyage.

**[P2, déduit sans exécution] — [packages/tools/src/builtin/register-project.ts](D:/APPS/NodalAI/packages/tools/src/builtin/register-project.ts:154)**

La requête applique `limit(50)` sans `orderBy`. Au-delà de cinquante questions approuvées dans un job, PostgreSQL ne garantit pas que la question autorisant le projet figure dans le sous-ensemble examiné. Cela échoue de manière sûre — une approbation supplémentaire est demandée — mais le comportement est non déterministe. Un ordre explicite, préférablement du plus récent au plus ancien, rendrait la borne reproductible.

## Constats bloquants

- Correspondance par sous-chaîne permettant encore à une option étrangère d’autoriser silencieusement un projet au nom court — [packages/tools/src/builtin/register-project.ts](D:/APPS/NodalAI/packages/tools/src/builtin/register-project.ts:160).