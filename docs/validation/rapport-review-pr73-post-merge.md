## BLOQUANTS / IMPORTANTS

**1. Le constat tient — IMPORTANT : des règles applicables au chat sont retirées.**  
[verify-before-done.ts:18](C:/Users/kwint/AppData/Local/Temp/wt-revue-runtime/packages/catalog/src/skills/verify-before-done.ts:18), [safe-tool-use.ts:18](C:/Users/kwint/AppData/Local/Temp/wt-revue-runtime/packages/catalog/src/skills/safe-tool-use.ts:18).

Déclenchement : demander au chat de reformater des données présentes dans le message, ou de confirmer un état qu’il ne peut pas vérifier. Le filtre supprime aussi les règles « contrôler les données transformées » (ligne 47) et « dire explicitement qu’on ne peut pas vérifier » (ligne 110). Elles ne nécessitent aucun outil supplémentaire.

**Sens de l’erreur : suppression excessive de consignes, favorisant un faux succès ou une affirmation sans preuve.** La présence de prescriptions de fichiers dans une skill ne rend pas toutes ses règles inapplicables.

**2. Le constat tient — IMPORTANT : les tests laissent passer des prescriptions d’outils absents.**  
[agent-baseline.ts:121](C:/Users/kwint/AppData/Local/Temp/wt-revue-runtime/packages/orchestration/src/agent-baseline.ts:121), [agent-baseline.ts:136](C:/Users/kwint/AppData/Local/Temp/wt-revue-runtime/packages/orchestration/src/agent-baseline.ts:136).

Deux déclencheurs actuels :

- Chat d’un agent de rôle `agent` : `WORKER_DISCOVERY_BLOCK` demande toujours `save_memory`.
- Chat utilisant notamment MiniMax, DeepSeek ou GLM : le renforcement reste actif grâce à `Language mirror` et prescrit encore l’utilisation de `skill_view` / `run_skill_script`.

Le test mémoire vérifie seulement l’absence du titre `## Memory discipline`; sa fixture impose un orchestrateur avec `test-model`.

**Sens de l’erreur : faux vert de couverture.** Les assertions n’établissent pas la promesse « uniquement des instructions exécutables ». Ces blocs préexistaient ; la PR les laisse subsister.

Aucune perte de données déterministe ni aucun blocage démontré.

## MINEURS

**3. Le constat tient — MINEUR : caractères présentés comme preuve de coût en jetons.**  
[chat-surface-cost.test.ts:91](C:/Users/kwint/AppData/Local/Temp/wt-revue-runtime/packages/orchestration/src/tests/chat-surface-cost.test.ts:91).

Déclenchement : exécuter le test de coût. Il compare `.length`, donc des unités UTF-16, sur une fixture minimale.

**Sens de l’erreur : portée de la preuve exagérée.** Cela ne reproduit ni les 4 770 jetons d’Alfred, ni la baisse de 47 % annoncée.

**4. Le constat tient — MINEUR : les channels sont filtrés avec la surface `job`.**  
[agent-baseline.ts:148](C:/Users/kwint/AppData/Local/Temp/wt-revue-runtime/packages/orchestration/src/agent-baseline.ts:148).

Déclenchement : déclarer une skill `channel` avec `surfaces: ['chat']`. `buildChannelBlock` appelle toujours `contentOfKind('channel')`, donc elle disparaît même pour un appel sur chat.

**Sens de l’erreur : exclusion indue.** Aucun channel actuel n’a cette déclaration ; défaut latent, avec un contrat contradictoire puisque `types.ts` annonce que les channels ignorent ce champ.

## Les douze questions

| # | Verdict |
|---|---|
| 1 | **Le constat est faux** concernant des outils supplémentaires configurables sur le chat Nodal. `CHAT_TOOLS`, défini dans `run-chat-turn.ts:52` et transmis à l’appel LLM, contient uniquement `run_task`. La whitelist DB concerne les jobs. Le retrait de règles portables tient néanmoins : constat 1. |
| 2 | **Le constat est faux** concernant un accès direct à `save_memory`. Un chemin indirect existe via un job `run_task`, lequel retrouve la discipline mémoire. Le retrait n’a pas de journalisation spécifique, mais cela ne démontre pas une perte silencieuse de faits. |
| 3 | **Le constat est faux** concernant une baseline oubliée : les quatre sont déclarées explicitement. **Le constat tient** pour les channels : constat 4. |
| 4 | **Le constat est faux** concernant une réinjection accidentelle actuelle. Les types ne sont pas identiques : catalogue = `job \| chat \| cli-runtime`, `JobContext` = `chat \| cli-runtime` optionnel. L’absence signifie volontairement job ; le chat transmet explicitement `chat`, et le CLI passe par son constructeur dédié. |
| 5 | **Le constat est faux** comme panne actuelle. Le défaut négatif accepterait une future surface, mais aucun appelant actuel ne démontre cette erreur. L’appel de production renseigne bien `escalation` pour le chat. |
| 6 | **Le constat est faux** concernant un `run_task` absent du premier appel chat : il est fourni sans condition de sous-agents ni whitelist. Son nom est bien littéral dans `team-block.ts:267`. C’est une instruction système, pas une réponse utilisateur ni une métadonnée d’agent ; les violations alléguées des invariants 1–2 ne sont pas établies. |
| 7 | **Le constat est faux** comme défaut démontré : le roster permet de préparer l’escalade. Son utilité ne se tranche pas par son seul coût. |
| 8 | **Le constat tient** pour caractères versus jetons : constat 3. Le seuil seul ne prouve pas la détection de chaque réinjection individuelle. |
| 9 | **Le constat est faux** comme garantie de deux tests rouges : le test des titres détecte chaque réinjection ; l’échec supplémentaire du ratio dépend des longueurs. |
| 10 | **Le constat est faux** : le test appelle réellement `buildSystemPrompt` avec `spinUpTestDb` et `seedMinimal`. La fixture reste différente du vrai Alfred. |
| 11 | **Le constat tient** : l’appel channel conserve le défaut `job`, constat 4. |
| 12 | **Le constat est faux** concernant une dépendance interdite : orchestration dépend déjà du catalogue, et la configuration autorise cette direction. |

Vérification sur HEAD `8eaa3e34`. Exécution des tests et du contrôle d’architecture tentée, mais empêchée par les dépendances locales manquantes ou inaccessibles (`pathe`, `semver`). Aucun résultat vert d’exécution revendiqué.

des constats