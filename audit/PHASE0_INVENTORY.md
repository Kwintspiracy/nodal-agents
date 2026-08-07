# Phase 0 — Inventaire et recensement

**Date** : 2026-08-07 · **Cible** : `main` @ `144383f` (2026-07-31) · **Version** : 0.8.1
**Statut** : inventaire terminé, aucune conclusion de sécurité tirée. Toute affirmation ci-dessous
porte sa classe de preuve (`[A]` statique, `[B]` exécuté, `[C]` artefact livré, `[D]` runtime, `[E]` externe).

---

## 1. Bloc §1 confirmé / corrigé

| Élément §1 | Verdict | Réalité constatée |
|---|---|---|
| ~224 000 LOC, 16 packages | **Corrigé** | **228 400 LOC** TS/TSX (hors `node_modules`/`dist`/`.next`), **16 workspaces de premier niveau** + **13 sous-packages** dans `packages/adapters/*` (glob de workspace séparé) → **29 packages publiables au sens pnpm** `[B]` |
| 616 commits | **Corrigé** | `git rev-list --count HEAD` = **613** `[B]` |
| 10 branches | **Corrigé** | **41 refs locales + 9 refs origin**. Dont 15 branches `worktree-*` mortes et `main-pre-rename` `[B]` |
| Dernier commit 2026-07-31 `fix(pack): 0.8.1` | **Confirmé** `[B]` | |
| « deux branches `snyk-fix-*` non mergées » | **FAUX** | Il n'y a qu'**une seule** branche snyk : `origin/snyk-fix-82943d0acf51d50e7569eabcf777bd15`. Voir §3 `[B]` |
| « plusieurs branches feature non mergées (learning-loop, scalable-memory-fts-curator, script-execution-lot, pack-chunk-integrity, onboarding, npm-docker) » | **Largement FAUX** | `git branch -a --no-merged main` ne retourne que **6 refs** : `feat/agents-grid-hierarchy-rebuild`, `feat/jobs-run-step-timeline`, `wip/onboarding` (×2), `worktree-runner-turn-cap-tool-result-bound`, `origin/snyk-fix-*`. `learning-loop`, `scalable-memory-fts-curator`, `script-execution-lot`, `pack-chunk-integrity` et `npm-docker` sont **déjà dans `main`** `[B]` |
| apps/web 60 075 LOC | **Corrigé** | 64 357 `[B]` |
| apps/runner 57 987 | **Confirmé (57 880)** `[B]` | |
| packages/catalog « 21 skills » | **Corrigé** | **20 skills** (`packages/catalog/src/skills/*.ts` moins `no-hardcoded-user.test.ts`) `[B]` |
| packages/secrets 306 LOC « un seul fichier » | **Confirmé** | `src/index.ts` = 138 lignes ; les 306 incluent `src/tests/index.test.ts` `[B]` |
| Bind runner `0.0.0.0` par défaut | **FAUX (défaut)** | `BIND: z.string().default('127.0.0.1')` (`apps/runner/src/env.ts:48`). `0.0.0.0` **uniquement** si `config.bind === 'lan'` (`apps/cli/src/lib/env.ts:12`) `[A]` — reste à vérifier en `[B]` sur socket réel |
| Postgres embarqué « port libre » | **Confirmé** `[A]` | `apps/cli/src/lib/ports.ts` ; prédictibilité non encore mesurée |
| Repo public | **Non vérifié** | Pas encore contrôlé côté GitHub. À faire en Phase 1 |

### Décomptes exacts

