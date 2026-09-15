/**
 * Everything the homepage states, in one place.
 *
 * Two reasons this is data and not JSX:
 *
 *  1. Every claim on a public page has to be traceable. Each measured figure
 *     carries the file it was read from and the date it was measured, and a
 *     test refuses a figure without one. A landing page that drifts away from
 *     the product is worse than no landing page.
 *  2. The section titles are asserted by `home-content.test.ts` against the
 *     rendered markup, so "the page contains its sections" is a fact and not a
 *     hope.
 */

/**
 * Mirrors `basePath` / `assetPrefix` in `apps/docs/next.config.mjs`.
 *
 * The page links and images deliberately use plain `<a>` / `<img>` rather than
 * `next/link` / `next/image`: the site is a static export, so the prefix is the
 * only thing those components would add, and keeping the markup plain means the
 * whole page can be rendered by `react-dom/server` inside a unit test. The
 * duplication is closed by a test that reads the real config.
 */
export const BASE_PATH = '/nodal-agents';

export interface Section {
  readonly id: string;
  readonly index: string;
  readonly label: string;
  readonly title: string;
}

/** The section anchors, in page order. Asserted against the rendered markup. */
export const SECTIONS: readonly Section[] = [
  { id: 'what-it-is', index: '01', label: 'The product', title: 'What it is' },
  { id: 'what-you-build', index: '02', label: 'In practice', title: 'What you can build' },
  { id: 'how-its-designed', index: '03', label: 'Product approach', title: 'How it is designed' },
  { id: 'how-its-built', index: '04', label: 'Engineering', title: 'How it is built' },
  { id: 'where-it-stands', index: '05', label: 'Status', title: 'Where it stands' },
];

/* ── Section 01 ─────────────────────────────────────────────────────────── */

export interface Pillar {
  readonly title: string;
  readonly body: string;
}

/** Source: README.md, "Why Nodal-Agents" and "Available now". */
export const PILLARS: readonly Pillar[] = [
  {
    title: 'A team, not a chatbot',
    body: 'Agents delegate to each other. An orchestrator routes a request to one specialist and resumes on its answer, or fans the work out to several and compiles the result.',
  },
  {
    title: 'One model per agent',
    body: 'Anthropic, OpenAI, Google, Groq, Mistral, OpenRouter, DeepSeek, MiniMax, Moonshot, or a local model in LM Studio or Ollama. One key per provider, and each agent picks its own.',
  },
  {
    title: 'Your keys, your disk',
    body: 'Conversations, memory and credentials stay on the machine. Every credential is encrypted at rest with AES-256-GCM. You pay the provider directly, with nothing added on top.',
  },
  {
    title: 'Any surface',
    body: 'The dashboard chat, Telegram, Discord, Slack and WhatsApp. Approvals, images and files travel over all of them, with a fallback where a channel has no buttons.',
  },
];

/* ── Section 02 ─────────────────────────────────────────────────────────── */

export interface Scenario {
  readonly name: string;
  readonly body: string;
}

/** Source: README.md, "What you can build". */
export const SCENARIOS: readonly Scenario[] = [
  {
    name: 'A research desk',
    body: 'An orchestrator fans a question out to specialists, one on web search, one on your Notion, one on your Drive. Each writes a section. The orchestrator compiles the brief and emails it to you.',
  },
  {
    name: 'A Telegram concierge',
    body: 'You message a bot. It routes to the right agent, remembers the conversation, runs shell commands or calls your APIs, and stops to ask before anything risky.',
  },
  {
    name: 'An automation crew',
    body: 'Cron-scheduled agents wake up every morning, hit your connectors and MCP servers, and ping you on Telegram when they are done.',
  },
];

/* ── Section 03 ─────────────────────────────────────────────────────────── */

export interface Principle {
  readonly title: string;
  readonly body: string;
}

/**
 * Source: README.md ("Why Nodal-Agents", "How it works") and the product
 * decisions recorded in CLAUDE.md.
 */
