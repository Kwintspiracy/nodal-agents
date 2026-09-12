# Audit des tests qui se chevauchent

_Mesure du 2026-09-12. Rejouable : `node scripts/audit-tests-chevauchement.mjs`._

**Aucun test n’a été modifié pour produire ce rapport.**

## Ce que la mesure dit

Le chevauchement existe — 1112 cas sur 7066 sont dans un groupe — mais **il ne coûte quasiment rien**. Tout fusionner rendrait **0 ms** sur les **260.1 s** que l’exécution des corps de test représente au total, soit **0.00 %**. Les 19,5 minutes médianes d’une PR ne viennent pas de là.

Et la part qui reste se divise en deux, très inégalement. Les groupes dont les membres vivent **dans le même fichier** (320 groupes, 0 ms) sont de vrais candidats à la fusion. Ceux qui s’étalent **sur plusieurs fichiers** (75 groupes, 0 ms) sont presque toujours le même scénario joué contre des modules différents — les 28 `architecture.test.ts`, les trois handlers de canal — et là, fusionner supprimerait de la protection. La vérification à la main du § « Ce que valent ces groupes » le montre sur cinq cas.

## Les chiffres

| | |
|---|---|
| Fichiers de test parcourus | 594 |
| Cas extraits (`it` / `test`) | 7066 |
| Cas dont la durée est connue | 85 |
| Temps d’exécution de tous les cas mesurés | 260.1 s |
| Groupes **certains** | 279 |
| Cas dans un groupe certain | 834 |
| Groupes **probables** | 116 |
| Cas dans un groupe probable | 278 |
| Groupes internes à un seul fichier | 320 |
| Groupes étalés sur plusieurs fichiers | 75 |
| Temps récupérable, groupes certains | 0 ms |
| Temps récupérable, groupes probables | 0 ms |
| Temps récupérable, groupes d’un seul fichier | 0 ms |
| Temps récupérable, total | **0 ms** (0.00 %) |

Source des durées : `apps/qa/data/tests.ndjson`. C’est la mémoire test par test du portail qualité, alimentée par le `--reporter=json` de `qa.yml`. Aucune suite n’a été relancée pour ce rapport.

## Par fichier