```
LOC TS/TSX (hors node_modules, dist, .next)
  apps/web              64 357      packages/orchestration   8 143
  apps/runner           57 880      packages/llm             8 406
  packages/adapters     32 071      packages/shared          6 326
  packages/tools        23 575      packages/delivery        6 007
  packages/db            8 832      packages/memory          4 691
  apps/cli               3 682      packages/catalog         2 138
  apps/docs                877      packages/auth            1 103
  packages/secrets         306      packages/runner-adapters   283
                                    ─────────────────────────────
                                    TOTAL                  228 400

Tables Postgres (recensées dans packages/db/migrations/*.sql) : 41
Migrations SQL : 72 (dernière : 0072_connectors_entity_slug_unique.sql)
Fichiers de test unitaires : 385   ·   Specs Playwright : 85
Adapters/connecteurs : 13
Harnais LLM : 12 providers + 6 fichiers transverses
Skills système : 20
Tools agent déclarés : 69 noms uniques
Server actions dashboard : 153 fonctions (dont 135 dans apps/web/src/lib/actions.ts)
Routes HTTP runner : 12   ·   Routes API Next : 4
```

---

## 2. Recensement des surfaces

### 2.1 Surface HTTP — runner (`:3001` par défaut)

Source : `apps/runner/src/server.ts:149-188` `[A]`

| Route | Méthode | Gate `requireRunnerAuth` | Auth en mode par défaut (`local-trust`) |
|---|---|---|---|
| `/api/health` | GET | **non** | aucune (public assumé) |
| `/api/agent` | POST | oui | **aucune** — `local-trust` traverse sans contrôle |
| `/api/chat` | POST | oui | **aucune** |
| `/api/approve` | POST | oui | **aucune** |
| `/api/cron` | POST | oui | **aucune** |
| `/api/whatsapp/pairing` | GET+POST | oui | **aucune** |
| `/api/worker` | POST | **non** | contrôle `WORKER_SECRET` interne au handler — à vérifier `[B]` |
| `/api/skills/install` | POST | **non** | contrôle interne annoncé — à vérifier `[B]` |
| `/api/skills/uninstall` | POST | **non** | idem |
| `/api/skills/update` | POST | **non** | idem |
| `/api/skills/acknowledge-update` | POST | **non** | idem |
| `/webhooks/:slug/:secret` | POST | **non, délibérément** | secret dans le path, vérifié contre `webhook_triggers` |

Mécanique du gate (`server.ts:102-147`) :
- `AUTH_MODE=local-trust` (**défaut**, `env.ts:40`) → `callerTrusted=true`, passe **inconditionnellement**.
- sinon → `Authorization: Bearer <WORKER_SECRET>` comparé par `isValidWorkerSecret`.
- `bearer-token` → accepte en plus une session `authProvider` avec `entityId` non vide.

Le commentaire du code est explicite et honnête (`server.ts:75-79`) : *« this mode does NOT change the
network bind — main() always binds to runnerEnv.BIND (0.0.0.0 in LAN mode) in every mode »*. La
combinaison `bind=lan` + `local-trust` est donc, par construction, **runner entièrement ouvert au LAN**.
`apps/cli/src/lib/env.ts:56-82` montre qu'un garde-fou existe pour ce cas — **son efficacité réelle est à
tester en Phase 4 `[B]`**, pas à présumer.

Aucun middleware CORS, `Origin`, `Host` ou CSRF n'apparaît dans `server.ts`. `packages/auth/src/lib/private-origin.ts`
(32 lignes) existe mais **n'est pas importé par `server.ts`** — point à instruire en priorité Phase 4.

### 2.2 Surface HTTP — dashboard (`:3000`)

- 4 routes Next : `api/auth/[...all]`, `api/health`, `api/oauth/[provider]/start`, `api/oauth/[provider]/callback`.
- **153 server actions** (`'use server'`), dont 135 dans le seul `apps/web/src/lib/actions.ts`. C'est
  la vraie surface d'attaque du dashboard : chaque action est un endpoint POST invocable.
- Next lie `0.0.0.0` en toutes circonstances (`apps/cli/src/commands/up.ts:257`, commentaire du code) `[A]`.

### 2.3 Tools agent — 69 noms

