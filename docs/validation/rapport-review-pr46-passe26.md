Verdict : **faux en l’état** — aucun bloquant, mais deux constats importants.

## Constats

### Bloquant

Aucun.

### Important

1. [StatusBar.tsx](D:/APPS/NodalAI/apps/web/src/app/(dashboard)/spaces/StatusBar.tsx:110), [StatusBar.tsx](D:/APPS/NodalAI/apps/web/src/app/(dashboard)/spaces/StatusBar.tsx:158), [ClampedText.tsx](D:/APPS/NodalAI/apps/web/src/app/(dashboard)/spaces/ClampedText.tsx:26) — les trois remplacements corrigent le lint, mais contournent le contrat explicite de `TextButton`.

   `TextButton` est réservé à la navigation tertiaire légère. Or :

   - les segments jetons/coût sont des disclosures et devraient exposer `aria-expanded`, pas `aria-pressed` ;
   - « Back to the conversation » ferme un panneau : c’est une action secondaire, visuellement déjà dessinée comme un bouton ;
   - « Show more/less » est également un disclosure.

   Ce qui casse : la règle produit « no text links to act » et la cohérence sémantique/accessibilité du DS. Pour le panneau de coût, il manque un petit composant DS de disclosure compact partagé par les deux segments. `ToggleChip` n’est pas parfaitement juste non plus : son contrat vise les options indépendantes d’un ensemble, alors que les deux segments pilotent le même panneau. Pour « Back… », le `RowActionButton` libellé correspond mieux à une action secondaire. `ClampedText` devrait employer ou décliner un composant de disclosure avec `aria-expanded`.

2. [spaces-list.ts](D:/APPS/NodalAI/apps/web/src/lib/spaces-list.ts:45) — la clé de groupe retombe sur le nom puis la tâche lorsque `scheduleId` est nul.

   La FK `schedule_id` est `ON DELETE SET NULL`. Deux automatisations supprimées ayant le même nom — cas permis après renommage/recréation — seront donc fusionnées en une seule ligne. Le test DB aggrave l’angle mort : [spaces-list-read.test.ts](D:/APPS/NodalAI/apps/web/src/lib/__tests__/spaces-list-read.test.ts:74) injecte un `scheduleId` fictif dans `triggerContext` via `as never`, mais ce champ n’existe pas dans le type réel et `toSpaceListRow` ne le lit pas.

   Ce qui casse : la promesse « une ligne par automatisation » et les compteurs/statuts/coûts associés. Il faut soit conserver un identifiant stable dans la provenance, soit définir explicitement le comportement des historiques dont la schedule a été supprimée et le tester avec deux schedules homonymes.

### Mineur

1. [ScheduledSection.tsx](D:/APPS/NodalAI/apps/web/src/app/(dashboard)/scheduled/ScheduledSection.tsx:9) — le commentaire affirme encore que le composant est aussi « une section en bas de `/spaces` », alors que P9 l’en a retiré. Documentation trompeuse seulement.

## Réponse aux quatre doutes

1. **Export de `ScheduleRunList`**  
   Le découpage reste défendable comme composant de présentation des runs, mais sa justification actuelle est dictée par le test. Une meilleure preuve serait un test d’interaction : rendre `ScheduledSection`, cliquer son `DisclosureButton`, puis vérifier les liens `/spaces/<id>`. Sans environnement DOM, l’export nommé est un compromis acceptable et n’est pas un défaut de production.

2. **`TextButton` dans `StatusBar`**  
   Non, la règle produit n’est pas tenue. Les segments sont des disclosures, pas des toggles `aria-pressed`. `ToggleChip` est proche visuellement mais son contrat « option indépendante dans un ensemble » ne convient pas aux deux contrôles du même panneau. Il faut un composant DS de disclosure compact avec `aria-expanded`; « Back… » doit être un vrai bouton secondaire, par exemple le `RowActionButton` libellé.

3. **Test GLM**  
   Oui, il protège encore le prix : une constante attendue volontairement recopiée est un test de régression du catalogue. Pour protéger également la provenance, conserver un fixture daté issu de la réponse OpenRouter et tester la transformation catalogue depuis ce fixture serait plus solide. Un appel réseau live serait un smoke test séparé, potentiellement instable, pas un remplacement du test unitaire.

4. **Totalité de `groupSpaces`**  
   C’est une garde utile, pas une dette urgente : une ligne non-cron n’est pas perdue silencieusement. En revanche, la fonction ne trie pas réellement `conversations`; elle préserve l’ordre d’entrée. Le commentaire/la formulation du doute devrait donc parler de conservation, pas de tri.

## Exécution

- Inspection statique des fichiers du périmètre : exécutée.
- `git show` / vérification matérielle du commit `b9ff0f1b` : **NON EXÉCUTÉ**.
- Tests Vitest, lint, typecheck, architecture et mutation : **NON EXÉCUTÉ**.
- Fichiers non committés P5 : non relus, conformément au périmètre.

Ce n’est donc pas « rien de neuf » : les deux constats importants ci-dessus sont nouveaux.