## Constats

### 1. BLOQUANT — Un texte composé d’espaces remonte encore comme succès

[execute.ts:3103](D:/APPS/wt-delegation/apps/runner/src/job/execute.ts:3103), [resume.ts:54](D:/APPS/wt-delegation/packages/orchestration/src/router/resume.ts:54).

**Déclenchement :** un sous-job termine sans outil avec `response.text = "   "`. Le test `if (textContent)` réussit, la finalisation stocke les espaces et retourne `completed`. La normalisation conserve ce statut sans vérifier `summary.trim()`.

**Sens : faux succès.** Le parent reçoit un résultat typé `completed`, mais visuellement vide, sans rappel ni `empty_deliverable`. La garde ajoutée ne couvre pas cette sortie.

### 2. BLOQUANT — Le parent peut encore annoncer une attente après un échec

[execute.ts:3127](D:/APPS/wt-delegation/apps/runner/src/job/execute.ts:3127), [execute.ts:4055](D:/APPS/wt-delegation/apps/runner/src/job/execute.ts:4055).

**Déclenchement :** après un retour de délégation échoué, le parent répond sur `api` ou `dashboard` : « Recherche lancée, je reviens vers toi », sans appeler `return_result`. La branche texte finalise immédiatement, sans consulter `unresolvedToolFailures`.

Sur Telegram, un appel d’envoi contenant cette promesse s’exécute **avant** la garde de finalisation. Refuser ensuite `return_result` n’annule pas le message déjà reçu.

**Sens : faux succès ou fausse promesse déjà livrée.** L’interdiction figure dans le prompt, mais le mécanisme ajouté ne garantit pas le comportement annoncé.

### 3. IMPORTANT — Une délégation de secours réussie ne résout pas l’échec initial

[execute.ts:2640](D:/APPS/wt-delegation/apps/runner/src/job/execute.ts:2640), [execute.ts:4186](D:/APPS/wt-delegation/apps/runner/src/job/execute.ts:4186).

**Déclenchement :** `assign_a` échoue ; conformément au rappel, le parent confie le travail à `assign_b`. B livre une réponse complète. Le parent restitue cette réponse avec `return_result{status:"success"}`.

L’historique conserve `assign_a` dans l’ensemble des échecs : le succès de B ne supprime que `assign_b`. Faire le travail soi-même ne supprime pas davantage `assign_a`. Après deux rappels, le parent échoue avec `unresolved_tool_failure`.

**Sens : faux échec.** Deux solutions explicitement proposées au modèle ne permettent pas de terminer honnêtement en succès.

### 4. IMPORTANT — Le texte final d’un sous-agent qui délègue peut être remplacé par les résultats de ses enfants

[state.ts:349](D:/APPS/wt-delegation/apps/runner/src/job/state.ts:349), [execute.ts:4330](D:/APPS/wt-delegation/apps/runner/src/job/execute.ts:4330), [execute.ts:4417](D:/APPS/wt-delegation/apps/runner/src/job/execute.ts:4417).

**Déclenchement :** un sous-agent délègue une étape, puis écrit sa synthèse finale avec `return_result`. Le runner passe `result: ''` à la finalisation. `completeJob` compile d’abord les résultats des enfants ; puisque cela remplit `result`, la récupération du texte final devient inopérante.

**Sens : perte du livrable final.** Le grand-parent reçoit la compilation des étapes, pas la synthèse pourtant écrite. Le contrat « son texte final, exactement et uniquement » ne tient pas.

### 5. IMPORTANT — Un enfant ayant livré peut quand même provoquer `empty_deliverable` chez le parent

[execute.ts:4287](D:/APPS/wt-delegation/apps/runner/src/job/execute.ts:4287), [state.ts:350](D:/APPS/wt-delegation/apps/runner/src/job/state.ts:350).

**Déclenchement :** parent `api`, appel `assign_*` sans texte d’accompagnement ; enfant réussi avec résultat non vide ; parent repris qui appelle seulement `return_result{status:"success"}`.

Le résultat de l’enfant est un message **tool**, pas un texte assistant. La garde ne regarde ni les résultats des enfants ni leur compilation future. Elle rappelle, puis échoue si le parent répète le signal.