| Famille | Tools | Nature |
|---|---|---|
| Exécution | `run_command`, `run_skill_script` | **exécution shell / script** |
| Fichiers | `file_read`, `file_write`, `file_edit`, `file_list`, `file_search` | lecture + écriture disque |
| Méta (auto-extension) | `create_agent`, `update_agent`, `agent_model`, `create_skill`, `update_skill`, `assign_skill`, `attach_skill`, `detach_skill`, `create_connector`, `attach_connector`, `detach_connector`, `create_mcp`, `attach_mcp`, `detach_mcp`, `attach_agent`, `detach_agent` | **modifie la plateforme elle-même** |
| Planification | `create_schedule`, `update_schedule`, `toggle_schedule`, `run_schedule`, `list_schedules` | exécution différée non surveillée |
| Mémoire | `save_memory`, `query_memory`, `mark_memory_helpful`, `mark_memory_outdated` | **persistance inter-jobs** |
| Communication | `telegram_send_message`, `send_file`, `send_image`, `send_video`, `send_audio`, `send_voice` | **sortie réseau vers tiers** |
| Skills (fichiers) | `skill_file_read`, `skill_file_write`, `skill_file_list`, `skill_view` | **écriture de contenu réinjecté en prompt** |
| Office | 22 tools `docx_*` / `pptx_*` / `xlsx_*` | écriture disque |
| Divers | `web_search`, `search_history`, `list_conversations`, `list_models`, `dashboard_publish`, `return_result` | lecture / réseau sortant |

Modèle de gating (`packages/tools/src/types.ts:296-335`) `[A]` :
`RiskLevel ∈ {read, write, destructive}` × `ApprovalRule.action ∈ {auto_approve, require_approval, block}`
× `autonomy ∈ {propose_confirm, destructive_gate, fully_autonomous}`.
En `fully_autonomous` → **auto-approbation de tout**, sauf un « plancher dur » pour les commandes
catastrophiques (`isDestructiveOrHeavyCommand`). Ce plancher est le seul rempart en autonomie maximale :
**à tester en Phase 2 `[B]`**.

---

## 3. Analyse des branches — que les utilisateurs n'ont PAS

`main` = `origin/main` = `144383f`. C'est ce qui est packé.

| Branche non mergée | Contenu réel | Pertinence sécurité |
|---|---|---|
| `origin/snyk-fix-82943d0acf51d50e7569eabcf777bd15` | **1 commit, 1 ligne** : `@mendable/firecrawl-js` `^4.22.0` → `^4.25.2` dans `packages/adapters/firecrawl/package.json` `[B]` | **À instruire.** Le `package.json` de `main` porte toujours `^4.22.0`, mais le **lockfile épingle `4.22.2`** (`pnpm-lock.yaml:388`) et CI installe en `--frozen-lockfile`. Le caret autoriserait 4.25.2, mais le lock l'empêche → **le correctif n'est PAS appliqué en pratique**. Le runner étant bundlé esbuild, cette version part **dans le tarball**. CVE et sévérité non encore identifiées → Phase 1 |
| `origin/wip/onboarding` (= local `wip/onboarding`) | 2 fichiers, +890 lignes, UI d'onboarding uniquement `[B]` | aucune |
| `feat/agents-grid-hierarchy-rebuild`, `feat/jobs-run-step-timeline`, `worktree-runner-turn-cap-tool-result-bound` | branches locales anciennes (mai 2026) | à qualifier Phase 1 |

**Correction importante** : contrairement à l'hypothèse §1, `feat/learning-loop`,
`feat/scalable-memory-fts-curator`, `feat/script-execution-lot`, `fix/pack-chunk-integrity` et
`worktree-brique-distribution-npm-docker` sont **déjà fusionnées dans `main`**. La learning-loop et le
curator mémoire sont donc **du code livré**, pas du futur — ils entrent dans le périmètre d'audit
au même titre que le reste. C'est un élargissement notable du périmètre Phase 9.

**Tags** : le dernier tag est `v0.7.95`. **Ni `v0.8.0` ni `v0.8.1` n'existent** `[B]` — l'artefact publié
sur npm n'est rattaché à aucun point immuable du dépôt. Conséquence directe : on ne peut pas prouver
par git ce qui a été publié en 0.8.0. Cela pèse sur le protocole §3.2.

