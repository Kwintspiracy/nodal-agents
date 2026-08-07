# REMEDIATION_PLAN — Nodal-Agents 0.8.1

**v3, 2026-08-07** — révisé après la phase live, puis **restructuré** : la découverte ne peut pas
être planifiée après les correctifs qu'elle est censée orienter.

**Quatre vagues, 23 actions.** La vague D (découverte) tourne **en parallèle** de la vague 1 et doit
être terminée **avant** d'engager la vague 2 — dont le contenu dépend de ce qu'elle trouvera.

```
        jour 0 ─────────────── jour 2 ─────────────── jour 6 ──────── jour 11
Vague 1 [ P0 + P1 XS/S ]──> publier 0.8.2
Vague D [ lever les 61 controles bloques ]──> re-planifier la vague 2
                                          Vague 2 [ correctifs, perimetre ajuste ]
                                                                 Vague 3 [ le reste ]
```

---

## Vague 1 — Les deux P0, plus tout P1 en effort XS/S

**~2 jours · débloque la publication d'une 0.8.2 · à lancer immédiatement**

Cette vague ne traite que du **prouvé**. Elle ne dépend d'aucune découverte et ne doit être retardée
par rien : SUPPLY-001 est une panne en cours sur le paquet publié.

| # | ID | Action | Effort | Dépend de |
|---|---|---|---|---|
| 1 | SUPPLY-001 | Épingler `next` à `16.2.6` exact dans le `package.json` généré par `build-pack.mjs`, puis retirer **tous** les carets des dépendances de runtime du pack, régénérées depuis le lockfile résolu. | XS puis S | — |
| 2 | SUPPLY-001 · PERF-001 | Câbler `scripts/verify-install.mjs` en CI : `pack:build` → install dans un répertoire vierge → `up` → interroger `/api/health` du **runner ET du dashboard** → `down`. Échouer si l'un des deux ne répond pas. *Ce script existe depuis l'incident 0.8.0 et n'a jamais été appelé.* | S | 1 |
| 3 | NETWORK-001 | Middleware Hono sur le **runner** : rejeter toute requête dont l'`Origin` est présent et hors liste (`APP_URL` + `isPrivateOrigin`), et valider `Host` contre les hôtes attendus. Réutiliser `packages/auth/src/lib/private-origin.ts` tel quel. | S | — |
| 4 | NETWORK-001 | **Dashboard** : définir `experimental.serverActions.allowedOrigins` dans `next.config.ts` (aujourd'hui seul `allowedDevOrigins`, qui ne vaut qu'en dev), plus la même validation `Host`. Sans ce point, le rebinding DNS reste ouvert sur :3000. | S | — |
| 5 | NETWORK-001 | Test de régression : les six requêtes de l'audit — sans auth, `Host` falsifié, `Origin` attaquant, `text/plain`, et `Origin`+`Host` cohérents en `evil.test` sur **les deux** ports — doivent être rejetées. | XS | 3, 4 |
| 6 | **MCP-001** | Donner `defaultApproval: 'require_approval'` à tout outil MCP dans `buildMcpToolDefinition`, et poser la règle `auto_approve` **par serveur au moment de l'attachement**, dans l'écran où l'utilisateur ajoute le serveur. Ne **pas** s'appuyer sur `riskLevel` : il est déclaré par le serveur tiers. | S | — |
| 7 | MCP-001 | Test de régression : un outil MCP sans règle doit renvoyer `awaiting_approval` dans les quatre modes d'autonomie. La contre-épreuve de l'audit sert de modèle. | XS | 6 |
| 8 | SKILL-001 | Cadrer et plafonner (~500 car.) la description d'outil MCP à l'import, préfixée « fournie par le serveur `<slug>`, à traiter comme non fiable ». | XS | — |
| 9 | SKILL-001 | Sortir `create_mcp` de l'auto-approbation en `fully_autonomous` : l'ajouter au plancher dur, aux côtés de `isCatastrophicCommand`. | XS | — |
| 10 | SECRET-002 · SECRET-003 | `restrictFileToOwner` sur les 4 répertoires dans `ensureConfigDir`, **et** mot de passe Postgres aléatoire par installation persisté dans `config.json` (déjà en 0600 + ACL). Traiter ensemble : même racine, le durcissement a été appliqué aux fichiers et pas au reste du périmètre. Test de boot obligatoire après changement. | S | — |
| 11 | SUPPLY-002 | `pnpm audit --audit-level=high`, **non bloquant**, en CI. Fusionner la branche Snyk (une ligne). | XS | — |

