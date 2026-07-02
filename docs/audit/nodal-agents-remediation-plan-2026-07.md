# Nodal-Agents — Plan de remédiation unique (ordonné par sévérité)

Légende : **Complexité** Trivial/Faible/Moyen · **Bénéfice** Fort/Moyen/Faible (valeur gagnée). Ordre : sévérité décroissante, puis rentabilité (fix facile + gros bénéfice d'abord).

---

## 🔴 SÉVÉRITÉ ÉLEVÉE

### 1. Garde de profondeur de délégation
`apps/runner/src/job/execute.ts:~629` (près du check chainCount) · Complexité **Faible** · Bénéfice **Fort**
**Résout** : la limite « profondeur 3 » (invariant #8) est aujourd'hui inopérante — le compteur en mémoire repart à 0 à chaque job et la profondeur persistée n'est jamais comparée au max. Un cycle d'agents (A→B→A) ou une longue chaîne d'orchestrateurs récurse sans borne → stack overflow / épuisement ressources / explosion de coût. Le fix (comparer `job.delegationDepth` au max, failJob si dépassé) referme un déni de service pour ~5 lignes.

### 2. IDOR sur la résolution d'approbation
`apps/runner/src/approvals/resolve.ts:44` + `apps/web/src/lib/actions.ts:3668` · Complexité **Faible** · Bénéfice **Fort**
**Résout** : aujourd'hui une approbation est chargée par ID seul, sans filtre d'entité. Un utilisateur authentifié du tenant A peut approuver/rejeter une action gatée (ex. un `run_command`) d'un tenant B s'il en connaît le GUID. **Exploitable dès qu'il y a 2 utilisateurs dans une entité.** Le fix (exiger `approval.entityId === entité de l'appelant`, aux deux niveaux) rétablit le contrôle d'approbation par le bon tenant.

### 3. Vérification d'entité sur les sous-agents à l'édition
`apps/web/src/lib/actions.ts:767` (calquer `packages/db/src/repos/agents.ts:57`) · Complexité **Faible** · Bénéfice **Fort**
**Résout** : `updateAgentAction` insère les `subAgentIds` sans vérifier qu'ils appartiennent à l'entité (le chemin de *création*, lui, le fait). Un tenant pourrait rattacher l'agent d'un autre tenant comme sous-agent et l'exécuter (sa config, ses skills, **sa clé LLM**). Le fix (répliquer le `inArray + entityId`) supprime la seule asymétrie de scoping des assignations.

### 4. Autorisation par entité sur la surface HTTP du runner (racine)
`apps/runner/src/server.ts:60-99` + `routes/chat.ts` + `routes/agent.ts` · Complexité **Moyen** · Bénéfice **Fort**
**Résout** : le runner *authentifie* l'appelant (WORKER_SECRET, ou en mode `bearer-token` n'importe quelle session valide) mais ne l'*autorise* jamais contre l'entité de la requête. En mode `bearer-token`, un user du tenant A peut appeler `/api/chat`/`/api/approve`/`/api/agent` avec les ids du tenant B → run cross-tenant (mémoire + clé LLM de la victime), approbation cross-tenant. Le fix (lier session→entité et asserter que les ids du body lui appartiennent) est le parapluie qui ferme #2 et #5 à la racine.

### 5. `/api/chat` ne doit pas prendre entityId+agentId du body
`apps/runner/src/routes/chat.ts:16` → `chat/run-chat-turn.ts:107` · Complexité **Faible-Moyen** · Bénéfice **Fort**
**Résout** : le tour de chat s'exécute pour l'entité/agent *choisis par l'appelant*. En dérivant l'entité de la session (au lieu du body), on empêche un appelant `bearer-token` de faire tourner l'agent d'autrui, d'injecter la mémoire durable d'un autre tenant dans le prompt et de consommer sa clé LLM. (Largement couvert par le fix #4.)

### 6. Master-switch d'exécution de code LAN incomplet
`apps/runner/src/job/execute.ts:1210` (généraliser 8b) + `packages/tools/src/execute.ts:88` · Complexité **Moyen** · Bénéfice **Fort**
**Résout** : le master-switch `lanCommandYolo` ne protège que `run_command`. `run_skill_script` (exécute .py/.sh) et `skill_file_write` s'auto-approuvent quand même via la relaxation d'autonomie (`destructive_gate`/`fully_autonomous`) sur LAN — donc du code s'exécute sans humain alors que l'owner croit l'avoir désactivé. Le fix (appliquer le même strip+inject `require_approval` aux 3 outils d'exécution de code quand `lanCommandYolo=off`) aligne le comportement réel sur le modèle de sécurité documenté et neutralise aussi la relaxation (via `matchedRule`).

---

## 🟠 SÉVÉRITÉ MOYENNE

### 7. Fuite de secrets via `env: process.env`
`packages/tools/src/builtin/run-command.ts:138` · `run-skill-script.ts:208` · Complexité **Faible-Moyen** · Bénéfice **Fort**
**Résout** : les process enfants héritent de tout l'environnement du runner (DATABASE_URL, WORKER_SECRET, clés LLM). Une commande anodine approuvée une fois (`env`, `printenv`, `node -e process.env`) exfiltre tous les secrets. Le fix (passer un env allowlisté/scrubé) coupe l'exfiltration même sous approbation ou Yolo. Composé avec #6, c'est le pilier « exfiltration » de la chaîne RCE.

### 8. Root « toutes tâches échouées » marqué `completed`
`apps/runner/src/cron/deliver-results.ts:88` · Complexité **Moyen** · Bénéfice **Fort**
**Résout** : un fan-out cron où toutes les tâches échouent est quand même marqué `completed` (le corps tague `[failed]` mais le statut ment) — observé en vrai sur ton job `ba150eaa`. Toute logique/dashboard filtrant sur `status='completed'` est trompée (invariant #4). Le fix (dériver le statut root des statuts de tâches : `failed` si tout échoue, `completed` si tout réussit, partiel sinon) rend le statut honnête.

### 9. Drift test-helper vs prod (contraintes UNIQUE)
`packages/db/src/tests/helpers.ts:220,406` · Complexité **Faible** · Bénéfice **Moyen**
**Résout** : le schéma de test déclare `UNIQUE(entity_id, slug)` sur connectors/mcp, contraintes que les migrations prod 0016/0017 ont *supprimées* (multi-instance). Les tests testent un monde qui n'existe pas → les régressions multi-instance passent inaperçues (invariant #5). Le fix (retirer les 2 UNIQUE du helper) réaligne les tests sur la prod.

### 10. Plancher catastrophic limité à `run_command`
`packages/tools/src/execute.ts:110` · Complexité **Faible** · Bénéfice **Moyen**
**Résout** : le disjoncteur de dernier recours (une commande machine-destructive n'est jamais auto-approuvable) ne couvre pas `run_skill_script`, qui peut faire les mêmes dégâts sous Yolo. Le fix (étendre le plancher au script) rétablit la symétrie du circuit-breaker.

### 11. Cap de coût $ sous-compté aux suspend/resume
`apps/runner/src/job/execute.ts:1475,1552,2400,2886` · Complexité **Faible** · Bénéfice **Moyen**
**Résout** : `totalCostUsd` n'est persisté qu'en fin de tour ; les checkpoints de suspension (approbation, délégation) l'omettent, donc le coût du tour déclencheur est perdu au resume → le plafond `maxCostPerJobUsd` (Guard 1e) est dépassable sur les workflows à suspensions répétées. Le fix (ajouter `totalCostUsd` aux 4 saveCheckpoint) rend le cap fiable.

### 12. `local-trust` + bind LAN non gardé
`apps/runner/src/server.ts:65` · `apps/cli/src/lib/env.ts:52` · Complexité **Moyen** · Bénéfice **Moyen**
**Résout** : rien n'empêche de configurer `auth.mode=local-trust` (pass-through, zéro auth) avec `bind=lan` (0.0.0.0) → toutes les routes non authentifiées sur le LAN + `auto_approve` run_command actif = RCE non authentifiée. Le fix (refuser ou avertir sur `local-trust` + bind non-loopback) supprime le footgun.

### 13. `'rate limit exceeded'` traité comme quota fatal
`packages/llm/src/retry.ts:26` · Complexité **Faible** · Bénéfice **Moyen**
**Résout** : un 429 transitoire (throttle par-minute d'OpenRouter/Groq) est classé `QuotaExhaustedError` (non-retryable) → échec immédiat sans backoff, alors que le même 429 formulé autrement serait retryé. Le fix (exiger la co-occurrence avec quota/billing/credit) évite des échecs de jobs sporadiques sous charge.

### 14. Approbation Telegram par n'importe quel membre d'un groupe
`apps/runner/src/telegram/approval-callback.ts:103` · Complexité **Moyen** · Bénéfice **Moyen**
**Résout** : le gate vérifie que le tap vient du bon *chat*, pas de la bonne *personne*. Dans un groupe, n'importe quel membre peut approuver une action destructive. Le fix (comparer `cb.from.id` à un owner autorisé, ou n'accepter l'approbation par bouton qu'en DM) rétablit le contrôle par l'utilisateur légitime.

### 15. Tâche planner bloquée par une dép `blocked`/`cancelled`
`packages/orchestration/src/planner/dependencies.ts:139` · Complexité **Moyen** · Bénéfice **Moyen**
**Résout** : une dépendance qui finit `blocked`/`cancelled` laisse la tâche dépendante en `todo` pour toujours → le root n'atteint jamais l'état terminal → résultat jamais livré (stall silencieux, viole #4). Le fix (traiter une dép cancelled/blocked comme résolue-échouée : propager l'échec ou marquer la dépendante `blocked`) évite le figement.

### 16. Délégation imbriquée : parent coincé `awaiting_delegation`
`apps/runner/src/job/execute.ts:2511,507` · Complexité **Moyen** · Bénéfice **Moyen**
**Résout** : quand un enfant délégué crée lui-même des tâches, il est finalisé plus tard par le cron, qui n'appelle pas `maybeResumeParent` → le parent reste suspendu indéfiniment. Le fix (la finalisation cron d'un enfant doit aussi tenter de reprendre le parent) débloque la chaîne.

### 17. Approbations concurrentes ré-appariées par `toolName`
`apps/runner/src/job/execute.ts:2201,1456` · Complexité **Moyen** · Bénéfice **Faible-Moyen**
**Résout** : le pré-pass parallèle de lectures peut créer plusieurs approbations dans un tour, mais le remplacement au resume apparie par `toolName` (hypothèse « ≤1 approbation/tool/tour ») → sortie approuvée perdue/dupliquée si un même outil-read est gaté ≥2 fois. Le fix (apparier par `toolCallId`, ou exclure les outils gatables du pré-pass) supprime le mésappariement.

### 18. Invariants sémantiques non enforced par la CI
`.dependency-cruiser.cjs` · `eslint.config.js` · `.github/workflows/ci.yml` · Complexité **Moyen** · Bénéfice **Moyen**
**Résout** : les invariants #1 (no hardcode metadata), #2, #3, #4, #6, #8, #9 reposent uniquement sur la revue humaine — aucun garde-fou CI (seuls les structurels + no-any + native-dialogs le sont). Le fix (règles ESLint custom / tests d'architecture ciblés, ex. détecter un `where` sans `entityId` sur tables scopées, un texte user-facing littéral dans le runner) réduit la dérive à long terme.

---

## 🟡 SÉVÉRITÉ FAIBLE

### 19. Erreur d'outil >50K → faux `completed`
`apps/runner/src/job/execute.ts:2628,1318` · Complexité **Faible** · Bénéfice **Moyen**
**Résout** : `isToolErrorBlock` ne reconnaît l'erreur que si `output.type==='json'` ; une grosse erreur (sérialisée en `text` tronqué >50K) dans le même tour qu'un `return_result(success)` passe inaperçue → faux completed. Le fix (détecter la forme d'erreur avant troncature) ferme cet angle mort d'honnêteté.

### 20. Schedules exécutés inline bloquent le tick cron
`apps/runner/src/cron/run-schedules.ts:148` · `tick.ts:97` · Complexité **Moyen** · Bénéfice **Moyen**
**Résout** : un schedule long (orchestrateur 8 min) gèle la livraison + le curator du tick, et les ticks 120s se chevauchent. Le fix (fire-and-forget comme la phase recovery, ou verrou anti-chevauchement) rétablit la réactivité du cron.

### 21. Cap coût $ inopérant hors OpenRouter
`apps/runner/src/job/execute.ts:1853` · Complexité **Moyen** · Bénéfice **Moyen**
**Résout** : le coût n'est lu que dans `providerMetadata.openrouter` ; sur clé native (DeepSeek/Anthropic-direct/…) `totalCostUsd` reste 0 → Guard 1e ne se déclenche jamais. Le fix (dériver coût = tokens × prix catalogue pour les natifs) rétablit le plafond $ partout. (Dette assumée aujourd'hui.)

### 22. Version-check sans `semver-gt`
`apps/cli/src/commands/up.ts:377` · Complexité **Trivial** · Bénéfice **Faible**
**Résout** : `latest !== installed` affiche la version npm même si elle est *plus ancienne* que l'installée → suggère un downgrade (« v0.6.8 available » quand on est en 0.7.0). Le fix (`semver.gt(latest, installed)`) n'affiche la notice que pour une vraie mise à jour.

### 23. Comparaison du bearer token non constant-time
`packages/auth/src/providers/bearer-token.ts:30` · Complexité **Trivial** · Bénéfice **Faible**
**Résout** : `provided !== token` (comparaison string) expose un canal auxiliaire temporel sur le token API LAN. Le fix (réutiliser `timingSafeEqual`, déjà utilisé pour WORKER_SECRET) supprime le side-channel.

### 24. `create_task assigned_to` sans check d'entité
`packages/orchestration/src/planner/task-tools.ts:92` · Complexité **Faible** · Bénéfice **Faible**
**Résout** : un slug d'agent est résolu globalement ; un orchestrateur qui fournit le slug d'un autre tenant créerait une tâche assignée à un agent étranger (défense en profondeur ; faible proba car il faut connaître le slug). Le fix (rejeter si `agent.entityId !== ctx.entityId`) ferme le trou par précaution.

### 25. Téléchargement d'archive : OOM + SSRF via redirect
`apps/runner/src/skills/fetch.ts:41,51` · Complexité **Moyen** · Bénéfice **Faible**
**Résout** : le corps est entièrement bufferisé avant le cap 50 Mo (OOM possible si un hôte allowlisté sert plusieurs Go) et `redirect:'follow'` ne re-valide pas l'allowlist (open-redirect → SSRF aveugle). Le fix (cap en streaming incrémental + re-valider l'hôte à chaque redirection) durcit l'install communautaire.

### 26. `streamText` contourne le failover
`packages/llm/src/failover.ts:98` · Complexité **Moyen** · Bénéfice **Faible**
**Résout** : `streamText` n'a pas de wrapper de bascule provider (contrairement à generateText). Latent aujourd'hui (le chemin chaud est generateText), mais fragile si un chemin streaming devient porteur. Le fix (envelopper streamText dans `runWithFailover`) rend le streaming résilient.

### 27. `deliverCompletedRoots` re-scanne toute `agent_tasks`
`apps/runner/src/cron/deliver-results.ts:34` · Complexité **Faible-Moyen** · Bénéfice **Faible**
**Résout** : chaque tick (120s) fait un `selectDistinct(rootJobId)` sur tout l'historique des tâches (la rétention ne purge pas les tasks) → coût cron croissant à l'échelle. Le fix (join sur `agent_jobs.completed_at IS NULL` + index, ou fenêtre temporelle) borne le scan.

### 28. Lectures de jobs enfants non re-scopées
`apps/web/src/lib/actions.ts:1558,1464` · Complexité **Faible** · Bénéfice **Faible**
**Résout** : ces lectures récupèrent des jobs par `parentJobId`/`inArray(id)` sans prédicat `entityId` (pas de fuite réaliste car le row-set parent est déjà entité-vérifié, mais ça repose sur un invariant non enforced). Le fix (ajouter `eq(entityId, session.entityId)`) applique la défense en profondeur.

### 29. run_command catastrophique approuvé → jamais exécuté, erreur opaque
`apps/runner/src/job/execute.ts:1410` · Complexité **Faible** · Bénéfice **Faible**
**Résout** : une commande catastrophique que l'humain a *explicitement* approuvée est re-bloquée par le plancher au resume → devient une erreur interne opaque (`unexpected_gate_on_approved_tool`) au lieu de tourner ou d'expliquer clairement. Fail-safe (bon pour la sécu) mais déroutant. Le fix (message clair « refusé par le plancher de sécurité même après approbation ») lève l'ambiguïté UX.

---

## Séquence recommandée
1. **Sprint 1 (quick wins Élevé)** : #1, #2, #3 — tous *Faible × Fort*, ferment un DoS + 2 fuites cross-tenant.
2. **Sprint 2 (racine + exécution)** : #4, #5, #6, #7 (env), #8 (faux completed).
3. **Sprint 3 (fiabilité Moyen)** : #9→#18.
4. **Sprint 4 (durcissement Faible)** : #19→#29, dont les triviaux #22/#23 à glisser n'importe quand.
