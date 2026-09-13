# Audit des tests qui se chevauchent

_Mesure du 2026-09-12. Rejouable : `node scripts/audit-tests-chevauchement.mjs`._

**Aucun test n’a été modifié pour produire ce rapport.**

## Ce que la mesure dit

Le chevauchement existe — 1108 cas sur 6997 sont dans un groupe — mais **il ne coûte quasiment rien**. Tout fusionner rendrait **4.1 s** sur les **1428.7 s** que l’exécution des corps de test représente au total, soit **0.29 %**. Les 19,5 minutes médianes d’une PR ne viennent pas de là.

Et la part qui reste se divise en deux, très inégalement. Les groupes dont les membres vivent **dans le même fichier** (320 groupes, 2.1 s) sont de vrais candidats à la fusion. Ceux qui s’étalent **sur plusieurs fichiers** (74 groupes, 2.0 s) sont presque toujours le même scénario joué contre des modules différents — les 28 `architecture.test.ts`, les trois handlers de canal — et là, fusionner supprimerait de la protection. La vérification à la main du § « Ce que valent ces groupes » le montre sur cinq cas.

## Les chiffres

| | |
|---|---|
| Fichiers de test parcourus | 588 |
| Cas extraits (`it` / `test`) | 6997 |
| Cas dont la durée est connue | 6678 |
| Temps d’exécution de tous les cas mesurés | 1428.7 s |
| Groupes **certains** | 278 |
| Cas dans un groupe certain | 830 |
| Groupes **probables** | 116 |
| Cas dans un groupe probable | 278 |
| Groupes internes à un seul fichier | 320 |
| Groupes étalés sur plusieurs fichiers | 74 |
| Temps récupérable, groupes certains | 2.6 s |
| Temps récupérable, groupes probables | 1.5 s |
| Temps récupérable, groupes d’un seul fichier | 2.1 s |
| Temps récupérable, total | **4.1 s** (0.29 %) |

Source des durées : `apps/qa/data/tests.ndjson`. C’est la mémoire test par test du portail qualité, alimentée par le `--reporter=json` de `qa.yml`. Aucune suite n’a été relancée pour ce rapport.

## Par fichier

| Fichier | Cas | Certains | Probables | Temps récupérable |
|---|---:|---:|---:|---:|
| `apps/runner/src/tests/channels/slack/manager.test.ts` | 8 | 0 | 2 | 1.2 s |
| `apps/web/src/lib/__tests__/internal-tool-toggles.test.ts` | 7 | 1 | 0 | 798 ms |
| `apps/runner/src/tests/channels/slack/handler.test.ts` | 17 | 8 | 0 | 215 ms |
| `apps/runner/src/tests/channels/whatsapp/handler.test.ts` | 18 | 8 | 0 | 178 ms |
| `packages/orchestration/src/tests/planner/completion.test.ts` | 6 | 5 | 0 | 84 ms |
| `packages/tools/src/builtin/office-ops/xlsx.test.ts` | 53 | 4 | 2 | 74 ms |
| `apps/runner/src/tests/channels/discord/handler.test.ts` | 17 | 8 | 0 | 73 ms |
| `packages/orchestration/src/tests/system-prompt.test.ts` | 37 | 4 | 0 | 60 ms |
| `apps/web/tests/code-processes-actions.test.ts` | 32 | 2 | 0 | 60 ms |
| `packages/db/src/tests/architecture.test.ts` | 3 | 3 | 0 | 54 ms |
| `packages/delivery/src/tests/whatsapp-socket-manager.test.ts` | 22 | 2 | 0 | 51 ms |
| `packages/tools/src/tests/execute.test.ts` | 72 | 19 | 0 | 48 ms |
| `packages/shared/src/tests/architecture.test.ts` | 5 | 4 | 0 | 48 ms |
| `packages/llm/src/tests/architecture.test.ts` | 4 | 4 | 0 | 42 ms |
| `packages/orchestration/src/tests/architecture.test.ts` | 2 | 2 | 0 | 41 ms |
| `apps/runner/src/tests/lib/mcp-provenance.test.ts` | 7 | 2 | 4 | 40 ms |
| `packages/auth/src/tests/architecture.test.ts` | 4 | 4 | 0 | 33 ms |
| `packages/adapters/google-drive/src/tests/architecture.test.ts` | 7 | 7 | 0 | 33 ms |
| `apps/runner/src/tests/telegram/handler.test.ts` | 49 | 5 | 0 | 30 ms |
| `packages/adapters/gmail/src/tests/architecture.test.ts` | 7 | 7 | 0 | 29 ms |
| `packages/adapters/google-docs/src/tests/architecture.test.ts` | 7 | 7 | 0 | 28 ms |
| `apps/runner/src/tests/architecture.test.ts` | 9 | 0 | 1 | 28 ms |
| `packages/delivery/src/tests/architecture.test.ts` | 4 | 4 | 0 | 27 ms |
| `packages/adapters/google-sheets/src/tests/architecture.test.ts` | 7 | 7 | 0 | 27 ms |
| `packages/catalog/src/tests/architecture.test.ts` | 3 | 3 | 0 | 26 ms |
| `packages/memory/src/tests/architecture.test.ts` | 4 | 4 | 0 | 26 ms |
| `packages/adapters/outlook-mail/src/tests/architecture.test.ts` | 6 | 5 | 0 | 25 ms |
| `packages/tools/src/builtin/meta-ops/meta-ops.test.ts` | 39 | 6 | 0 | 25 ms |
| `apps/cli/src/tests/architecture.test.ts` | 3 | 3 | 0 | 24 ms |
| `packages/orchestration/src/tests/planner/task-tools.test.ts` | 16 | 0 | 2 | 23 ms |
| `apps/runner/src/tests/routes/skills-lifecycle.test.ts` | 13 | 0 | 6 | 20 ms |
| `packages/adapters/notion/src/tests/architecture.test.ts` | 5 | 5 | 0 | 20 ms |
| `packages/orchestration/src/tests/workspace-git-block.test.ts` | 6 | 0 | 2 | 19 ms |
| `packages/db/src/tests/constraints.test.ts` | 62 | 6 | 4 | 19 ms |
| `apps/web/src/components/__tests__/Markdown.test.tsx` | 23 | 14 | 0 | 17 ms |
| `apps/web/tests/actions.test.ts` | 344 | 37 | 4 | 16 ms |
| `apps/runner/src/tests/telegram/auth-callback.test.ts` | 9 | 0 | 2 | 16 ms |
| `packages/orchestration/src/tests/router/tool-availability.test.ts` | 10 | 2 | 2 | 14 ms |
| `packages/adapters/mcp/src/tests/architecture.test.ts` | 3 | 3 | 0 | 14 ms |
| `packages/adapters/apify/src/tests/architecture.test.ts` | 4 | 4 | 0 | 14 ms |
| … et 219 autres fichiers | | | | |