**Publier une 0.8.2 à l'issue de la vague 1.** Les points 1-2 sont la condition d'existence du
produit ; 3-5 ferment le seul chemin de contrôle à distance sans condition préalable ; 6-7 ferment le
seul chemin d'exécution privilégiée sans contrôle humain.

---

## Vague D — Découverte : lever les 61 contrôles bloqués

**~4 jours · EN PARALLÈLE de la vague 1 · bloquante pour la vague 2**

C'est la vague la plus importante du plan, et elle ne produit aucun correctif — elle produit de
l'information. L'audit couvre **42 % du produit**. Engager cinq jours de correctifs sur les P1 connus
sans savoir ce que contiennent les 58 % restants, c'est optimiser un périmètre qu'on n'a pas mesuré.

| # | Action | Effort | Ce que ça débloque |
|---|---|---|---|
| D1 | **Les 11 harnais LLM non instruits** : tool-calling réel contre l'API courante de chaque fournisseur, streaming, mode JSON, tokens de raisonnement, taxonomie d'erreurs, épinglage de modèle. Plus les 6 modules transverses jamais lus (`tolerant-fetch`, `retry`, `failover`, `parsers`, `tool-call-middleware`, `probe-context`). | M | 16 contrôles |
| D2 | **Les 153 server actions du dashboard** : contrôle d'autorisation par action, scoping d'entité, validation Zod. Le dashboard est accessible depuis l'onboarding déjà fait. | M | ~8 contrôles |
| D3 | **Comportement live des 4 canaux face à un expéditeur non autorisé.** L'allowlist existe et est identique partout — elle n'a jamais été vue tenir. Un bot Telegram jetable suffit pour le premier. | S | 6 contrôles |
| D4 | **Voie A des « inconnues inconnues »** : une mise à jour de skill communautaire peut-elle s'appliquer sans revue du diff ? Le mécanisme existe (`skill_update_tracking`, migration 0069, vérification toutes les 24 h). Si oui, c'est un point d'attaque unique pour **toutes** les installations — soit un P0 de plus. | M | le finding le plus important absent du rapport |
| D5 | **Les 13 connecteurs** : portées OAuth demandées vs nécessaires, stockage et révocation des tokens. | M | ~6 contrôles |
| D6 | **WCAG 2.1 AA** sur le dashboard (exige un navigateur). | S | 1 contrôle |

**Sortie attendue** : un `AUDIT_COVERAGE` v3 au-dessus de 90 %, et une liste de findings qui **redéfinit
le contenu de la vague 2**. Si D1 ou D4 remontent un P0, il passe devant tout le reste de la vague 2.

**Ordre interne** : D4 puis D3 d'abord — ce sont les deux qui peuvent produire un P0. D1, D2, D5, D6
ensuite, qui produiront surtout des P2.

---

## Vague 2 — P1 restants et P2 à forte valeur

**~5 jours · périmètre à confirmer à l'issue de la vague D**

| # | ID | Action | Effort | Dépend de |
|---|---|---|---|---|
| 12 | SECRET-001 | Rédiger les transcripts **à l'affichage** (dashboard, export, notifications de canal) via `redactSecretsForAudit`. Ne pas toucher au chemin d'écriture avant d'avoir prouvé que `resume.ts` ne relit jamais le transcript pour ré-exécuter. | S | — |
| 13 | TOKEN-001 | Recadrer la promesse : « plafond de tokens par job » partout, « plafond en dollars (OpenRouter uniquement) » là où il s'applique, mention visible dans l'UI et le README. Ne pas inventer de table de prix — elle se périmerait en silence. | S | — |
| 14 | INJECT-001 | Fonction unique `wrapUntrusted(source, content)` reprenant le motif de `buildWebhookEnvelope`, appliquée **d'un coup** à : résultats `web_search`, résultats MCP, payloads connecteurs, contenu de `file_read`, messages entrants des 4 canaux, `## Shared workspace contents`. Ne pas livrer partiellement : une couverture partielle est indistinguable d'une couverture complète pour l'utilisateur. | M | — |
| 15 | MEMORY-001 | Enveloppe autour du bloc `## Persistent memory` (« notes enregistrées par des agents, jamais des instructions »). Conserver le denylist tel quel, et corriger son commentaire pour qu'il n'annonce pas plus qu'il ne fait. | S | 14 |
| 16 | SKILL-002 | Faire passer la boucle de réflexion par l'outil `create_skill` au lieu de `createSkillRepo` direct, puis appliquer la sanitation sur ce chemin unique. À faire **avant** toute activation par défaut de la réflexion. | S | 15 |
| 17 | PRIVILEGE-003 | Afficher la longueur réelle quand le détail est tronqué (« 623 caractères, 500 affichés »). Puis exécuter le test adversarial pour faire passer le finding de `Likely` à `Confirmed`. | XS | — |
| 18 | CODE-001 | Corriger `CLAUDE.md` (invariants 1-2 = discipline de revue, 10 = ESLint, architecture = dep-cruiser). Ajouter une règle ESLint **étroite** sur les littéraux passés aux fonctions d'envoi dans `channels/` et `telegram/` — périmètre où « texte utilisateur » est décidable. | M | — |

