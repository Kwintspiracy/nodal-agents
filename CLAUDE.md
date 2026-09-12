# Nodal-Agents — instructions for Claude Code

This is the all-Node monorepo replacing the legacy KwintAgents (Python+Next dual-stack).

## Architecture

- pnpm workspaces + Turborepo
- TypeScript strict (no `any`, no `// @ts-ignore` without comment)
- Drizzle ORM (only `packages/db` imports `pg` / `postgres` / `drizzle-orm`)
- Zod for validation everywhere
- Vercel AI SDK for LLM (multi-provider abstraction)
- Hono for HTTP server (runner)
- Vitest for unit tests, Playwright for e2e, dependency-cruiser for architecture
- Better-auth for opt-in dashboard auth (local mode = no auth by default)

## Non-negotiable invariants

**How each is actually enforced** (CODE-001, audit 2026-08-07 — the audit first
claimed #1 and #2 were unenforced, having looked only for ESLint rules; they are
enforced, by tests. Stating the mechanism here so the next reader does not have
to rediscover it):

| Invariant | Enforced by |
|---|---|
| #1, #2, #6 | `architecture.test.ts` in **28 packages**, all calling the shared scanners in `@nodal-agents/test-kit`. `pnpm bench --section architecture` reports the counts and the number of packages covered |
| #10 (no native dialogs) | ESLint `no-restricted-globals` in `apps/web/eslint.config.mjs` |
| Layering (adapters, db driver) | dependency-cruiser, `pnpm deps:check` |
| #5 (tests assert real results) | review discipline — no mechanical check |
| #3, #4, #7, #8, #9 | review discipline, plus the targeted suites named in each rule |

1. **No hardcoded agent metadata.** Skills, routing, team blocks, sub-agent descriptions: 100% from DB.
2. **No hardcoded user-facing text in runner.** LLM speaks or runner stays silent.
3. **No agent-specific band-aids in runner.** Fix at agent layer (DB), never patch the runtime.
4. **No silent smart fallbacks.** Fail loud with clear error.
5. **Tests assert real results** — body of LLM request, DB row, tool_result content. Never just call counts.
6. **No per-user hardcoded values** — IDs / URLs / tokens via memory or user config.
7. **Always use official SDKs** when available (`@anthropic-ai/sdk`, `googleapis`, `@notionhq/client`, etc.).
8. **Anti-loop guards baked in** (max 15 chains, max 50 tool calls/turn, max 3 delegation depth). Raised from the original 5 on 2026-05-19 (`packages/orchestration/src/chain-counters.ts`) once sequential-delegation workflows needed more resumes than a runaway-detection cap calibrated without empirical data allowed; the `failed_delegations_count` cap and `maxDelegationDepth` guards absorbed the actual runaway risk, so `chain_count` could safely become a resume budget instead.
9. **Tool whitelist explicit per agent** — no defaults, list calculated from DB per job.
10. **No native browser dialogs** — `window.confirm` / `window.alert` / `window.prompt` are banned. Use `<ConfirmDialog />` (`apps/web/src/components/ConfirmDialog.tsx`) for confirmations and the Sonner toaster for notifications. Enforced by ESLint `no-restricted-globals` in `apps/web/eslint.config.mjs`.

## Workflow rules

- When Fable orchestrates the session, it delegates coding to Opus 5 and Sonnet 5 depending on task complexity.
- Never use Haiku.
- A brique or PR is merged only once PR review and the applicable test gates pass (unit + arch + regression always; integration/smoke when an external service is touched).

### Reviewing a PR — `codex review`, never a Claude subagent

**This rule exists because it was broken on 2026-08-25.** The review plan said
"external Codex for the P0s"; four Claude subagents were launched instead, over
several hours, silently burning the session's own quota. The findings were real,
but the argument for reviewing them — an outside pair of eyes — was not: two
instances of the same model share the same blind spots. The plan was written and
then forgotten by its own author, which is why the rule now lives here.

- **Reviewing a PR means running `codex review`.** Not the Agent tool. Not a
  subagent named after Codex. The command must appear in the tool calls.
- **Launching a Claude subagent to review a PR is FORBIDDEN.** No exception for
  "just a second opinion", "a quick pass", or "the diff is small".