| Fichier | Cas | Certains | Probables | Temps récupérable |
|---|---:|---:|---:|---:|
| `apps/cli/src/tests/architecture.test.ts` | 3 | 3 | 0 | 0 ms |
| `apps/web/src/tests/architecture.test.ts` | 5 | 3 | 0 | 0 ms |
| `packages/adapters/airtable/src/tests/architecture.test.ts` | 5 | 5 | 0 | 0 ms |
| `packages/adapters/apify/src/tests/architecture.test.ts` | 4 | 4 | 0 | 0 ms |
| `packages/adapters/cloudflare/src/tests/architecture.test.ts` | 3 | 3 | 0 | 0 ms |
| `packages/adapters/firecrawl/src/tests/architecture.test.ts` | 4 | 4 | 0 | 0 ms |
| `packages/adapters/gmail/src/tests/architecture.test.ts` | 7 | 7 | 0 | 0 ms |
| `packages/adapters/google-calendar/src/tests/architecture.test.ts` | 3 | 3 | 0 | 0 ms |
| `packages/adapters/google-docs/src/tests/architecture.test.ts` | 7 | 7 | 0 | 0 ms |
| `packages/adapters/google-drive/src/tests/architecture.test.ts` | 7 | 7 | 0 | 0 ms |
| `packages/adapters/google-sheets/src/tests/architecture.test.ts` | 7 | 7 | 0 | 0 ms |
| `packages/adapters/mcp/src/tests/architecture.test.ts` | 3 | 3 | 0 | 0 ms |
| `packages/adapters/notion/src/tests/architecture.test.ts` | 5 | 5 | 0 | 0 ms |
| `packages/adapters/outlook-mail/src/tests/architecture.test.ts` | 6 | 5 | 0 | 0 ms |
| `packages/adapters/poyo/src/tests/architecture.test.ts` | 5 | 5 | 0 | 0 ms |
| `packages/adapters/tavily/src/tests/architecture.test.ts` | 5 | 5 | 0 | 0 ms |
| `packages/auth/src/tests/architecture.test.ts` | 4 | 4 | 0 | 0 ms |
| `packages/catalog/src/tests/architecture.test.ts` | 3 | 3 | 0 | 0 ms |
| `packages/db/src/tests/architecture.test.ts` | 3 | 3 | 0 | 0 ms |
| `packages/delivery/src/tests/architecture.test.ts` | 4 | 4 | 0 | 0 ms |
| `packages/llm/src/tests/architecture.test.ts` | 4 | 4 | 0 | 0 ms |
| `packages/memory/src/tests/architecture.test.ts` | 4 | 4 | 0 | 0 ms |
| `packages/runner-adapters/src/tests/architecture.test.ts` | 4 | 4 | 0 | 0 ms |
| `packages/secrets/src/tests/architecture.test.ts` | 4 | 4 | 0 | 0 ms |
| `packages/shared/src/tests/architecture.test.ts` | 5 | 4 | 0 | 0 ms |
| `apps/cli/src/tests/detach.test.ts` | 9 | 2 | 0 | 0 ms |
| `apps/cli/src/tests/env.test.ts` | 24 | 9 | 0 | 0 ms |
| `apps/cli/src/tests/llm-presets.test.ts` | 16 | 8 | 3 | 0 ms |
| `apps/cli/src/tests/version.test.ts` | 8 | 7 | 0 | 0 ms |
| `apps/qa/lib.test.mjs` | 129 | 15 | 4 | 0 ms |
| `apps/runner/src/skills/install.test.ts` | 71 | 9 | 2 | 0 ms |
| `apps/runner/src/tests/approvals/approval-callback.test.ts` | 17 | 2 | 0 | 0 ms |
| `apps/runner/src/tests/channels/discord/handler.test.ts` | 17 | 8 | 0 | 0 ms |
| `apps/runner/src/tests/channels/slack/handler.test.ts` | 17 | 8 | 0 | 0 ms |
| `apps/runner/src/tests/channels/whatsapp/handler.test.ts` | 18 | 8 | 0 | 0 ms |
| `apps/runner/src/tests/job/conversation-id.test.ts` | 32 | 2 | 0 | 0 ms |
| `apps/runner/src/tests/job/deployment.test.ts` | 13 | 3 | 2 | 0 ms |
| `apps/runner/src/tests/job/state.test.ts` | 29 | 8 | 0 | 0 ms |
| `apps/runner/src/tests/lib/mcp-provenance.test.ts` | 7 | 2 | 4 | 0 ms |
| `apps/runner/src/tests/reflection/reflection.test.ts` | 23 | 2 | 0 | 0 ms |
| … et 221 autres fichiers | | | | |

## Les vingt groupes les plus coûteux

Triés par le temps de CI qu’une fusion rendrait. Pour chaque groupe : ce que les cas exercent, et ce que la fusion donnerait.

### 1. 25 cas — certain — plusieurs fichiers — — récupérables

**Fichiers :** `apps/cli/src/tests/architecture.test.ts`, `apps/web/src/tests/architecture.test.ts`, `packages/adapters/airtable/src/tests/architecture.test.ts`, `packages/adapters/apify/src/tests/architecture.test.ts`, `packages/adapters/cloudflare/src/tests/architecture.test.ts`, `packages/adapters/firecrawl/src/tests/architecture.test.ts`, `packages/adapters/gmail/src/tests/architecture.test.ts`, `packages/adapters/google-calendar/src/tests/architecture.test.ts`, `packages/adapters/google-docs/src/tests/architecture.test.ts`, `packages/adapters/google-drive/src/tests/architecture.test.ts`, `packages/adapters/google-sheets/src/tests/architecture.test.ts`, `packages/adapters/mcp/src/tests/architecture.test.ts`, `packages/adapters/notion/src/tests/architecture.test.ts`, `packages/adapters/outlook-mail/src/tests/architecture.test.ts`, `packages/adapters/poyo/src/tests/architecture.test.ts`, `packages/adapters/tavily/src/tests/architecture.test.ts`, `packages/auth/src/tests/architecture.test.ts`, `packages/catalog/src/tests/architecture.test.ts`, `packages/db/src/tests/architecture.test.ts`, `packages/delivery/src/tests/architecture.test.ts`, `packages/llm/src/tests/architecture.test.ts`, `packages/memory/src/tests/architecture.test.ts`, `packages/runner-adapters/src/tests/architecture.test.ts`, `packages/secrets/src/tests/architecture.test.ts`, `packages/shared/src/tests/architecture.test.ts`