---

## 4. Carte des frontières de confiance

**C'est l'artefact le plus important de la Phase 0.** Chaque ligne est un endroit où du contenu
qu'un tiers contrôle entre dans le contexte d'un LLM qui dispose de `run_command`, `file_write` et
des tools méta.

Statut = ce qui est **établi** aujourd'hui, pas ce qui est supposé. Aucun test d'injection n'a encore
été exécuté.

| # | Point d'entrée | Auteur du contenu | Chemin code identifié | Contrôle d'entrée constaté | Statut |
|---|---|---|---|---|---|
| TB-01 | `web_search` (résultats web) | n'importe qui sur Internet | `packages/tools/src/builtin/web-search.ts` (backends Tavily / Firecrawl / gratuit) | aucun repéré à ce stade | **À TESTER** |
| TB-02 | Firecrawl / Apify (scraping page) | n'importe qui | `packages/adapters/firecrawl`, `packages/adapters/apify` | — | **À TESTER** |
| TB-03 | Telegram entrant | expéditeur du message | `apps/runner/src/telegram/poller.ts`, `handler.ts` | **allowlist** `telegram_allowed_chats` + `channel_allowed_conversations`, avec statut `pending`/`active` et confirmation propriétaire `[A]` | **À TESTER** (contournement) |
| TB-04 | Discord entrant | expéditeur | `apps/runner/src/channels/discord/gateway.ts` | `channel_bindings` + `channel_allowed_conversations` | **À TESTER** |
| TB-05 | Slack entrant | expéditeur | `apps/runner/src/channels/slack/socket.ts` | idem | **À TESTER** |
| TB-06 | WhatsApp entrant | expéditeur | `apps/runner/src/channels/whatsapp/` | idem | **À TESTER** |
| TB-07 | Email | **n'importe qui, sans invitation** | `packages/adapters/gmail`, `packages/adapters/outlook-mail`, `packages/delivery/src/channels/email` | inconnu — entrant vs sortant à établir | **À TESTER — priorité haute** |
| TB-08 | Réponses d'outils MCP | opérateur du serveur MCP tiers | `packages/adapters/mcp/{client,tools}.ts` | — | **À TESTER** |
| TB-09 | **Descriptions** d'outils MCP | opérateur du serveur MCP tiers | `packages/adapters/mcp/tools.ts`, `json-schema-to-zod.ts` | — | **À TESTER — vecteur de pilotage direct** |
| TB-10 | Payloads connecteurs (Notion, Drive, Docs, Sheets, Calendar, Airtable, Poyo) | auteurs tiers des documents | `packages/adapters/*` | — | **À TESTER** |
| TB-11 | `file_read` / `read_lines` | quiconque a écrit le fichier | `packages/tools/src/builtin/file-ops/file-read.ts` | `workspace.ts` (confinement) | **À TESTER** |
| TB-12 | **Faits mémoire** réinjectés | *un agent précédemment injecté* | `packages/memory/src/inject.ts`, `sanitize.ts`, `filter.ts` ; bloc `## Persistent memory` (`system-prompt.ts:249`) | `sanitize.ts` existe — efficacité inconnue | **À TESTER — vecteur de persistance** |
| TB-13 | **Skills apprises** (learning loop) | *un agent précédemment injecté* | `apps/runner/src/reflection/run-reflection.ts`, `packages/tools/src/builtin/meta-ops/create-skill.ts`, `lint-skill-content.ts` | `lint-skill-content` — annoncé **advisory (warn, jamais bloquant)** (`types.ts:153`) `[A]` | **À TESTER — vecteur de persistance, code déjà livré** |
| TB-14 | Webhooks entrants | quiconque connaît slug+secret | `apps/runner/src/routes/webhook.ts` | slug+secret dans l'URL | **À TESTER** |
| TB-15 | `search_history` (historique) | contenu antérieurement injecté | `packages/memory/src/search.ts` | — | **À TESTER** |
| TB-16 | Contenu de fichiers de skill | agent via `skill_file_write` | `packages/tools/src/builtin/skill-ops/skill-files.ts` | — | **À TESTER** |
| TB-17 | Notes d'installation opérateur | opérateur (semi-confiance) | `system-prompt.ts:186` `### Install notes (from the operator)` | — | faible risque, à noter |
| TB-18 | Inventaire de workspace partagé | fichiers déposés par un tiers | `system-prompt.ts:622` `## Shared workspace contents` | — | **À TESTER** |