export const PRINCIPLES: readonly Principle[] = [
  {
    title: 'The thread is the screen',
    body: 'The conversation is the interface. You do not fill in a form to start work. You say what you want, and what the agent did shows up in the thread it happened in.',
  },
  {
    title: 'An agent is a row, not a file',
    body: 'Personality, skills, connectors, memory budget and team assignments all live in Postgres. The runtime carries no agent name. Adding a capability inserts rows, it does not edit code.',
  },
  {
    title: 'Guards against running away',
    body: 'A token budget per job on every provider, a no-progress detector, an atomic job claim so the same job never runs twice, and hard caps on chained resumes, tool calls and delegation depth.',
  },
  {
    title: 'Guards against a false win',
    body: 'A run that failed is never reported as done. Every failed job keeps its transcript, the real upstream error and a short specific reason, propagated back up through delegation.',
  },
  {
    title: 'You approve before it bites',
    body: 'Risky tools pause. The prompt opens with the agent saying, in plain language, what it wants to do and why, plus the impact, instead of a wall of raw shell.',
  },
  {
    title: 'Memory that compounds',
    body: 'Durable facts are injected into every job, ranked by relevance to the task at hand. Full-text recall reaches back over everything the team has done, and a background curator keeps the store clean.',
  },
  {
    title: 'Skills and connectors, not plugins',
    body: 'Skills are written guidance an agent reads. Connectors and MCP servers are what it can reach. Both are assigned per agent, and an agent can install a community skill or write its own.',
  },
  {
    title: 'Nothing to lock you in',
    body: 'One command installs it, an embedded Postgres comes with it, and the data sits in a folder you own. Swap the model, swap the machine, or walk away with the directory.',
  },
];

export interface Invariant {
  readonly n: number;
  readonly text: string;
}

/** Source: CLAUDE.md, "Non-negotiable invariants", rewritten in plain words. */
export const INVARIANTS: readonly Invariant[] = [
  {
    n: 1,
    text: 'No agent detail is written into the code. Skills, routing, team blocks and sub-agent descriptions all come from the database.',
  },
  {
    n: 2,
    text: 'The runtime never speaks for an agent. The model says it, or nothing is said.',
  },
  {
    n: 3,
    text: 'No fix is aimed at one agent. A problem is fixed where agents are defined, never patched into the runtime.',
  },
  {
    n: 4,
    text: 'No clever fallback. When something is missing the run fails, loudly, with a reason you can read.',
  },
  {
    n: 5,
    text: 'A test asserts a real result: the body of the request, the row in the database, the content the tool returned. Never a call count.',
  },
  {
    n: 6,
    text: 'Nothing is hardcoded for one person. Identifiers, URLs and tokens come from memory or from your own config.',
  },
  {
    n: 7,
    text: 'Official SDKs whenever one exists, rather than a hand-rolled client.',
  },
  {
    n: 8,
    text: 'Runaway caps are built in: at most 15 chained resumes, 50 tool calls per turn, and 3 levels of delegation.',
  },
  {
    n: 9,
    text: 'Every agent carries an explicit tool list, computed per job from the database. There is no default set.',
  },
  {
    n: 10,
    text: 'No native browser dialog. Confirmations use the product dialog, so they can be styled, tested and driven.',
  },
];

/* ── Section 04 ─────────────────────────────────────────────────────────── */

export interface Figure {
  readonly value: string;
  readonly label: string;
}

/**
 * Every figure below was read from `apps/qa/data/snapshot.json`, produced by the
 * nightly measurement (`.github/workflows/qa.yml`) on 14 September 2026, run
 * 34825077357, commit 3e067fb1. The date is printed next to the table on the
 * page: a number without its measurement date is a number nobody can check.
 */
export const MEASURED_ON = '14 September 2026';
export const MEASURED_COMMIT = '3e067fb1';
export const MEASURED_RUN_URL =
  'https://github.com/Kwintspiracy/nodal-agents/actions/runs/34825077357';