## Les vingt groupes les plus coûteux

Triés par le temps de CI qu’une fusion rendrait. Pour chaque groupe : ce que les cas exercent, et ce que la fusion donnerait.

### 1. 2 cas — probable — un seul fichier — 1.2 s récupérables

**Fichier :** `apps/runner/src/tests/channels/slack/manager.test.ts`

| Ligne | Titre | Durée |
|---:|---|---:|
| 193 | skips a binding with no usable botToken credential | 1.2 s |
| 214 | skips a binding with no usable appToken credential | 1.2 s |

**Ce qu’ils exercent :** async, db.insert, values, JSON.stringify, makeFakeSocketFactory, startSlackManager, makeDeps, manager.refreshNow, ….
**Assertions :** .toBe, .not.toHaveBeenCalled.
**Ce qui varie :** littéral #2 (`xapp-1` / `xoxb-1`).
**Fusion :** à relire : la différence restante est soit du bruit, soit toute la valeur du test.

### 2. 2 cas — certain — plusieurs fichiers — 798 ms récupérables

**Fichiers :** `apps/web/src/lib/__tests__/approval-rule-scope.test.ts`, `apps/web/src/lib/__tests__/internal-tool-toggles.test.ts`

| Ligne | Titre | Durée |
|---:|---|---:|
| 62 | writes an agent-scoped row for a per-server MCP grant | 4.5 s |
| 102 | blocks web_search for one agent, and the row proves it | 798 ms |

**Ce qu’ils exercent :** async, import, setAgentApprovalRuleAction, expect, toBe, rulesFor, expect, toHaveLength, ….
**Assertions :** .toBe, .toHaveLength, .toBe, .toBe.
**Ce qui varie :** littéral #2 (`cogni_cortex__*` / `web_search`) ; littéral #3 (`auto_approve` / `block`) ; littéral #4 (`cogni_cortex__*` / `web_search`).
**Fusion :** un `test.each` de 2 lignes, une ligne par variante — mécanique, sans perte.

### 3. 25 cas — certain — plusieurs fichiers — 327 ms récupérables

**Fichiers :** `apps/cli/src/tests/architecture.test.ts`, `apps/web/src/tests/architecture.test.ts`, `packages/adapters/airtable/src/tests/architecture.test.ts`, `packages/adapters/apify/src/tests/architecture.test.ts`, `packages/adapters/cloudflare/src/tests/architecture.test.ts`, `packages/adapters/firecrawl/src/tests/architecture.test.ts`, `packages/adapters/gmail/src/tests/architecture.test.ts`, `packages/adapters/google-calendar/src/tests/architecture.test.ts`, `packages/adapters/google-docs/src/tests/architecture.test.ts`, `packages/adapters/google-drive/src/tests/architecture.test.ts`, `packages/adapters/google-sheets/src/tests/architecture.test.ts`, `packages/adapters/mcp/src/tests/architecture.test.ts`, `packages/adapters/notion/src/tests/architecture.test.ts`, `packages/adapters/outlook-mail/src/tests/architecture.test.ts`, `packages/adapters/poyo/src/tests/architecture.test.ts`, `packages/adapters/tavily/src/tests/architecture.test.ts`, `packages/auth/src/tests/architecture.test.ts`, `packages/catalog/src/tests/architecture.test.ts`, `packages/db/src/tests/architecture.test.ts`, `packages/delivery/src/tests/architecture.test.ts`, `packages/llm/src/tests/architecture.test.ts`, `packages/memory/src/tests/architecture.test.ts`, `packages/runner-adapters/src/tests/architecture.test.ts`, `packages/secrets/src/tests/architecture.test.ts`, `packages/shared/src/tests/architecture.test.ts`