**18 frontières identifiées. Zéro testée à ce stade.** Aucune conclusion — favorable ou défavorable —
ne sera émise avant exécution.

---

## 5. Carte des privilèges

```
NIVEAU 0 — appelant HTTP
  local-trust (DÉFAUT)  → confiance totale, corps de requête pris tel quel
  local-auth            → WORKER_SECRET bearer obligatoire
  bearer-token          → WORKER_SECRET OU session authProvider avec entityId

NIVEAU 1 — autonomie du ROOT de workspace (ExecuteOptions.autonomy)
  propose_confirm (défaut/undefined) → chaque tool gaté demande
  destructive_gate                   → auto-approbation du travail ordinaire,
                                        gate conservé sur `destructive` +
                                        isDestructiveOrHeavyCommand()
  fully_autonomous                   → AUTO-APPROBATION DE TOUT,
                                        seul le plancher « commande
                                        catastrophique » subsiste

NIVEAU 2 — règles d'approbation en base (approval_rules)
  auto_approve | require_approval | block, portées agentId / entityId
  Une règle explicite `require_approval` l'emporte sur l'autonomie.

NIVEAU 3 — whitelist de tools par agent
  packages/tools/src/whitelist.ts (66 lignes) — calculée par job (invariant #9)

NIVEAU 4 — auto-extension (ROOT)
  create_agent / create_skill / create_connector / create_mcp / create_schedule
  → un agent peut fabriquer un agent, une skill, un serveur MCP ou une
    tâche planifiée. C'est le point où une injection ponctuelle devient
    une capacité permanente.

GARDES ANTI-BOUCLE (packages/orchestration/src/chain-counters.ts)
  max 15 chaînes · max 50 tool calls/tour · profondeur délégation 3
  + failed_delegations_count
```

**Questions ouvertes du modèle de privilèges**, toutes à instruire en Phase 2 :
1. Un sous-agent délégué peut-il détenir des tools que le délégant n'a pas ? (blanchiment de privilège)
2. `create_agent` peut-il produire un agent au périmètre plus large que son créateur ?
3. `create_mcp` peut-il pointer vers une URL arbitraire, en `fully_autonomous`, sans humain ?
4. Le plancher `isDestructiveOrHeavyCommand` couvre-t-il l'exfiltration (`curl -d @secrets.key`) ou
   seulement la destruction ?

---

## 6. Carte des coûts en tokens (contributeurs identifiés, **non mesurés**)

Source : `packages/orchestration/src/system-prompt.ts` (632 lignes) `[A]`.
Aucun chiffre. Toute quantification arrive en Phase 5, par mesure.

| Bloc | Provenance | Volatilité | Ligne |
|---|---|---|---|
| baseline agent | `buildBaselineBlock(agent.model, {role})` | stable | 562 |
| `## Your team` | DB (vide pour les workers) | stable | 347 |
| `## Skills (load before acting)` | DB | stable | 502-504 |
| `## Built-in capabilities` | code (absent en surface `chat`) | stable | 266, 537 |
| `## Workspace(s)` | DB | stable | 275, 541 |
| `## Messaging channels` | DB | stable | 328, 563 |
| bloc discoverability | code | stable | 567 |
| `## Delegated sub-task` | contexte de job | semi | 585 |
| `## Runtime` | déploiement (OS, réseau, install notes) | **volatile** | 140, 527 |
| `## Persistent memory` | **mémoire injectée** | **volatile** | 249, 551 |
| `## Job context` | contexte de job | **volatile** | 194, 556 |
| `## Shared workspace contents` | inventaire workspace | **volatile** | 622 |
| schémas d'outils | whitelist par agent | stable | `whitelist.ts` |
| historique conversation | DB | volatile | à localiser |
| round-trip raisonnement | provider | volatile | Phase 6 |