**Sens : faux diagnostic de vide.** Le contenu existe et `completeJob` saurait le récupérer, mais la nouvelle garde empêche d’atteindre cette récupération.

### 6. IMPORTANT — Le catalogue prescrit encore le contrat qui a causé l’incident

[results-delivery.ts:29](D:/APPS/wt-delegation/packages/catalog/src/skills/results-delivery.ts:29), [results-delivery.ts:48](D:/APPS/wt-delegation/packages/catalog/src/skills/results-delivery.ts:48), [code-review.ts:30](D:/APPS/wt-delegation/packages/catalog/src/skills/code-review.ts:30).

**Déclenchement :** un worker utilise ces skills. `results-delivery` exige toujours un `return_result` contenant le contenu complet ; `code-review` demande de retourner le verdict par cet outil, sans prose autour du champ résumé.

Or [return-result.ts:9](D:/APPS/wt-delegation/packages/tools/src/builtin/return-result.ts:9) ne transporte que `status` et `reason`.

**Sens : instructions contradictoires, contenu perdu ou échec provoqué.** La PR corrige trois descriptions, mais laisse des instructions opérationnelles prescrire l’ancien comportement. L’affectation effective de ces skills aux agents installés reste à vérifier en DB.

### 7. IMPORTANT — Le rappel est unique par exécution, pas par job

[execute.ts:2679](D:/APPS/wt-delegation/apps/runner/src/job/execute.ts:2679), [execute.ts:2435](D:/APPS/wt-delegation/apps/runner/src/job/execute.ts:2435).

**Déclenchement :** premier signal vide → rappel ; appel soumis à approbation sans texte → suspension ; approbation puis reprise ; nouveau signal vide.

`emptyDeliverableNudges` repart à zéro. Le second signal vide obtient donc un autre rappel au lieu de l’échec annoncé.

**Sens : protection retardée.** Ce constat ne prouve pas une boucle infinie — les limites globales subsistent — mais réfute le rappel unique sur tout le cycle du job.

## Les sept questions

1. **constat** — Les constats 1 à 6 couvrent des vides acceptés, une promesse après échec, un texte final perdu et des livrables rejetés. Les `assign_*` simultanés sont sérialisés avec reports des autres appels ; cela ne constitue pas une preuve du fan-out `create_task` avec un enfant vide. Ce dernier parcours reste **NON TRANCHÉ**.

2. **constat** — Deux `return_result` vides dans une même exécution donnent bien un rappel puis `empty_deliverable`. Le compteur est distinct des autres rappels, mais repart à zéro après suspension. Deux tours entièrement vides sans outil empruntent un autre mécanisme de retry.

3. **tient** — Sur le chemin `empty_deliverable`, le parent reçoit le code dans `error` et `exit_reason`. `failJob` conserve ce code en DB et produit une explication générique ; l’écran affiche également l’erreur. Ce n’est donc pas seulement « failed ». Le test écran injecte toutefois une explication rédigée que le moteur ne produit pas telle quelle.

4. **constat** — Le schéma de `return_result` n’a pas changé dans cette PR ; son usage désormais refusé reste prescrit par plusieurs skills du catalogue. Les mocks existants ont été adaptés. Les personnalités stockées en DB restent **NON TRANCHÉES**.

5. **constat** — Les dix cas vérifient des statuts, résultats DB et contenus de messages ; ils ne se limitent pas aux nombres d’appels. Plusieurs resteraient verts avec la garde du vide débranchée : normalisation du résultat, compilation des enfants, succès avec texte et report de délégation. C’est cohérent avec leur portée, mais ils ne prouvent pas une chaîne complète `assign → enfant → resume → livraison`. Le test « rappel unique » vérifie sa présence, pas son unicité.

6. **tient** — Le parcours écran apporte une preuve distincte : visibilité, couleur d’échec, ouverture du détail et rendu du livrable. Il ne prouve pas que le moteur produit ces données ni que le parent évite une promesse : sa réponse honnête est injectée directement dans la fixture.

7. **constat** — Des chemins non couverts subsistent. Analyse statique en lecture seule ; tests et mutations non exécutés durant cette revue.

des constats