| Ligne | Titre | Durée |
|---:|---|---:|
| 23 | no agent or server slug hardcoded in source (invariant #1) | 355 ms |
| 21 | no agent or server slug hardcoded in source (invariant #1) | 41 ms |
| 22 | no agent or server slug hardcoded in source (invariant #1) | 28 ms |
| 23 | no agent or server slug hardcoded in source (invariant #1) | 28 ms |
| 22 | no agent or server slug hardcoded in source (invariant #1) | 21 ms |
| 21 | no agent or server slug hardcoded in source (invariant #1) | 18 ms |
| 21 | no agent or server slug hardcoded in source (invariant #1) | 18 ms |
| 22 | no agent or server slug hardcoded in source (invariant #1) | 17 ms |
| 39 | no agent slugs hardcoded in source files | 16 ms |
| 39 | no agent slugs hardcoded in source files | 15 ms |
| 22 | no agent or server slug hardcoded in source (invariant #1) | 14 ms |
| 39 | no agent slugs hardcoded in source files | 14 ms |
| 39 | no agent slugs hardcoded in source files | 13 ms |
| 39 | no agent slugs hardcoded in source files | 12 ms |
| 38 | no agent slugs hardcoded in source files | 10 ms |
| 37 | no agent slugs hardcoded in source files | 10 ms |
| 38 | no agent slugs hardcoded in source files | 9 ms |
| 37 | no agent slugs hardcoded in source files | 7 ms |
| 38 | no agent slugs hardcoded in source files | 7 ms |
| 38 | no agent slugs hardcoded in source files | 6 ms |
| 25 | no agent slugs hardcoded in source files | 6 ms |
| 38 | no agent slugs hardcoded in source files | 6 ms |
| 38 | no agent slugs hardcoded in source files | 5 ms |
| 22 | no agent or server slug hardcoded in source (invariant #1) | 4 ms |
| 22 | no agent or server slug hardcoded in source (invariant #1) | 3 ms |

**Ce qu’ils exercent :** assertNoViolations, scanForAgentSlugs.
**Assertions :** (aucune).
**Ce qui varie :** littéral #1 (`slugs d\u2019agent` / `slugs d’agent`).
**Fusion :** un `test.each` de 25 lignes, une ligne par variante — mécanique, sans perte.

### 4. 25 cas — certain, copies pures — plusieurs fichiers — 89 ms récupérables

**Fichiers :** `apps/cli/src/tests/architecture.test.ts`, `apps/web/src/tests/architecture.test.ts`, `packages/adapters/airtable/src/tests/architecture.test.ts`, `packages/adapters/apify/src/tests/architecture.test.ts`, `packages/adapters/cloudflare/src/tests/architecture.test.ts`, `packages/adapters/firecrawl/src/tests/architecture.test.ts`, `packages/adapters/gmail/src/tests/architecture.test.ts`, `packages/adapters/google-calendar/src/tests/architecture.test.ts`, `packages/adapters/google-docs/src/tests/architecture.test.ts`, `packages/adapters/google-drive/src/tests/architecture.test.ts`, `packages/adapters/google-sheets/src/tests/architecture.test.ts`, `packages/adapters/mcp/src/tests/architecture.test.ts`, `packages/adapters/notion/src/tests/architecture.test.ts`, `packages/adapters/outlook-mail/src/tests/architecture.test.ts`, `packages/adapters/poyo/src/tests/architecture.test.ts`, `packages/adapters/tavily/src/tests/architecture.test.ts`, `packages/auth/src/tests/architecture.test.ts`, `packages/catalog/src/tests/architecture.test.ts`, `packages/db/src/tests/architecture.test.ts`, `packages/delivery/src/tests/architecture.test.ts`, `packages/llm/src/tests/architecture.test.ts`, `packages/memory/src/tests/architecture.test.ts`, `packages/runner-adapters/src/tests/architecture.test.ts`, `packages/secrets/src/tests/architecture.test.ts`, `packages/shared/src/tests/architecture.test.ts`

| Ligne | Titre | Durée |
|---:|---|---:|
| 27 | no per-user UUID in source (invariant #6) | 104 ms |
| 25 | no per-user UUID in source (invariant #6) | 13 ms |
| 27 | no per-user UUID in source (invariant #6) | 9 ms |
| 26 | no per-user UUID in source (invariant #6) | 7 ms |
| 26 | no per-user UUID in source (invariant #6) | 6 ms |
| 26 | no per-user UUID in source (invariant #6) | 5 ms |
| 25 | no per-user UUID in source (invariant #6) | 5 ms |
| 25 | no per-user UUID in source (invariant #6) | 5 ms |
| 43 | no hardcoded UUIDs (per-user values) in source files | 5 ms |
| 26 | no per-user UUID in source (invariant #6) | 4 ms |
| 43 | no hardcoded UUIDs (per-user values) in source files | 3 ms |
| 43 | no hardcoded UUIDs (per-user values) in source files | 3 ms |
| 43 | no hardcoded UUIDs (per-user values) in source files | 3 ms |
| 42 | no hardcoded UUIDs (per-user values) in source files | 3 ms |
| 29 | no hardcoded UUIDs (per-user values) in source files | 3 ms |
| 41 | no hardcoded UUIDs (per-user values) in source files | 2 ms |
| 43 | no hardcoded UUIDs (per-user values) in source files | 2 ms |
| 41 | no hardcoded UUIDs (per-user values) in source files | 2 ms |
| 42 | no hardcoded UUIDs (per-user values) in source files | 2 ms |
| 42 | no hardcoded UUIDs (per-user values) in source files | 2 ms |
| 42 | no hardcoded UUIDs (per-user values) in source files | 1 ms |
| 42 | no hardcoded UUIDs (per-user values) in source files | 1 ms |
| 42 | no hardcoded UUIDs (per-user values) in source files | 1 ms |
| 26 | no per-user UUID in source (invariant #6) | 1 ms |
| 26 | no per-user UUID in source (invariant #6) | 1 ms |

**Ce qu’ils exercent :** assertNoViolations, scanForHardcodedUuids.
**Assertions :** (aucune).
**Fusion :** copies identiques — en garder **un**, supprimer les 24 autres.

### 5. 3 cas — certain — plusieurs fichiers — 78 ms récupérables

**Fichiers :** `apps/runner/src/tests/channels/discord/handler.test.ts`, `apps/runner/src/tests/channels/slack/handler.test.ts`, `apps/runner/src/tests/channels/whatsapp/handler.test.ts`

| Ligne | Titre | Durée |
|---:|---|---:|
| 308 | routes /ask <slug> <text> to the named agent when the conversation is already active for it | 54 ms |
| 347 | routes /ask <slug> <text> to the named agent when the conversation is already active for it | 43 ms |
| 288 | routes /ask <slug> <text> to the named agent when the conversation is already active for it | 35 ms |

**Ce qu’ils exercent :** async, freshBot, claimOwner, dm, insert, values, Date.now, returning, ….
**Assertions :** .toBeDefined, .toBe, .toBe.
**Ce qui varie :** littéral #2 (`dm-ask-1` / `D-ask-1`) ; littéral #4 (``ask-target-${` / ``ask-target-slack-${` / ``whatsapp-ask-target-${`) ; littéral #7 (`discord` / `slack` / `whatsapp`).
**Fusion :** un `test.each` de 3 lignes, une ligne par variante — mécanique, sans perte.

### 6. 3 cas — certain — plusieurs fichiers — 68 ms récupérables

**Fichiers :** `apps/runner/src/tests/channels/discord/handler.test.ts`, `apps/runner/src/tests/channels/slack/handler.test.ts`, `apps/runner/src/tests/channels/whatsapp/handler.test.ts`

| Ligne | Titre | Durée |
|---:|---|---:|
| 381 | /ask to a sibling the conversation has never talked to: NO job, pending member created, owner notified | 61 ms |
| 366 | /ask to a sibling the conversation has never talked to: NO job, pending member created, owner notified | 36 ms |
| 366 | /ask to a sibling the conversation has never talked to: NO job, pending member created, owner notified | 32 ms |

**Ce qu’ils exercent :** async, freshBot, claimOwner, dm, freshBot, db.insert, values, select, ….
**Assertions :** .toBeUndefined, .toBe, .toMatchObject, .toBe, .toBe, .toHaveLength.
**Ce qui varie :** littéral #2 (`dm-ask-2` / `D-ask-2`) ; littéral #3 (`discord` / `slack` / `whatsapp`) ; littéral #4 (`dm-ask-target-owner` / `D-ask-target-owner`).
**Fusion :** un `test.each` de 3 lignes, une ligne par variante — mécanique, sans perte.

### 7. 4 cas — certain — plusieurs fichiers — 66 ms récupérables

**Fichiers :** `apps/runner/src/tests/channels/discord/handler.test.ts`, `apps/runner/src/tests/channels/slack/handler.test.ts`, `apps/runner/src/tests/channels/whatsapp/handler.test.ts`

| Ligne | Titre | Durée |
|---:|---|---:|
| 425 | skips /ask <unknown-slug> rather than blindly creating a job | 47 ms |
| 410 | skips /ask <unknown-slug> rather than blindly creating a job | 33 ms |
| 417 | skips /ask with no text after the slug | 17 ms |
| 410 | skips /ask <unknown-slug> rather than blindly creating a job | 15 ms |

**Ce qu’ils exercent :** async, freshBot, claimOwner, dm, call, dm, expect, toEqual.
**Assertions :** .toEqual.
**Ce qui varie :** littéral #2 (`dm-ask-3` / `D-ask-3` / `dm-ask-4`) ; littéral #3 (`/ask not-a-real-agent please help` / `/ask some-slug`) ; littéral #4 (`dm-ask-3` / `D-ask-3` / `dm-ask-4`).
**Fusion :** un `test.each` de 4 lignes, une ligne par variante — mécanique, sans perte.

### 8. 2 cas — certain — un seul fichier — 60 ms récupérables

**Fichier :** `apps/web/tests/code-processes-actions.test.ts`

| Ligne | Titre | Durée |
|---:|---|---:|
| 615 | a failed job surfaces with stage "failed" | 87 ms |
| 472 | a completed job with an edit but no review_verdict anywhere is plain "done" | 60 ms |

**Ce qu’ils exercent :** async, makeAgent, makeJob, insert, values, insert, values, import, ….
**Assertions :** .toBe, .toBe.
**Ce qui varie :** littéral #1 (`Audit Code Plain Done Agent` / `Audit Code Failed Agent`) ; littéral #2 (`completed` / `failed`) ; littéral #4 (`read` / `write`).
**Fusion :** un `test.each` de 2 lignes, une ligne par variante — mécanique, sans perte.

### 9. 3 cas — certain — plusieurs fichiers — 59 ms récupérables

**Fichiers :** `apps/runner/src/tests/channels/discord/handler.test.ts`, `apps/runner/src/tests/channels/slack/handler.test.ts`, `apps/runner/src/tests/channels/whatsapp/handler.test.ts`

| Ligne | Titre | Durée |
|---:|---|---:|
| 134 | first DM with no owner records a PENDING owner claim and creates NO job | 84 ms |
| 152 | first DM with no owner records a PENDING owner claim and creates NO job | 39 ms |
| 114 | first DM with no owner records a PENDING owner claim and creates NO job | 20 ms |

**Ce qu’ils exercent :** async, freshBot, call, dm, expect, toBeUndefined, expect, toBe, ….
**Assertions :** .toBeUndefined, .toBe, .toMatchObject, .toHaveLength, .toHaveLength, .toMatchObject.
**Ce qui varie :** littéral #2 (`dm-owner-1` / `D-owner-1`) ; littéral #4 (`dm-owner-1` / `D-owner-1`) ; littéral #5 (`dm-owner-1` / `D-owner-1`).
**Fusion :** un `test.each` de 3 lignes, une ligne par variante — mécanique, sans perte.

### 10. 3 cas — certain — plusieurs fichiers — 58 ms récupérables

**Fichiers :** `apps/runner/src/tests/channels/discord/handler.test.ts`, `apps/runner/src/tests/channels/slack/handler.test.ts`, `apps/runner/src/tests/channels/whatsapp/handler.test.ts`

| Ligne | Titre | Durée |
|---:|---|---:|
| 171 | an unknown DM when an owner exists creates NO job and returns a pendingAuth card intent to the owner | 65 ms |
| 210 | an unknown DM when an owner exists creates NO job and returns a pendingAuth notice intent to the owner | 29 ms |
| 151 | an unknown DM when an owner exists creates NO job and returns a pendingAuth card intent to the owner | 29 ms |

**Ce qu’ils exercent :** async, freshBot, claimOwner, dm, call, dm, expect, toBeUndefined, ….
**Assertions :** .toBeUndefined, .toBe, .toMatchObject, .toBe, .toBe, .toHaveLength.
**Ce qui varie :** littéral #2 (`dm-owner-2` / `D-owner-2`) ; littéral #4 (`dm-stranger-2` / `D-stranger-2`) ; littéral #6 (`dm-owner-2` / `D-owner-2`).
**Fusion :** un `test.each` de 3 lignes, une ligne par variante — mécanique, sans perte.

### 11. 3 cas — certain — un seul fichier — 55 ms récupérables

**Fichier :** `packages/orchestration/src/tests/planner/completion.test.ts`

| Ligne | Titre | Durée |
|---:|---|---:|
| 118 | returns false for a mix of terminal and non-terminal | 30 ms |
| 80 | returns false when any task is still todo | 30 ms |
| 89 | returns false when any task is in_progress | 25 ms |

**Ce qu’ils exercent :** async, seedContext, createTask, createTask, checkRootJobComplete, expect, toBe.
**Assertions :** .toBe.
**Ce qui varie :** littéral #2 (`todo` / `in_progress`).
**Fusion :** un `test.each` de 3 lignes, une ligne par variante — mécanique, sans perte.

### 12. 3 cas — certain — plusieurs fichiers — 54 ms récupérables

**Fichiers :** `apps/runner/src/tests/channels/discord/handler.test.ts`, `apps/runner/src/tests/channels/slack/handler.test.ts`, `apps/runner/src/tests/channels/whatsapp/handler.test.ts`

| Ligne | Titre | Durée |
|---:|---|---:|
| 234 | a repeat DM from an already-pending conversation does NOT re-ask the owner (no spam) | 32 ms |
| 195 | a repeat DM from an already-pending conversation does NOT re-ask the owner (no spam) | 31 ms |
| 175 | a repeat DM from an already-pending conversation does NOT re-ask the owner (no spam) | 23 ms |

**Ce qu’ils exercent :** async, freshBot, claimOwner, dm, call, dm, call, dm, ….
**Assertions :** .toBeUndefined, .toBe, .toBeUndefined.
**Ce qui varie :** littéral #2 (`dm-owner-3` / `D-owner-3`) ; littéral #4 (`dm-stranger-3` / `D-stranger-3`) ; littéral #6 (`dm-stranger-3` / `D-stranger-3`).
**Fusion :** un `test.each` de 3 lignes, une ligne par variante — mécanique, sans perte.

### 13. 2 cas — certain — un seul fichier — 51 ms récupérables

**Fichier :** `packages/delivery/src/tests/whatsapp-socket-manager.test.ts`

| Ligne | Titre | Durée |
|---:|---|---:|
| 424 | ignores "append" batches (history/offline backfill) — only "notify" is live | 51 ms |
| 402 | ignores status@broadcast messages | 51 ms |

**Ce qu’ils exercent :** async, emitAndCapture, baseKey, expect, toEqual.
**Assertions :** .toEqual.
**Ce qui varie :** littéral #1 (`notify` / `append`) ; littéral #2 (`status@broadcast` / `111@s.whatsapp.net`) ; littéral #3 (`someone posted a status` / `old`).
**Fusion :** un `test.each` de 2 lignes, une ligne par variante — mécanique, sans perte.

### 14. 3 cas — certain — plusieurs fichiers — 49 ms récupérables

**Fichiers :** `apps/runner/src/tests/channels/discord/handler.test.ts`, `apps/runner/src/tests/channels/slack/handler.test.ts`, `apps/runner/src/tests/channels/whatsapp/handler.test.ts`

| Ligne | Titre | Durée |
|---:|---|---:|
| 206 | an active member conversation creates a job | 58 ms |
| 186 | an active member conversation creates a job | 26 ms |
| 245 | an active member conversation creates a job | 23 ms |

**Ce qu’ils exercent :** async, freshBot, claimOwner, dm, db.insert, values, call, dm, ….
**Assertions :** .toBeDefined.
**Ce qui varie :** littéral #2 (`dm-owner-4` / `D-owner-4`) ; littéral #3 (`discord` / `slack` / `whatsapp`) ; littéral #4 (`dm-member-4` / `D-member-4`).
**Fusion :** un `test.each` de 3 lignes, une ligne par variante — mécanique, sans perte.

### 15. 2 cas — certain — un seul fichier — 37 ms récupérables

**Fichier :** `packages/tools/src/builtin/office-ops/xlsx.test.ts`

| Ligne | Titre | Durée |
|---:|---|---:|
| 898 | refuses xlsx_set_cell when the workbook contains a pivot table part | 38 ms |
| 887 | refuses xlsx_set_cell when the workbook contains a chart part | 37 ms |

**Ce qu’ils exercent :** async, createXlsxWithExtraEntry, xlsxSetCellTool.execute, ctx, expect, toBe, Error, expect, ….
**Assertions :** .toBe, .toMatch.
**Ce qui varie :** littéral #1 (`chart.xlsx` / `pivot-table.xlsx`) ; littéral #2 (`xl/charts/chart1.xml` / `xl/pivotTables/pivotTable1.xml`) ; littéral #3 (`chart.xlsx` / `pivot-table.xlsx`).
**Fusion :** un `test.each` de 2 lignes, une ligne par variante — mécanique, sans perte.

### 16. 19 cas — certain — plusieurs fichiers — 35 ms récupérables

**Fichiers :** `packages/adapters/airtable/src/tests/architecture.test.ts`, `packages/adapters/apify/src/tests/architecture.test.ts`, `packages/adapters/firecrawl/src/tests/architecture.test.ts`, `packages/adapters/gmail/src/tests/architecture.test.ts`, `packages/adapters/google-docs/src/tests/architecture.test.ts`, `packages/adapters/google-drive/src/tests/architecture.test.ts`, `packages/adapters/google-sheets/src/tests/architecture.test.ts`, `packages/adapters/notion/src/tests/architecture.test.ts`, `packages/adapters/outlook-mail/src/tests/architecture.test.ts`, `packages/adapters/poyo/src/tests/architecture.test.ts`, `packages/adapters/tavily/src/tests/architecture.test.ts`

| Ligne | Titre | Durée |
|---:|---|---:|
| 54 | no hardcoded Google Sheets spreadsheet URLs in source files | 5 ms |
| 67 | no AUTH_FAILED or hardcoded user-facing error strings | 4 ms |
| 67 | no AUTH_FAILED or hardcoded user-facing error strings | 3 ms |
| 54 | no hardcoded Google Drive folder URLs in source files | 3 ms |
| 67 | no AUTH_FAILED or hardcoded user-facing error strings | 3 ms |
| 67 | no AUTH_FAILED or hardcoded user-facing error strings | 3 ms |
| 54 | no hardcoded Gmail URLs in source files | 3 ms |
| 66 | no AUTH_FAILED or hardcoded user-facing error strings | 2 ms |
| 53 | no hardcoded notion.so page URLs in source files | 2 ms |
| 76 | no AUTH_FAILED or hardcoded user-facing error strings | 2 ms |
| 54 | no hardcoded Google Docs document URLs in source files | 2 ms |
| 66 | no AUTH_FAILED or hardcoded user-facing error strings | 2 ms |
| 53 | no hardcoded bearer tokens in source files | 1 ms |
| 66 | no AUTH_FAILED or hardcoded user-facing error strings | 1 ms |
| 53 | no AUTH_FAILED or hardcoded user-facing error strings | 1 ms |
| 53 | no hardcoded Airtable base IDs (appXXXXXXXX) in source files | 1 ms |
| 53 | no AUTH_FAILED or hardcoded user-facing error strings | 1 ms |
| 66 | no AUTH_FAILED or hardcoded user-facing error strings | 1 ms |
| 53 | no hardcoded Tavily API keys (tvly-...) in source files | 1 ms |

**Ce qu’ils exercent :** assertNoViolations, scanForPattern.
**Assertions :** (aucune).
**Ce qui varie :** littéral #1 (`base ID Airtable en dur` / `texte utilisateur en dur` / `URL Gmail en dur` / `URL Google Docs en dur` / `URL Google Drive en dur` / `URL Google Sheets en dur` / `URL Notion en dur` / `token en dur` / `cle Tavily en dur`) ; littéral #2 (`/['"`]app[a-zA-Z0-9]{14}['"`]/` / `/\[AUTH_FAILED\]\|Re-authenticate in the ` / `/\[AUTH_FAILED\]\|Re-authenticate in the ` / `/\[AUTH_FAILED\]\|Re-authenticate in the ` / `/https:\/\/mail\.google\.com\/mail\/[a-z` / `/\[AUTH_FAILED\]\|Re-authenticate in the ` / `/https:\/\/docs\.google\.com\/document\/` / `/\[AUTH_FAILED\]\|Re-authenticate in the ` / `/https:\/\/drive\.google\.com\/drive\/fo` / `/\[AUTH_FAILED\]\|Re-authenticate in the ` / `/https:\/\/docs\.google\.com\/spreadshee` / `/\[AUTH_FAILED\]\|Re-authenticate in the ` / `/https:\/\/(www\.)?notion\.so\/[a-zA-Z0-` / `/\[AUTH_FAILED\]\|Re-authenticate in the ` / `/\[AUTH_FAILED\]\|Re-authenticate in the ` / `/['"`]Bearer\s+[A-Za-z0-9._-]{16,}['"`]/` / `/\[AUTH_FAILED\]\|Re-authenticate in the ` / `/['"`]tvly-[A-Za-z0-9]{8,}['"`]/` / `/\[AUTH_FAILED\]\|Re-authenticate in the `) ; littéral #3 (`airtable-base-id` / `user-facing-string` / `gmail-url` / `gdocs-url` / `gdrive-url` / `gsheets-url` / `notion-url` / `hardcoded-token` / `tavily-key`).
**Fusion :** un `test.each` de 19 lignes, une ligne par variante — mécanique, sans perte.

### 17. 2 cas — certain — plusieurs fichiers — 35 ms récupérables

**Fichiers :** `apps/runner/src/tests/channels/discord/handler.test.ts`, `apps/runner/src/tests/channels/slack/handler.test.ts`

| Ligne | Titre | Durée |
|---:|---|---:|
| 161 | once the owner claim is approved, that conversation creates jobs | 168 ms |
| 141 | once the owner claim is approved, that conversation creates jobs | 35 ms |

**Ce qu’ils exercent :** async, freshBot, claimOwner, dm, call, dm, expect, toBeDefined, ….
**Assertions :** .toBeDefined, .toBe, .toBe.
**Ce qui varie :** littéral #2 (`dm-approved-1` / `D-approved-1`) ; littéral #4 (`dm-approved-1` / `D-approved-1`) ; littéral #5 (`discord` / `slack`).
**Fusion :** un `test.each` de 2 lignes, une ligne par variante — mécanique, sans perte.

### 18. 2 cas — certain — un seul fichier — 34 ms récupérables

**Fichier :** `packages/tools/src/builtin/office-ops/xlsx.test.ts`

| Ligne | Titre | Durée |
|---:|---|---:|
| 536 | returns ok:false for missing sheet | 38 ms |
| 525 | returns ok:false for an invalid range | 34 ms |

**Ce qu’ils exercent :** async, createSampleXlsx, xlsxFormatRangeTool.execute, ctx, expect, toBe, Error, expect, ….
**Assertions :** .toBe, .toMatch.
**Ce qui varie :** littéral #3 (`Data` / `NoSuchSheet`) ; littéral #4 (`not-a-range` / `A1`) ; littéral #6 (`/invalid range/i` / `/not found/i`).
**Fusion :** un `test.each` de 2 lignes, une ligne par variante — mécanique, sans perte.

### 19. 2 cas — certain, copies pures — plusieurs fichiers — 33 ms récupérables

**Fichiers :** `packages/orchestration/src/tests/architecture.test.ts`, `packages/tools/src/tests/architecture.test.ts`

| Ligne | Titre | Durée |
|---:|---|---:|
| 25 | src/ ne contient aucun slug d’agent connu | 123 ms |
| 22 | src/ ne contient aucun slug d’agent connu | 33 ms |

**Ce qu’ils exercent :** scanForAgentSlugs, expect.fail, formatViolations.
**Assertions :** (sans matcher).
**Fusion :** copies identiques — en garder **un**, supprimer les 1 autres.

### 20. 2 cas — certain — un seul fichier — 32 ms récupérables

**Fichier :** `apps/runner/src/tests/lib/mcp-provenance.test.ts`

| Ligne | Titre | Durée |
|---:|---|---:|
| 90 | VRAI pour une chaîne plus longue que la borne, même sans ancêtre mcp visible | 65 ms |
| 57 | VRAI même à six sauts — le contournement exact de la review | 32 ms |

**Ce qu’ils exercent :** async, insertJob, insertJob, expect, isMcpOriginJob, toBe.
**Assertions :** .toBe.
**Ce qui varie :** littéral #4 (`l ancêtre MCP au-delà de la fenêtre a ét` / `la chaîne trop longue a été déclarée sûr`).
**Fusion :** un `test.each` de 2 lignes, une ligne par variante — mécanique, sans perte.

## Ce que valent ces groupes — cinq relus à la main

Relus le 2026-09-12, en ouvrant le code sous test, pas seulement les titres.

**1. `approval-rule-scope.test.ts:62` + `internal-tool-toggles.test.ts:102` — VRAI.**
Les deux appellent `setAgentApprovalRuleAction` et relisent la ligne écrite.
Lu dans `apps/web/src/lib/actions.ts:6230` : `toolName` y est opaque — pas de
branche pour un joker `cogni_cortex__*`, pas de branche pour un outil interne.
Le `action: 'block'` du second traverse une garde de plus
(`UNBLOCKABLE_TOOLS`), qui ne fait rien pour `web_search`. Même branche
d'écriture, même assertion : l'un ne peut pas tomber sans l'autre. Vrai
chevauchement — mais un mauvais candidat à la fusion : les deux fichiers montent
leur propre base et leurs propres mocks, et le second n'existe que pour son
voisin (`return_result` ne peut PAS être bloqué). À laisser.

**2 et 3. Les 25 `architecture.test.ts` (`scanForAgentSlugs`, `scanForHardcodedUuids`) — FAUX.**
Corps identiques au caractère près, oui. Mais chacun passe le `srcDir` de SON
paquet : `join(fileURLToPath(import.meta.url), '..', '..')`. Le test de
`packages/llm` tombe quand `packages/llm` viole l'invariant #1, et lui seul.
Ils ne peuvent pas tomber ensemble — c'est exactement le contraire du critère.
C'est d'ailleurs le mécanisme que `CLAUDE.md` désigne comme l'application des
invariants #1, #2 et #6. Les fusionner supprimerait la protection de 24 paquets.

**4 et 5. `/ask` sur discord / slack / whatsapp — FAUX.**
Trois fichiers, trois modules : `handleDiscordMessage`, `handleSlackMessage`,
`handleWhatsappMessage`. Même scénario, trois implémentations distinctes ; une
régression dans le routage Slack ne fait pas rougir Discord. Duplication de
CODE DE TEST, réelle — une table de scénarios partagée serait un gain de
maintenance — mais pas un chevauchement qui coûte sans protéger.

**Taux de faux positifs constaté : 4 sur 5 (80 %).** Les quatre ont la même
cause : le groupe s'étale sur plusieurs fichiers qui testent des modules
différents. D'où la colonne « un seul fichier / plusieurs fichiers » ajoutée au
classement. Sur les groupes internes à UN fichier, le détecteur n'a pas été
mis en défaut ici — mais cinq relectures ne suffisent pas à l'affirmer.

Le détecteur lui-même a ses tests
(`scripts/tests/audit-tests-chevauchement.test.mjs`), et ils ont été vérifiés
PAR MUTATION : couper la reconnaissance des commentaires, des chaînes, des
expressions régulières ou du marqueur « même fichier » les fait rougir à chaque
fois. La première version du test sur le découpage lexical survivait à tout —
elle plaçait des accolades là où c'est la parenthèse qui délimite un `it(...)`.
Elle ne prouvait rien ; elle a été réécrite.

## Limites de la méthode

- **La normalisation garde les identifiants.** Deux tests qui font la même chose en passant par des variables nommées différemment ne sont PAS appariés. C'est un choix : effacer les identifiants ferait se ressembler deux tests qui n'appellent pas la même fonction, et un faux positif coûte plus cher ici qu'un manque.
- **Un corps sous 40 caractères normalisés est ignoré.** Un `expect(f()).toBe(§)` se retrouve partout, légitimement, sur des sujets différents. Le seuil coupe ce bruit — et cache donc, par construction, les vraies duplications très courtes.
- **Ce que le détecteur ne voit pas du tout :** les fixtures et `beforeEach` partagés (deux cas au corps différent peuvent exercer la même branche parce que toute la mise en place est ailleurs) ; deux cas qui exercent la même branche par deux chemins d'appel différents ; l'équivalence sémantique entre `toBe(true)` et `toEqual(expect.objectContaining(…))`.
- **Faux positifs plausibles.** Un `test.each` déjà en place produit des cas au corps identique — le détecteur les voit comme un groupe, alors que la fusion est déjà faite. Un test nommé d'après un incident réel peut avoir le même corps qu'un test générique tout en exerçant une entrée qui, elle, documente le cas : le groupe est réel, la suppression serait une perte. C'est pourquoi la colonne « ce qui varie » est dans le rapport.
- **`tests.ndjson` est un fichier VERSIONNÉ, donc il dépend de la branche.** Une branche qui le réinitialise fait sortir un rapport à zéro seconde, sans rien signaler — c'est arrivé pendant l'écriture de cet audit, sur une branche voisine. Ce rapport doit être régénéré depuis `main`, ou depuis une branche qui n'y touche pas. La ligne « temps d'exécution de tous les cas mesurés » est le témoin : à 1 428,7 s la mémoire est complète, très en dessous elle est tronquée.
- **`dureeMs` est le temps du CORPS, pas le coût complet.** Le montage du fichier (imports, `beforeAll`, `spinUpTestDb`) n'y est pas. Supprimer des cas à l'intérieur d'un fichier ne rend donc que ce que le rapport annonce ; supprimer un fichier ENTIER rendrait davantage. Aucun groupe ici ne couvre un fichier entier.
- **Les durées sont celles d'une exécution, pas une moyenne.** `tests.ndjson` porte le `dureeMs` du dernier passage en CI. Un cas lent par accident (contention disque sur le runner) gonfle son groupe. Les ordres de grandeur tiennent, pas les secondes.
- **Les cas sans durée sortent du calcul de coût.** Un fichier jamais passé en CI, un titre calculé à l'exécution, un `describe.each` : le cas figure au rapport, son temps est vide. Le total récupérable est donc un PLANCHER.
- **Le e2e Playwright n'a pas de durée ici.** `tests.ndjson` est alimenté par vitest ; les spécifications Playwright ont leur propre rapport. Les groupes e2e apparaissent, leur coût non.
- **Rien n’a été exécuté pour produire ce rapport.** Aucune conclusion ici ne dit qu’un test passe ou tombe — seulement que deux cas se ressemblent au point qu’il faut aller les lire.