**Signal favorable à vérifier** : `system-prompt.ts:629` isole explicitement
`const volatile = runtimeBlock + memoryBlock + jobContextBlock + inventoryBlock;`
— la séparation stable/volatile nécessaire au cache de prompt **existe dans l'intention**.
Reste à établir en Phase 5 `[B]/[D]` : que le préfixe stable précède bien le volatile, que le
breakpoint de cache est posé au bon endroit, et que le taux de hit réel le confirme côté provider.

---

## 7. Ce que la CI applique réellement

`.github/workflows/ci.yml` (76 lignes), déclenché sur push et PR vers `main`, `permissions: contents: read` `[A]`.

| Étape | Présente | Constat |
|---|---|---|
| `pnpm install --frozen-lockfile` | oui | conforme |
| `typecheck`, `lint`, `format:check` | oui | |
| `secrets:check` | oui | `scripts/check-no-secrets.mjs` (115 l.) — **efficacité non testée** |
| `deps:check` | oui | **exécuté `[B]` : 0 erreur, 26 avertissements** ; 6 règles `error` (`no-circular`, `apps-cant-import-other-apps`, `packages-cant-import-apps`, `only-db-imports-pg`, `adapters-only-import-tools-shared`, `no-runner-delivery-direct`) — celles-ci bloquent bien |
| tests unitaires (`turbo run test --concurrency=3`) | oui | |
| `test:scripts` | oui | ajouté après l'incident 0.8.0 |
| `build` | oui | ajouté après audit |
| **Playwright / e2e** | **NON** | 85 specs existent, **aucune n'est exécutée en CI** `[A]` |
| **audit de vulnérabilités de dépendances** | **NON** | aucun `pnpm audit`, aucun Dependabot/Snyk dans le workflow |
| **test du tarball packé** | **NON** | `scripts/verify-install.mjs` existe (128 l.) mais **n'est appelé dans aucune étape CI** |

**Écart documentaire relevé** `[A]`, à confirmer `[B]` en Phase 1 :
`CLAUDE.md` affirme *« Architecture — dep-cruiser + ESLint custom rules (invariants 1-2 enforced) »*.
Or il n'existe que deux configs ESLint — `eslint.config.js` racine (37 lignes : `no-explicit-any`,
`no-unused-vars`, `consistent-type-imports`, `no-console`) et `apps/web/eslint.config.mjs`
(`no-restricted-globals` / `-properties` / `-syntax`, qui applique bien l'invariant #10).
**Aucune règle personnalisée n'applique les invariants #1 (pas de métadonnées d'agent en dur) ni
#2 (pas de texte utilisateur en dur dans le runner).** Ces deux invariants — les plus structurants du
projet — reposent aujourd'hui sur la discipline, pas sur la machine.

Actions GitHub épinglées sur des tags majeurs (`actions/checkout@v5`, `pnpm/action-setup@v4`,
`actions/setup-node@v5`) et non sur des SHA → à qualifier en Phase 1.

---

## 8. Inventaire des secrets

| Secret | Emplacement | Protection constatée |
|---|---|---|
| Clé maître AES-256 | `~/.nodalai/secrets.key`, base64, **32 octets aléatoires** | `chmod 0600` POSIX + `icacls /inheritance:r /grant:r <user>:F` sur Windows, **best-effort** (`packages/secrets/src/index.ts:21-35`) `[A]` |
| Clés API LLM | `entity_llm_keys.api_key`, format `enc:v1:{iv}:{tag}:{ct}` | AES-256-GCM, IV aléatoire 12 o. par chiffrement `[A]` |
| `WORKER_SECRET` | env du runner | comparaison via `isValidWorkerSecret` — usage de `constant-time.ts` à vérifier `[B]` |
| `BEARER_TOKEN` | env | — |
| Credentials connecteurs / OAuth | table `credentials` | chiffrement à vérifier |
| Tokens bots (Telegram/Discord/Slack) | `channel_bindings` | à vérifier |
| **Session WhatsApp** | store Baileys | **session de compte complète, pas un token scopé** |
| Secrets de webhook | `webhook_triggers` | comparaison à vérifier |