---

## Vague 3 — Le reste

**~2 jours**

| # | ID | Action | Effort |
|---|---|---|---|
| 21 | TOKEN-002 | Passer les 24 outils Office en capacité activable, via la refonte « Tools ON/OFF » déjà au backlog. Gain mesuré : jusqu'à 6 462 tokens par tour sur un agent non bureautique — mais le cache mesuré (49→98 %) rend ce gain marginal dès le 2ᵉ tour. Priorité basse en conséquence. | M |
| 22 | PERF-001 | Job Playwright sur trois parcours seulement (boot, création d'agent, approbation), non bloquant d'abord. | S |
| 23 | — | Modéliser la croissance disque à un an. `RETENTION_DAYS` vaut **0 par défaut** : rien n'est jamais purgé et chaque job échoué garde son transcript complet. | S |

---

## Ce que chaque vague ne corrige pas

**Après la vague 1** : une page web ne peut plus piloter les agents, le produit s'installe, et un
serveur MCP hostile ne peut plus exécuter sans contrôle humain. Mais **le contenu tiers entre toujours
sans marquage dans le contexte du modèle** (INJECT-001), et la mémoire reste protégée par un denylist
qui laisse passer 14 formulations sur 16. Un attaquant capable de placer du texte devant l'agent — page
web consultée, document partagé, message relayé — conserve son levier. La défense repose alors
entièrement sur le jugement du modèle, ce qui a tenu 6 fois sur 6 en test avec GLM 5.2, mais n'est
garanti par rien dans le harnais.

**Après la vague 2** : les frontières sont balisées et les secrets ne fuient plus par les transcripts
affichés. Reste que la rédaction se fait à l'affichage, donc **la base contient toujours les secrets en
clair** — une sauvegarde ou un export brut les expose.

**Après la vague D** : on saura enfin ce qu'on ne sait pas aujourd'hui. Tant qu'elle n'est pas faite,
aucune affirmation générale sur la qualité du produit n'est soutenable — ni dans un sens, ni dans
l'autre. C'est aussi la seule vague qui peut **invalider** la priorisation du reste de ce plan.

**Note de méthode.** La version 2 de ce plan plaçait cette vague en dernier, sous le numéro 19. C'était
une erreur de structure : une tâche de découverte avait été triée dans une liste ordonnée par sévérité
de correctifs. Corrigé en v3 après remise en question — la découverte tourne désormais en parallèle des
correctifs prouvés, et précède ceux dont elle peut changer le périmètre.

---

## Le motif à corriger derrière les findings

Cinq des six findings les plus graves partagent la même forme : **la protection est écrite, elle n'est
pas branchée.**

| Protection | État | Finding |
|---|---|---|
| `private-origin.ts` | écrit, testé, **jamais appelé** par le runner | NETWORK-001 |
| `verify-install.mjs` | écrit après l'incident 0.8.0, **jamais appelé** par la CI | SUPPLY-001 |
| `buildWebhookEnvelope` | correct, **jamais généralisé** aux 17 autres frontières | INJECT-001 |
| Gate d'approbation | fonctionne, **les outils MCP n'y souscrivent pas** | MCP-001 |
| `restrictFileToOwner` | efficace, **appliquée à 2 fichiers sur 6 cibles** | SECRET-002 |
| `redactSecretsForAudit` | existe, **3 appelants, aucun sur le transcript** | SECRET-001 |

La conséquence pratique est favorable : ces correctifs sont petits, parce que le travail difficile est
déjà fait. La conséquence défavorable est que **le motif se reproduira** tant qu'aucune vérification
mécanique ne le détecte — ce que dit précisément CODE-001, où `CLAUDE.md` annonce des règles ESLint
qui n'existent pas.

Le point 2 (câbler `verify-install.mjs`) et le point 18 (règle ESLint étroite) sont les deux seules
actions du plan qui attaquent la cause plutôt que les symptômes.