- **The trigger is an OPEN PR, not the end of a session.** A review is due as
  soon as the PR exists, including mid-session and including a PR that is still
  being amended.
- **Loop** review → fix → review until Codex asks for no further change. A
  finding is closed by a test that fails first, and the fix is verified BY
  MUTATION (disable it, the test must go red).
- **If `codex` is missing or fails: say so and stop.** Never fall back to a
  Claude reviewer — that is a silent smart fallback (invariant #4), and it hides
  the fact that no independent review happened.

Claude subagents remain fine for anything that is NOT reviewing a PR: searching
the codebase, mapping an area, drafting, running suites.

## Commands

```bash
pnpm install      # one-time setup
pnpm --filter nodal-agents exec tsx src/index.ts --dev   # dev stack (embedded Postgres + runner + web HMR)
pnpm dev          # turbo dev — raw per-package watchers only, does NOT boot the full stack
pnpm build        # production build
pnpm test         # vitest across all packages
pnpm typecheck    # tsc --noEmit
pnpm lint         # eslint flat config
pnpm format       # prettier --write
pnpm format:check # prettier --check
pnpm deps:check   # dependency-cruiser
```

## Tests gates per brique

1. **Unit** — fonctions pures, mocks aux frontières. Assertions sur le résultat réel, pas sur les call counts.
2. **Architecture** — dep-cruiser + ESLint custom rules (invariants 1-2 enforced).
3. **Regression** — un test par comportement legacy préservé. Écrit AVANT le port.
4. **Integration / smoke** — uniquement pour briques touchant un service externe (LLM, DB, API tierce).

### Ce qu'un test PROUVE — l'étiquette `@cap:`

Un test dit quelle capacité du produit il prouve, ET À QUEL NIVEAU, en écrivant
`@cap:<slug>/<niveau>` dans son titre. Vitest et Playwright n'ont rien à
comprendre : le titre voyage tel quel jusqu'au rapport.

Deux niveaux, et un seul ne suffit jamais :

| Niveau | Ce que c'est | Ce qu'il prouve | Ce qu'il NE prouve PAS |
|---|---|---|---|
| `/ecran` | un parcours Playwright, ou un test de composant / d'action web | que les boutons existent, s'enchaînent et affichent ce qu'il faut | que quoi que ce soit se passe derrière — un écran peut être vert devant un moteur débranché |
| `/moteur` | un test du runner, des outils, de l'orchestration, de la base | que la chose promise EST FAITE : l'outil hors liste refusé, la mémoire relue, l'approbation qui bloque | qu'un utilisateur sache y arriver — un moteur parfait derrière un bouton introuvable ne sert à personne |

```ts
// écran : le parcours navigateur
test.describe('Notion OAuth flow @cap:connecter-un-service/ecran', () => { … });
// moteur : ce qui fait la chose
describe('computeToolWhitelist @cap:assigner-outils/moteur', () => { … });
```

Posée sur un `describe`, l'étiquette vaut pour tous ses cas — c'est la forme la
moins verbeuse, et donc la seule qui tienne dans le temps.

**Une capacité n'est vraiment vérifiée que si les DEUX niveaux existent et
passent.** La distinction est née d'une question de Quentin (12/09/2026) :
« quand c'est vert, ça veut dire que le runner fonctionne vraiment, ou
simplement que cocher les boutons fonctionne ? ». Elle était fondée :
« Donner des outils » s'affichait *prouvée* sur la foi de trois parcours d'écran,
alors que `whitelist.test.ts` et `resolve-agent-tools.test.ts` — les tests qui
prouvent la promesse — n'étaient étiquetés nulle part. Le portail ne rend donc
plus un verdict : il rend deux faits, par niveau, et une absence s'affiche en
gris et se dit, jamais en rouge.

Quand un niveau n'a aucun test, le registre porte en une phrase ce qu'un tel
test devrait vérifier (`ecranAttendu` / `preuveAttendue`), et `apps/qa/lib.test.mjs`
refuse cette phrase sur un niveau déjà prouvé — un plan périmé ne vaut pas mieux
qu'un trou anonyme.

⚠️ Le niveau doit FINIR là : `@cap:x/ecranXYZ`, `@cap:y/moteur-bis` et
`@cap:z/Ecran` ne sont PAS des niveaux — ils retombent dans « non dit », donc
sous les yeux de quelqu'un. Une faute de frappe ne devient jamais un niveau en
silence.

⚠️ Une étiquette SANS niveau (`@cap:<slug>`) est encore lue, mais elle ne compte
pour aucune des deux colonnes — la ranger d'office dans « écran » peindrait en
vert un moteur que personne n'a testé. `pnpm capacites:check` la signale en
AVERTISSEMENT sans bloquer, le temps de la transition ; il n'en reste aucune
aujourd'hui, et le jour où ce sera encore vrai un moment, ce cas deviendra
bloquant.

Le registre des capacités est `apps/qa/capacites.mjs`. Il est DÉRIVÉ des
parcours et des écrans réels, jamais imaginé : un registre d'imagination décrit
le produit qu'on aimerait avoir, et l'écart avec les tests ne veut plus rien
dire.

`pnpm capacites:check` (porte bloquante de la CI) refuse deux choses, et deux
seulement : une étiquette qui ne désigne aucune capacité du registre, et une
capacité `exigee` que plus aucun test ne revendique. **Elle ne juge aucun
résultat** — elle tourne sur les PR, où aucun rapport e2e n'existe. La gravité
d'un test rouge est un autre sujet (issue #65).

**Les 24 capacités sont `exigee`** — la vague est close. Elles ne l'étaient pas
toutes au départ (sept), parce qu'une porte qui exige tout le premier jour se
fait désactiver le deuxième ; elles le sont devenues à mesure de l'étiquetage.
Ajouter une capacité au registre sans l'étiqueter nulle part fait donc rougir la
CI, et c'est voulu : c'est le seul moment où quelqu'un se demande encore ce qui
la prouve.

⚠️ **Une étiquette écrite ailleurs que dans un titre n'est pas lue** — ni dans un
commentaire, ni dans une chaîne. C'est délibéré : les fixtures du portail
contiennent des exemples, et le premier scan les prenait pour de vraies
déclarations. Si un test doit manipuler une étiquette littérale, il l'assemble à
l'exécution (`'@' + 'cap'`), comme le fait `apps/qa/lib.test.mjs`.

### Où vivent les tests

**À CÔTÉ du code qu'ils prouvent**, jamais dans un dossier `tests/` central :

| Quoi | Où | Combien |
|---|---|---|
| Unitaires, architecture, régression | `packages/<paquet>/src/tests/` et `apps/<app>/src/tests/` | 586 fichiers |
| Bout en bout (Playwright) | `apps/web/tests/e2e/` — le `testDir` de `playwright.config.ts` est relatif à `apps/web` | 36 fichiers |
| Banc d'essai (mesures, pas verdicts) | `packages/bench`, baselines dans `bench/baselines/` | 5 sections |

`vitest.config.ts` à la racine ne déclare aucun chemin de découverte : il prend
tout, sauf `node_modules`, `dist`, `.next`, `.turbo` et `.claude` (des copies
périmées de l'arbre y traînent).

Le dépôt a porté jusqu'au 09/09/2026 trois dossiers `tests/architecture`,
`tests/e2e` et `tests/smoke` à la racine, **vides depuis sa fondation** — un
`.gitkeep` chacun, aucune configuration ne les regardant. Un audit de juillet
les avait signalés ; ils sont supprimés. Quiconque ouvrait le dépôt y voyait la
promesse de tests qui vivaient ailleurs.

## Ajouter une migration

Deux gestes, jamais un seul :

1. `packages/db/migrations/NNNN_nom.sql`
2. **une entrée dans `packages/db/migrations/meta/_journal.json`** (`idx`, `tag`
   = le nom du fichier sans `.sql`)

Sans le journal, drizzle-kit **ignore le fichier en silence**. `pnpm test` reste
vert — la base de test de `spinUpTestDb` est construite en SQL inline
(`packages/db/src/tests/helpers.ts`), pas depuis les migrations — et seuls les
tests `*.pg.test.ts`, qui appliquent les VRAIES migrations sur un vrai Postgres,
rougissent. Une colonne ajoutée au schéma Drizzle demande donc **trois**
endroits : le schéma, la migration + son journal, et le SQL inline des tests.

## Legacy reference

The KwintAgents legacy code lives at `D:\APPS\KwintAgents/` — read-only reference during migration. Each brique in the plan file lists which legacy files to port from.
