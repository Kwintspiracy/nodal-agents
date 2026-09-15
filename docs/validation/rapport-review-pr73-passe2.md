## Constats

### 1. IMPORTANT — Des blocs périphériques prescrivent encore des outils absents du chat

**Le constat tient.**

Déclenchements indépendants du rôle (`agent` / `orchestrator`) et du modèle :

- Une skill de capacité assignée : `packages/orchestration/src/system-prompt.ts:878` exclut seulement `cli-runtime`. Le chat reçoit donc l’obligation d’appeler `skill_view` puis `run_skill_script` aux lignes 902 et 906.
- Un canal connecté et activé : `system-prompt.ts:686` prescrit `list_conversations`. Ce bloc est chargé sans filtre de surface, ligne 830.
- Plusieurs dossiers attachés : `system-prompt.ts:652` ordonne `file_list`. L’appel ligne 953 désactive les instructions de fichiers uniquement pour `cli-runtime`.
- Des souvenirs injectés : `system-prompt.ts:575` autorise l’appel de `query_memory` pour les faits manquants ; le chat conserve cette branche, ligne 964.
- Une conversation sans projet courant : `system-prompt.ts:495` prescrit `ask_user`, puis `register_project`. Le véritable appel chat transmet bien la conversation (`apps/runner/src/chat/run-chat-turn.ts:364`).

Pourtant, `run-chat-turn.ts:460` ne fournit que `CHAT_TOOLS`, contenant `run_task`.

**Sens de l’erreur : injection excessive de consignes et annonce de capacités inexistantes.** Les trois blocs corrigés ne suffisent pas à établir la promesse globale. Les déclenchements ci-dessus fonctionnent avec ou sans équipe ; leur absence dans la fixture explique la couverture insuffisante.

### 2. IMPORTANT — Le test historique contredit directement le correctif

**Le constat tient.**

`packages/orchestration/src/tests/chat-surface-cost.test.ts:65` inclut `## Verify before done` et `## Safe tool use` dans les titres interdits sur chat ; l’assertion ligne 70 exige leur absence.

Or `packages/catalog/src/skills/verify-before-done.ts:23` et `safe-tool-use.ts:21` réintroduisent précisément ces titres dans `contentOnChat`, sélectionné par `packages/catalog/src/index.ts:125`.

Déclenchement : exécuter ce test avec les paquets de cette branche correctement installés.

**Sens de l’erreur : faux rouge du test, qui rejette le comportement voulu.** Cette contradiction est déductible des sources ; elle ne résulte pas du problème de résolution des paquets frères signalé dans la demande.

### 3. IMPORTANT — La version chat affaiblit la fraîcheur et la portée des preuves

**Le constat tient.**

`packages/catalog/src/skills/verify-before-done.ts:25` accepte une connaissance provenant de la conversation ou d’un résultat reçu ; ligne 28, le résultat du job devient ce qui établit que le travail est terminé.

Le texte complet exige pourtant une preuve fraîche, refuse de généraliser une vérification partielle et distingue le compte rendu de succès d’un worker du résultat effectivement vérifié.

Déclenchement : un ancien job a confirmé un état, puis l’utilisateur demande si cet état est **encore** vrai ; ou un job annonce un succès sans preuve vérifiable.

**Sens de l’erreur : suppression excessive d’une règle encore applicable.** Le chat peut conserver la distinction entre preuve actuelle, résultat ancien et simple déclaration, puis exprimer son incertitude ou escalader. L’absence d’outil de lecture ne justifie pas d’accepter une preuve périmée.

### 4. MINEUR — Des commentaires décrivent toujours un comportement différent du code

**Le constat tient.**

- `apps/runner/src/chat/run-chat-turn.ts:6` affirme qu’aucun outil n’est exposé et qu’aucun job ne peut être créé, contrairement à `CHAT_TOOLS` et à son utilisation.
- `packages/orchestration/src/system-prompt.ts:869` annonce que les skills restent listées sur CLI ; la branche ligne 878 produit une chaîne vide.
- `packages/catalog/src/types.ts:51` affirme que les autres kinds ignorent `surfaces`, alors que `agent-baseline.ts:203` applique le sélecteur aux channels. Ce dernier point était déjà connu en passe 1.

Déclenchement : utiliser ces commentaires pour déterminer le contrat des surfaces.

**Sens de l’erreur : documentation trompeuse sur les capacités exposées et les exclusions effectives.**

## Les six questions

| # | Verdict |
|---|---|
| 1 | **tient** — Les correctifs existent : variantes chat dans `agent-baseline.ts:83`, `:106`, sélection du renforcement `:167` et du rôle `:187` ; variantes des deux skills `verify-before-done.ts:23`, `safe-tool-use.ts:21` ; sélection centralisée `catalog/src/index.ts:123`. |
| 2 | **constat** — Oui, voir constat 1. Les branches corrigées couvrent les deux rôles et familles de modèles. Les blocs périphériques restent problématiques indépendamment de ces dimensions. Un canal connecté active le bloc de messagerie ; il n’active pas à lui seul l’étiquette Telegram, puisque le chat transmet `origin: 'dashboard'`. |
| 3 | **constat** — Oui, pour la fraîcheur et la portée des preuves : constat 3. Les règles de recoupement des données, d’incertitude explicite et de signalement des échecs sont bien revenues. |
| 4 | **tient** — Une mauvaise déclaration incluant `chat` fait gagner le texte complet sur `contentOnChat` (`index.ts:124`). Le sélecteur ne contrôle ni les outils ni le `kind`. Aucune déclaration actuelle des deux skills ne déclenche ce cas. Un kind inattendu est exclu par `contentOfKind`. Le chemin CLI actuel désactive la baseline (`system-prompt.ts:990`) : aucune réinjection par ce chemin n’est démontrée. |
| 5 | **constat** — Oui : constat 4. |
| 6 | **constat** — Des éléments nouveaux subsistent, notamment les prescriptions périphériques et le test incompatible avec le correctif. |

Aucun **BLOQUANT** démontré. Revue statique sur `97434da9`. **NON TRANCHÉ** pour l’exécution des tests : `pnpm` est absent du PATH ; aucun résultat rouge des paquets frères n’a été interprété comme une régression.

des constats