**Note factuelle sans jugement** : la clé maître est un fichier posé **à côté** des données qu'elle
protège, avec les mêmes droits. Ce que ce chiffrement défend précisément (dump SQL, sauvegarde, copie
de la base — mais pas une lecture du système de fichiers) sera énoncé explicitement en Phase 3, pas
présumé ici.

---

## 9. Hypothèses de travail

1. La cible d'audit est `main` @ `144383f`. Une branche non mergée n'est jamais créditée d'un correctif.
2. La configuration par défaut est celle d'un `npm i -g nodal-agents && nodal-agents up` sans réglage :
   `AUTH_MODE=local-trust`, `BIND=127.0.0.1`, `autonomy` non relaxée, réflexion OFF, curation mémoire ON.
3. `pack/nodal-agents-0.8.1.tgz` présent dans l'arbre est **présumé** correspondre à `main` ; à vérifier
   par diff en Phase 1 avant tout usage comme preuve de classe `[C]`.
4. Tous les tests seront menés sur une installation jetable, jamais sur l'instance de travail.
5. Le mode LAN sans auth est une **décision produit assumée** ; l'audit établira son coût réel, pas son
   existence.

---

## 10. Questions ouvertes (blocantes ou coûteuses)

| # | Question | Pourquoi elle bloque | Ce dont j'ai besoin |
|---|---|---|---|
| Q1 | Puis-je installer et lancer une instance jetable de Nodal-Agents (Postgres embarqué, ports libres) ? | Sans elle, aucune preuve `[B]`/`[C]` — donc **aucune conclusion sécurité ne dépasse `Unverified`** | ton go |
| Q2 | Puis-je consommer des tokens réels sur tes clés provider pour les mesures Phase 5 et 6 ? Sur quel provider, avec quel plafond ? | Les mesures de tokens/cache/coût doivent être réelles (§3.3) | provider + budget acceptable |
| Q3 | Le dépôt GitHub est-il public à cet instant ? | Change la sévérité de tout le volet supply-chain | confirmation |
| Q4 | Le canal email est-il **entrant** (l'agent lit une boîte) ou seulement sortant ? | Un email entrant est la frontière la plus exposée du produit | je peux le déterminer seul en Phase 2, mais ta réponse me fait gagner du temps |
| Q5 | Puis-je créer un serveur MCP local factice et un bot Telegram de test pour les tests d'injection ? | Nécessaire pour TB-03 et TB-08/09 | go + éventuel token de test |
| Q6 | La learning loop et le curator mémoire étant **déjà dans `main`**, dois-je les auditer au même niveau que le reste ? | §14 les traitait comme du pré-merge ; ils sont livrés | oui/non |

---

## 11. Ce qui a été réellement exécuté en Phase 0

| Commande | Classe | Résultat |
|---|---|---|
| `git rev-list --count HEAD`, `git branch -a`, `git tag` | B | 613 commits, 50 refs, dernier tag `v0.7.95` |
| `git diff origin/main...origin/snyk-fix-*` | B | 1 fichier, 1 ligne |
| `git branch -a --no-merged main` | B | 6 refs |
| `pnpm deps:check` | B | 0 erreur / 26 warnings, 1637 modules, 5623 dépendances |
| comptage LOC, tests, tables, migrations, tools, skills | B | cf. §1 |
| lecture intégrale `server.ts`, `env.ts`, `secrets/index.ts`, `eslint.config.js`, `ci.yml` | A | cf. §2, §7, §8 |

Rien d'autre. **Aucune conclusion de sécurité n'est tirée à ce stade** — c'est un inventaire.