| Ligne | Titre | Durée |
|---:|---|---:|
| 21 | no agent or server slug hardcoded in source (invariant #1) | — |
| 23 | no agent or server slug hardcoded in source (invariant #1) | — |
| 38 | no agent slugs hardcoded in source files | — |
| 38 | no agent slugs hardcoded in source files | — |
| 25 | no agent slugs hardcoded in source files | — |
| 38 | no agent slugs hardcoded in source files | — |
| 39 | no agent slugs hardcoded in source files | — |
| 37 | no agent slugs hardcoded in source files | — |
| 39 | no agent slugs hardcoded in source files | — |
| 39 | no agent slugs hardcoded in source files | — |
| 39 | no agent slugs hardcoded in source files | — |
| 37 | no agent slugs hardcoded in source files | — |
| 38 | no agent slugs hardcoded in source files | — |
| 39 | no agent slugs hardcoded in source files | — |
| 38 | no agent slugs hardcoded in source files | — |
| 38 | no agent slugs hardcoded in source files | — |
| 22 | no agent or server slug hardcoded in source (invariant #1) | — |
| 21 | no agent or server slug hardcoded in source (invariant #1) | — |
| 21 | no agent or server slug hardcoded in source (invariant #1) | — |
| 22 | no agent or server slug hardcoded in source (invariant #1) | — |
| 22 | no agent or server slug hardcoded in source (invariant #1) | — |
| 22 | no agent or server slug hardcoded in source (invariant #1) | — |
| 22 | no agent or server slug hardcoded in source (invariant #1) | — |
| 22 | no agent or server slug hardcoded in source (invariant #1) | — |
| 23 | no agent or server slug hardcoded in source (invariant #1) | — |

**Ce qu’ils exercent :** assertNoViolations, scanForAgentSlugs.
**Assertions :** (aucune).
**Ce qui varie :** littéral #1 (`slugs d\u2019agent` / `slugs d’agent`).
**Fusion :** un `test.each` de 25 lignes, une ligne par variante — mécanique, sans perte.

### 2. 25 cas — certain, copies pures — plusieurs fichiers — — récupérables

**Fichiers :** `apps/cli/src/tests/architecture.test.ts`, `apps/web/src/tests/architecture.test.ts`, `packages/adapters/airtable/src/tests/architecture.test.ts`, `packages/adapters/apify/src/tests/architecture.test.ts`, `packages/adapters/cloudflare/src/tests/architecture.test.ts`, `packages/adapters/firecrawl/src/tests/architecture.test.ts`, `packages/adapters/gmail/src/tests/architecture.test.ts`, `packages/adapters/google-calendar/src/tests/architecture.test.ts`, `packages/adapters/google-docs/src/tests/architecture.test.ts`, `packages/adapters/google-drive/src/tests/architecture.test.ts`, `packages/adapters/google-sheets/src/tests/architecture.test.ts`, `packages/adapters/mcp/src/tests/architecture.test.ts`, `packages/adapters/notion/src/tests/architecture.test.ts`, `packages/adapters/outlook-mail/src/tests/architecture.test.ts`, `packages/adapters/poyo/src/tests/architecture.test.ts`, `packages/adapters/tavily/src/tests/architecture.test.ts`, `packages/auth/src/tests/architecture.test.ts`, `packages/catalog/src/tests/architecture.test.ts`, `packages/db/src/tests/architecture.test.ts`, `packages/delivery/src/tests/architecture.test.ts`, `packages/llm/src/tests/architecture.test.ts`, `packages/memory/src/tests/architecture.test.ts`, `packages/runner-adapters/src/tests/architecture.test.ts`, `packages/secrets/src/tests/architecture.test.ts`, `packages/shared/src/tests/architecture.test.ts`

| Ligne | Titre | Durée |
|---:|---|---:|
| 25 | no per-user UUID in source (invariant #6) | — |
| 27 | no per-user UUID in source (invariant #6) | — |
| 42 | no hardcoded UUIDs (per-user values) in source files | — |
| 42 | no hardcoded UUIDs (per-user values) in source files | — |
| 29 | no hardcoded UUIDs (per-user values) in source files | — |
| 42 | no hardcoded UUIDs (per-user values) in source files | — |
| 43 | no hardcoded UUIDs (per-user values) in source files | — |
| 41 | no hardcoded UUIDs (per-user values) in source files | — |
| 43 | no hardcoded UUIDs (per-user values) in source files | — |
| 43 | no hardcoded UUIDs (per-user values) in source files | — |
| 43 | no hardcoded UUIDs (per-user values) in source files | — |
| 41 | no hardcoded UUIDs (per-user values) in source files | — |
| 42 | no hardcoded UUIDs (per-user values) in source files | — |
| 43 | no hardcoded UUIDs (per-user values) in source files | — |
| 42 | no hardcoded UUIDs (per-user values) in source files | — |
| 42 | no hardcoded UUIDs (per-user values) in source files | — |
| 26 | no per-user UUID in source (invariant #6) | — |
| 25 | no per-user UUID in source (invariant #6) | — |
| 25 | no per-user UUID in source (invariant #6) | — |
| 26 | no per-user UUID in source (invariant #6) | — |
| 26 | no per-user UUID in source (invariant #6) | — |
| 26 | no per-user UUID in source (invariant #6) | — |
| 26 | no per-user UUID in source (invariant #6) | — |
| 26 | no per-user UUID in source (invariant #6) | — |
| 27 | no per-user UUID in source (invariant #6) | — |

**Ce qu’ils exercent :** assertNoViolations, scanForHardcodedUuids.
**Assertions :** (aucune).
**Fusion :** copies identiques — en garder **un**, supprimer les 24 autres.

### 3. 10 cas — certain, copies pures — plusieurs fichiers — — récupérables

**Fichiers :** `apps/cli/src/tests/architecture.test.ts`, `apps/web/src/tests/architecture.test.ts`, `packages/auth/src/tests/architecture.test.ts`, `packages/catalog/src/tests/architecture.test.ts`, `packages/delivery/src/tests/architecture.test.ts`, `packages/llm/src/tests/architecture.test.ts`, `packages/memory/src/tests/architecture.test.ts`, `packages/runner-adapters/src/tests/architecture.test.ts`, `packages/secrets/src/tests/architecture.test.ts`, `packages/shared/src/tests/architecture.test.ts`

| Ligne | Titre | Durée |
|---:|---|---:|
| 29 | does not import a database driver (only packages/db may) | — |
| 31 | does not import a database driver (only packages/db may) | — |
| 30 | does not import a database driver (only packages/db may) | — |
| 29 | does not import a database driver (only packages/db may) | — |
| 30 | does not import a database driver (only packages/db may) | — |
| 30 | does not import a database driver (only packages/db may) | — |
| 30 | does not import a database driver (only packages/db may) | — |
| 30 | does not import a database driver (only packages/db may) | — |
| 30 | does not import a database driver (only packages/db may) | — |
| 31 | does not import a database driver (only packages/db may) | — |

**Ce qu’ils exercent :** assertNoViolations, scanForDbDriverImports.
**Assertions :** (aucune).
**Fusion :** copies identiques — en garder **un**, supprimer les 9 autres.

### 4. 2 cas — certain — un seul fichier — — récupérables

**Fichier :** `apps/cli/src/tests/detach.test.ts`

| Ligne | Titre | Durée |
|---:|---|---:|
| 77 | `up --detach` arrives as opts.detach=true | — |
| 83 | the short form `-d` does too | — |

**Ce qu’ils exercent :** async, buildCli, program.parseAsync, expect, toEqual.
**Assertions :** .toEqual.
**Ce qui varie :** littéral #4 (`--detach` / `-d`).
**Fusion :** un `test.each` de 2 lignes, une ligne par variante — mécanique, sans perte.

### 5. 2 cas — certain — un seul fichier — — récupérables

**Fichier :** `apps/cli/src/tests/env.test.ts`

| Ligne | Titre | Durée |
|---:|---|---:|
| 24 | sets AUTH_MODE=local-trust for loopback | — |
| 43 | binds 127.0.0.1 for loopback | — |

**Ce qu’ils exercent :** buildEnvForRunner, expect, toBe.
**Assertions :** .toBe.
**Ce qui varie :** littéral #1 (`AUTH_MODE` / `BIND`) ; littéral #2 (`local-trust` / `127.0.0.1`).
**Fusion :** un `test.each` de 2 lignes, une ligne par variante — mécanique, sans perte.

### 6. 2 cas — certain — un seul fichier — — récupérables

**Fichier :** `apps/cli/src/tests/env.test.ts`

| Ligne | Titre | Durée |
|---:|---|---:|
| 29 | sets AUTH_MODE=local-auth for LAN (not bearer-token) | — |
| 48 | binds 0.0.0.0 for LAN | — |

**Ce qu’ils exercent :** buildEnvForRunner, expect, toBe.
**Assertions :** .toBe.
**Ce qui varie :** littéral #2 (`AUTH_MODE` / `BIND`) ; littéral #3 (`local-auth` / `0.0.0.0`).
**Fusion :** un `test.each` de 2 lignes, une ligne par variante — mécanique, sans perte.

### 7. 3 cas — certain — un seul fichier — — récupérables

**Fichier :** `apps/cli/src/tests/env.test.ts`

| Ligne | Titre | Durée |
|---:|---|---:|
| 70 | sets AUTH_MODE=local-trust for loopback | — |
| 81 | sets NEXT_PUBLIC_AUTH_MODE to mirror AUTH_MODE for loopback | — |
| 157 | falls back to empty string when serverActionsKey is absent (defensive) | — |

**Ce qu’ils exercent :** buildEnvForWeb, expect, toBe.
**Assertions :** .toBe.
**Ce qui varie :** littéral #1 (`AUTH_MODE` / `NEXT_PUBLIC_AUTH_MODE` / `NEXT_SERVER_ACTIONS_ENCRYPTION_KEY`) ; littéral #2 (`local-trust` / ``).
**Fusion :** un `test.each` de 3 lignes, une ligne par variante — mécanique, sans perte.

### 8. 2 cas — certain — un seul fichier — — récupérables

**Fichier :** `apps/cli/src/tests/env.test.ts`

| Ligne | Titre | Durée |
|---:|---|---:|
| 75 | sets AUTH_MODE=local-auth for LAN (not bearer-token) | — |
| 86 | sets NEXT_PUBLIC_AUTH_MODE=local-auth for LAN so login page renders correctly | — |

**Ce qu’ils exercent :** buildEnvForWeb, expect, toBe.
**Assertions :** .toBe.
**Ce qui varie :** littéral #2 (`AUTH_MODE` / `NEXT_PUBLIC_AUTH_MODE`).
**Fusion :** un `test.each` de 2 lignes, une ligne par variante — mécanique, sans perte.

### 9. 8 cas — certain — un seul fichier — — récupérables

**Fichier :** `apps/cli/src/tests/llm-presets.test.ts`

| Ligne | Titre | Durée |
|---:|---|---:|
| 42 | ollama uses correct default URL | — |
| 47 | lm-studio uses correct default URL | — |
| 52 | jan-ai uses correct default URL | — |
| 57 | llamacpp uses correct default URL | — |
| 62 | vllm uses correct default URL | — |
| 67 | anthropic uses correct default URL | — |
| 72 | openai uses correct default URL | — |
| 77 | openrouter uses correct default URL | — |

**Ce qu’ils exercent :** getPreset, expect, toBe.
**Assertions :** .toBe.
**Ce qui varie :** littéral #1 (`ollama` / `lm-studio` / `jan-ai` / `llamacpp` / `vllm` / `anthropic` / `openai` / `openrouter`) ; littéral #2 (`http://localhost:11434` / `http://localhost:1234/v1` / `http://localhost:1337/v1` / `http://localhost:8080/v1` / `http://localhost:8000/v1` / `https://api.anthropic.com` / `https://api.openai.com/v1` / `https://openrouter.ai/api/v1`).
**Fusion :** un `test.each` de 8 lignes, une ligne par variante — mécanique, sans perte.

### 10. 4 cas — certain — un seul fichier — — récupérables

**Fichier :** `apps/cli/src/tests/version.test.ts`

| Ligne | Titre | Durée |
|---:|---|---:|
| 9 | returns false when candidate is older (patch) | — |
| 21 | returns false on exact equality | — |
| 29 | returns false when candidate is older (minor) | — |
| 33 | ignores a pre-release suffix and treats equal numeric triples as not newer | — |

**Ce qu’ils exercent :** expect, isNewerVersion, toBe.
**Assertions :** .toBe.
**Ce qui varie :** littéral #1 (`0.6.8` / `0.7.0` / `0.7.0-beta.1`) ; littéral #2 (`0.7.0` / `0.8.0`).
**Fusion :** un `test.each` de 4 lignes, une ligne par variante — mécanique, sans perte.

### 11. 3 cas — certain — un seul fichier — — récupérables

**Fichier :** `apps/cli/src/tests/version.test.ts`

| Ligne | Titre | Durée |
|---:|---|---:|
| 13 | returns true when candidate is newer (major) | — |
| 17 | returns true when candidate is newer (patch) | — |
| 25 | returns true when candidate is newer (minor) | — |

**Ce qu’ils exercent :** expect, isNewerVersion, toBe.
**Assertions :** .toBe.
**Ce qui varie :** littéral #1 (`0.8.0` / `0.7.1`) ; littéral #2 (`0.7.0` / `0.7.9`).
**Fusion :** un `test.each` de 3 lignes, une ligne par variante — mécanique, sans perte.

### 12. 3 cas — certain — un seul fichier — — récupérables

**Fichier :** `apps/qa/lib.test.mjs`

| Ligne | Titre | Durée |
|---:|---|---:|
| 43 | tout en succès ⇒ vert | — |
| 47 | un échec ⇒ rouge | — |
| 85 | NEUTRAL et SKIPPED comptent comme réussis | — |

**Ce qu’ils exercent :** expect, etatCi, toBe.
**Assertions :** .toBe.
**Ce qui varie :** littéral #1 (`SUCCESS` / `NEUTRAL`) ; littéral #2 (`SUCCESS` / `FAILURE` / `SKIPPED`) ; littéral #3 (`vert` / `rouge`).
**Fusion :** un `test.each` de 3 lignes, une ligne par variante — mécanique, sans perte.

### 13. 2 cas — certain — un seul fichier — — récupérables

**Fichier :** `apps/qa/lib.test.mjs`

| Ligne | Titre | Durée |
|---:|---|---:|
| 103 | une issue étiquetée décision attend Quentin | — |
| 126 | une issue fermée est faite | — |

**Ce qu’ils exercent :** expect, colonneDeCarte, toBe.
**Assertions :** .toBe.
**Ce qui varie :** littéral #2 (`OPEN` / `CLOSED`) ; littéral #4 (`À faire` / `Fait`).
**Fusion :** un `test.each` de 2 lignes, une ligne par variante — mécanique, sans perte.

### 14. 2 cas — certain — un seul fichier — — récupérables

**Fichier :** `apps/qa/lib.test.mjs`

| Ligne | Titre | Durée |
|---:|---|---:|
| 109 | une issue étiquetée test va dans À tester | — |
| 115 | « décision » prime sur « test » — c’est elle qui bloque | — |

**Ce qu’ils exercent :** expect, colonneDeCarte, toBe.
**Assertions :** .toBe.
**Ce qui varie :** littéral #4 (`dette` / `décision`) ; littéral #5 (`À tester` / `À faire`).
**Fusion :** un `test.each` de 2 lignes, une ligne par variante — mécanique, sans perte.

### 15. 2 cas — certain — un seul fichier — — récupérables

**Fichier :** `apps/qa/lib.test.mjs`

| Ligne | Titre | Durée |
|---:|---|---:|
| 187 | un passage du premier coup est vert | — |
| 191 | un échec est rouge | — |

**Ce qu’ils exercent :** expect, sortDuCas, toBe.
**Assertions :** .toBe.
**Ce qui varie :** littéral #1 (`passed` / `failed`) ; littéral #2 (`vert` / `rouge`).
**Fusion :** un `test.each` de 2 lignes, une ligne par variante — mécanique, sans perte.

### 16. 2 cas — certain — un seul fichier — — récupérables

**Fichier :** `apps/qa/lib.test.mjs`

| Ligne | Titre | Durée |
|---:|---|---:|
| 202 | passé au SECOND essai est instable, pas vert | — |
| 208 | un essai ignoré parmi des passages ne change rien | — |

**Ce qu’ils exercent :** expect, sortDuCas, toBe.
**Assertions :** .toBe.
**Ce qui varie :** littéral #1 (`failed` / `skipped`) ; littéral #3 (`instable` / `vert`).
**Fusion :** un `test.each` de 2 lignes, une ligne par variante — mécanique, sans perte.

### 17. 2 cas — certain — un seul fichier — — récupérables

**Fichier :** `apps/qa/lib.test.mjs`

| Ligne | Titre | Durée |
|---:|---|---:|
| 281 | la nuit constate, elle ne bloque pas | — |
| 285 | un push sur main est entre les deux | — |

**Ce qu’ils exercent :** expect, cadenceDe, toBe.
**Assertions :** .toBe.
**Ce qui varie :** littéral #1 (`schedule` / `push`) ; littéral #3 (`chaque nuit` / `chaque push sur main`).
**Fusion :** un `test.each` de 2 lignes, une ligne par variante — mécanique, sans perte.

### 18. 2 cas — certain — un seul fichier — — récupérables

**Fichier :** `apps/qa/lib.test.mjs`

| Ligne | Titre | Durée |
|---:|---|---:|
| 813 | que des verts ⇒ sûr | — |
| 817 | que des rouges ⇒ cassé, pas instable | — |

**Ce qu’ils exercent :** expect, instabiliteDe, toMatchObject.
**Assertions :** .toMatchObject.
**Ce qui varie :** littéral #1 (`vvvvv` / `rrr`) ; littéral #2 (`sûr` / `cassé`).
**Fusion :** un `test.each` de 2 lignes, une ligne par variante — mécanique, sans perte.

### 19. 4 cas — certain — un seul fichier — — récupérables

**Fichier :** `apps/runner/src/skills/install.test.ts`

| Ligne | Titre | Durée |
|---:|---|---:|
| 89 | rejects unparseable input | — |
| 108 | rejects a clawhub URL without a slug | — |
| 127 | still rejects a scheme-less non-allowlisted host (anti-SSRF) | — |
| 151 | CAT-1: rejects an invalid repo segment in the shorthand form | — |

**Ce qu’ils exercent :** expect, parseSkillSource, toThrow.
**Assertions :** .toThrow.
**Ce qui varie :** littéral #1 (`not a url or repo` / `https://clawhub.ai/onlysegment` / `evil.example.com/owner/repo` / `acme/repo!/skills/foo`).
**Fusion :** un `test.each` de 4 lignes, une ligne par variante — mécanique, sans perte.

### 20. 2 cas — certain — un seul fichier — — récupérables

**Fichier :** `apps/runner/src/skills/install.test.ts`

| Ligne | Titre | Durée |
|---:|---|---:|
| 100 | parses a clawhub.ai URL into a clawhub source | — |
| 112 | parses a scheme-less clawhub host as a clawhub source | — |

**Ce qu’ils exercent :** parseSkillSource, expect, toBe, expect, toBe, expect, toBe, expect, ….
**Assertions :** .toBe, .toBe, .toBe, .toBe.
**Ce qui varie :** littéral #1 (`https://clawhub.ai/danielblinker83-bot/i` / `clawhub.ai/kelvincai522/comfyui`) ; littéral #3 (`danielblinker83-bot` / `kelvincai522`) ; littéral #4 (`image-studio` / `comfyui`).
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
- **`dureeMs` est le temps du CORPS, pas le coût complet.** Le montage du fichier (imports, `beforeAll`, `spinUpTestDb`) n'y est pas. Supprimer des cas à l'intérieur d'un fichier ne rend donc que ce que le rapport annonce ; supprimer un fichier ENTIER rendrait davantage. Aucun groupe ici ne couvre un fichier entier.
- **Les durées sont celles d'une exécution, pas une moyenne.** `tests.ndjson` porte le `dureeMs` du dernier passage en CI. Un cas lent par accident (contention disque sur le runner) gonfle son groupe. Les ordres de grandeur tiennent, pas les secondes.
- **Les cas sans durée sortent du calcul de coût.** Un fichier jamais passé en CI, un titre calculé à l'exécution, un `describe.each` : le cas figure au rapport, son temps est vide. Le total récupérable est donc un PLANCHER.
- **Le e2e Playwright n'a pas de durée ici.** `tests.ndjson` est alimenté par vitest ; les spécifications Playwright ont leur propre rapport. Les groupes e2e apparaissent, leur coût non.
- **Rien n’a été exécuté pour produire ce rapport.** Aucune conclusion ici ne dit qu’un test passe ou tombe — seulement que deux cas se ressemblent au point qu’il faut aller les lire.
