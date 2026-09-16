## Constats

### 1. IMPORTANT — Deux blocs prescrivent encore des actions impossibles sur le chat

**Le constat tient.**

- `packages/orchestration/src/system-prompt.ts:292` ordonne « Call them directly » pour les services locaux. Le bloc est injecté sans filtre de surface, ligne 1020. **Déclenchement réel :** le chat fournit systématiquement `deployment` (`apps/runner/src/chat/run-chat-turn.ts:354`, puis `:363`). L’agent reçoit donc l’ordre d’appeler directement une API locale alors qu’il ne dispose que de `run_task`.
- `packages/orchestration/src/agent-baseline.ts:300` prescrit au ROOT `attach_connector` / `attach_mcp`. **Déclenchement :** un connecteur ou serveur MCP configuré dans l’espace mais non attaché à cet agent. `buildDiscoverabilityBlock` est appelé sans condition de surface (`system-prompt.ts:1102`).

**Sens de l’erreur : injection excessive de gestes et annonce d’outils absents.** `hasNodalTools` ne couvre pas toutes les prescriptions. La fixture corrigée ne fournit ni déploiement ni ressource configurée non attachée ; son expression régulière ne détecterait pas « Call them directly » (`chat-surface-cost.test.ts:183`).

### 2. IMPORTANT — La variante chat retire la procédure d’approbation d’une conversation

**Le constat tient.**

`packages/orchestration/src/system-prompt.ts:740` retourne avant les lignes 751–753 : le chat conserve les plateformes et leurs compteurs, mais perd l’explication permettant d’autoriser une nouvelle conversation — mentionner le bot dans celle-ci, ou lui écrire depuis celle-ci, puis approuver la carte produite.

**Déclenchement :** canal activé, puis question dans le chat : « Comment t’autoriser à écrire dans ce nouveau salon ? »

Cette information permet une réponse conversationnelle sans aucun outil. La remplacer par « transmettre la plateforme et la conversation au job » ne préserve pas ce savoir.

**Sens de l’erreur : suppression excessive d’une information utile à l’utilisateur, avec les gestes réservés au job.**

### 3. MINEUR — Les commentaires contradictoires signalés en passe 2 subsistent

**Le constat tient ; ces éléments étaient déjà connus.**

- `packages/orchestration/src/system-prompt.ts:953` affirme que l’index des skills reste sur CLI ; la branche `:962` retourne pourtant `''` à `:984`.
- `apps/runner/src/chat/run-chat-turn.ts:6` annonce l’absence d’outils et l’impossibilité de créer un job ; `CHAT_TOOLS` existe à `:52` et est transmis à `:460`.
- `packages/catalog/src/types.ts:55` affirme que les autres kinds ignorent `surfaces` ; les channels passent aussi par `skillContentOn` (`agent-baseline.ts:41`, `:203`).

**Déclenchement :** lecture de ces commentaires pour déterminer le contrat des surfaces.

**Sens de l’erreur : documentation trompeuse sur les capacités et le contenu réellement injectés.**

Aucun **BLOQUANT** démontré.

## Les six questions

| # | Verdict |
|---|---|
| 1 | **tient** — Les trois correctifs importants existent : condition commune dans `system-prompt.ts:816`, canaux `:905`, index des skills `:943`, variante chat `:985`, dossiers `:1048`, mémoire `:1069`, conversation `:1079`. Le test vérifie désormais les titres conservés et les phrases de job exclues (`chat-surface-cost.test.ts:118`, `:122`). Fraîcheur, succès rapporté et portée partielle sont rétablis dans `verify-before-done.ts:27`, `:28`, `:29`. |
| 2 | **constat** — Oui : appels directs aux services locaux et outils d’attachement, constat 1. Les corrections des blocs visés sont présentes, mais la promesse globale reste fausse. |
| 3 | **constat** — Oui : procédure d’approbation des conversations, constat 2. Les noms et chemins des dossiers, les skills assignées, les plateformes, les compteurs et les souvenirs restent présents. |
| 4 | **tient** — La bascule `fileTools` conserve le bloc de fichiers CLI : `'own'` est sélectionné à `system-prompt.ts:1050`, produit `nodalFileTools = false` à `:657`, puis restitue le texte antérieur à `:663`. Cela ne signifie pas que tout le prompt CLI est inchangé : les blocs canaux et conversation sont aussi modifiés par ces commits. |
| 5 | **constat** — Oui : constat 3, déjà signalé en passe 2. |
| 6 | **constat** — Deux éléments nouveaux subsistent : prescriptions périphériques et perte de la procédure d’approbation. |

Revue statique sur `5c687072`. **NON TRANCHÉ** pour l’exécution des tests : aucun test lancé dans ce worktree en lecture seule ; aucun rouge de résolution des paquets frères interprété comme une régression.

des constats