export const FIGURES: readonly Figure[] = [
  { value: '34', label: 'packages measured' },
  { value: '6,881', label: 'test cases' },
  { value: '561', label: 'test files' },
  { value: '229', label: 'end-to-end cases' },
  { value: '81.6%', label: 'line coverage' },
  { value: '12 / 24', label: 'capabilities green at both levels' },
];

export interface Practice {
  readonly title: string;
  readonly body: string;
}

/**
 * Source: CLAUDE.md ("Tests gates per brique", the `@cap:` label, the Codex
 * review rule) and `.github/workflows/ci.yml` / `qa.yml` / `qa-pages.yml`.
 */
export const PRACTICES: readonly Practice[] = [
  {
    title: 'Tests live beside the code',
    body: 'There is no central test folder. A package carries its own unit, architecture and regression tests, and the browser journeys sit with the dashboard they drive.',
  },
  {
    title: 'A capability is proven twice',
    body: 'Every test says which product capability it proves, and at which level, by writing a label in its own title. Screen level proves the buttons exist and lead somewhere. Engine level proves the promised thing actually happens. One level alone never counts, because a green screen can sit in front of an unplugged engine.',
  },
  {
    title: 'The gate refuses a lie, not a red test',
    body: 'A blocking check rejects a label pointing at no capability, and a required capability that no test claims any more. It judges no result, because it runs on pull requests where no end-to-end report exists yet.',
  },
  {
    title: 'Measured at night, not on a feeling',
    body: 'A scheduled run re-measures the whole repository, writes the numbers to a committed snapshot, and a quality portal renders that snapshot. Nothing is re-run at render time: a deploy that measured again would give two truths for one commit.',
  },
  {
    title: 'Reviewed by another engine',
    body: 'A pull request is reviewed by an outside tool, never by a second instance of the same model, because two copies of one model share one blind spot. Review, fix, review again, until it asks for no further change.',
  },
  {
    title: 'A fix is proven by mutation',
    body: 'A finding is closed by a test that fails first. Then the fix is switched off on purpose, and the test has to go red. A test that stays green without the fix was never testing the fix.',
  },
];

export interface CiJob {
  readonly name: string;
  readonly body: string;
}

/** Source: .github/workflows/ci.yml, job by job. */
export const CI_JOBS: readonly CiJob[] = [
  {
    name: 'Linux',
    body: 'Typecheck, lint, format check, secret scan, commit hygiene, architecture check, the capability gate, unit tests, script tests, the bench, a dependency audit, and the build.',
  },
  { name: 'Windows', body: 'Typecheck and the unit suite again, on windows-latest.' },
  {
    name: 'Pack smoke',
    body: 'The real tarball is packed, installed into a clean directory, and booted. A published package that does not start is caught here, not by you.',
  },
  {
    name: 'End to end',
    body: 'The stack boots for real, then Playwright drives two journeys through the dashboard in a browser.',
  },
];

/* ── Section 05 ─────────────────────────────────────────────────────────── */

/** Source: apps/cli/package.json (version) and CHANGELOG.md (headline). */
export const VERSION = '0.8.9';
export const VERSION_DATE = 'September 2026';

/** Source: README.md, "On the roadmap". */
export const ROADMAP: readonly string[] = [
  'MCP over OAuth, which unlocks Linear, remote Notion, remote GitHub, Atlassian and Sentry.',
  'A dry-run meta-tool, so you can see what a self-extending agent would do before it does it.',
  'Bundled pgvector for semantic memory search. Today the fallback is keyword search.',
];

/* ── Links ──────────────────────────────────────────────────────────────── */

export const LINK_DOCS = `${BASE_PATH}/docs`;
export const LINK_GETTING_STARTED = `${BASE_PATH}/docs/getting-started`;
export const LINK_CHANGELOG = `${BASE_PATH}/docs/changelog`;
export const LINK_GITHUB = 'https://github.com/Kwintspiracy/nodal-agents';
export const LINK_NPM = 'https://www.npmjs.com/package/nodal-agents';
