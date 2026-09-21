import facts from '../lib/catalog-facts.json';
import measured from '../lib/measured-facts.json';

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

/**
 * Counts and slugs for every catalog the product ships, written by
 * `scripts/gen-reference.ts` on each build from the catalogs themselves. Typing
 * these by hand would have them wrong the first time someone adds a connector,
 * and a public page that miscounts the product is worse than one that says
 * nothing.
 */
export const CATALOG = facts;

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
  {
    id: 'what-it-plugs-into',
    index: '03',
    label: 'The catalog',
    title: 'Connectors, skills, tools',
  },
  { id: 'how-its-designed', index: '04', label: 'Product approach', title: 'How it is designed' },
  { id: 'how-its-built', index: '05', label: 'Engineering', title: 'How it is built' },
  { id: 'where-it-stands', index: '06', label: 'Status', title: 'Where it stands' },
];

/* ── Hero ───────────────────────────────────────────────────────────────── */

/**
 * The hero, word for word, from the redesign handed over on 2026-09-21
 * (`design/inbound/hero-redesign/Hero Redesigns.dc.html`).
 *
 * It sits here rather than inside `home.tsx` for the same reason as every other
 * block on this page: the copy is data, and a test reads it back out of the
 * rendered markup. The version printed on the pill is never typed: it is
 * `VERSION`, which is itself checked against `apps/cli/package.json`.
 */
export interface HeroPillar {
  readonly label: string;
  readonly body: string;
}

export interface HeroCopy {
  /** One line (owner, 2026-09-22): the design broke it after the first word. */
  readonly title: string;
  /** Two lines at the design width; the column is sized for that. */
  readonly lede: string;
  /**
   * The three things the product stands on, in place of the two buttons the
   * design carried (owner, 2026-09-22). Each is a claim the product keeps:
   * approvals and undo, the per-agent autonomy setting, the proof read back
   * from disk. Short on purpose: they sit in the hero, not in a section.
   */
  readonly pillars: readonly HeroPillar[];
  /** What follows the version on the pill, after a middle dot. */
  readonly pillSuffix: string;
  /** The shell name the design prints on the right of the terminal chrome. */
  readonly terminalTitle: string;
  readonly commands: readonly string[];
}

export const HERO: HeroCopy = {
  title: 'Herd your agents.',
  lede: 'Nodal orchestrates, monitors and keeps your autonomous agents in line, from the first command to production.',
  pillars: [
    {
      label: 'You stay in control',
      body: 'Approve, pause or undo any step. Nothing runs past you unless you let it.',
    },
    {
      label: 'Autonomy you dial',
      body: 'Per agent, from ask-before-anything to hands-off, and every setting in between.',
    },
    {
      label: 'Work that proves itself',
      body: 'What an agent delivers is read back from disk and checked, never taken on its word.',
    },
  ],
  pillSuffix: 'open source',
  terminalTitle: 'zsh',
  commands: ['npm install -g nodal-agents', 'nodal-agents up'],
};

/** The title over the two product captures under the hero (owner, 2026-09-22). */
export const SCREENS_TITLE = 'What it looks like';

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
    body: 'Anthropic, OpenAI, Google, Groq, Mistral, DeepSeek, MiniMax, Moonshot, OpenRouter, or a local model in Ollama, LM Studio, Jan, llama.cpp or vLLM. One key per provider, and each agent picks its own.',
  },
  {
    title: 'Your keys, your disk',
    body: 'Conversations, memory and credentials stay on the machine. Every credential is encrypted at rest with AES-256-GCM. You pay the provider directly, with nothing added on top.',
  },
  {
    title: 'Any surface',
    body: 'The dashboard chat, Telegram, Discord, Slack and WhatsApp. Approvals, images and files travel over all of them, with a fallback where a channel has no buttons.',
  },
  {
    title: 'Proof, not a claim',
    body: 'What a run wrote is read back from the disk, never taken from its own summary. In a git folder Nodal compares the status before and after each command, so a script that writes ten files without naming one still shows up, deletions included.',
  },
  {
    title: 'An undo you did not plan for',
    body: 'Before any tool that can change a folder, Nodal snapshots it into a store of its own, never into your git history. A snapshot it cannot take refuses the write. Restoring is a command you run, not a tool an agent can call.',
  },
];

/* ── Section 02 ─────────────────────────────────────────────────────────── */

/**
 * This section has been wrong twice. First it listed three use cases, which
 * read as the three things the product does. Then it kept two of them, which
 * read as a choice between two. The product has no list at all: it composes.
 * So the section leads with the grammar, and the examples that follow are
 * deliberately scattered across unrelated domains, one line each, in no order.
 *
 * Every example carries the catalog slugs it would use, and a test refuses a
 * slug that no catalog has. An example nobody could actually build is a lie
 * with a friendly face.
 */
export interface FormulaTerm {
  readonly term: string;
  readonly body: string;
}

export const FORMULA: readonly FormulaTerm[] = [
  {
    term: 'A channel',
    body: 'Where you say it and where the answer lands. The dashboard, Telegram, Discord, Slack, WhatsApp, a schedule, or a webhook from anything.',
  },
  {
    term: 'Connectors and servers',
    body: 'What the agent can reach. Your accounts through a connector, anything else through an MCP server, including ones you add.',
  },
  {
    term: 'Skills',
    body: 'How it goes about it. Written guidance it reads first, from the catalog, from the community, or written by you.',
  },
];

export const FORMULA_RESULT = 'whatever you asked for';

/**
 * Product capabilities an example may lean on that are not catalog rows.
 * Each one is named in README.md under "Available now" or "Event triggers".
 */
export const FEATURE_SLUGS: readonly string[] = [
  'telegram',
  'discord',
  'slack',
  'whatsapp',
  'dashboard',
  'cron',
  'webhook',
  'watcher',
  'approval',
  'claude-code',
];

export interface Example {
  readonly tag: string;
  readonly body: string;
  /** Catalog slugs or product features this would actually use. */
  readonly uses: readonly string[];
}

export const EXAMPLES: readonly Example[] = [
  {
    tag: 'Personal',
    body: 'Every Monday, turn last week of Gmail into a one-page brief in Notion.',
    uses: ['cron', 'gmail', 'notion'],
  },
  {
    tag: 'Work',
    body: 'Ask in Slack where a Linear project stands, and read the answer in the thread.',
    uses: ['slack', 'linear'],
  },
  {
    tag: 'Dev',
    body: 'On a webhook from your CI, read the Sentry error and open the issue that describes it.',
    uses: ['webhook', 'sentry', 'linear'],
  },
  {
    tag: 'Ops',
    body: 'Watch a Postgres table and message you the moment a number crosses a line.',
    uses: ['watcher', 'mcp-postgres', 'telegram'],
  },
  {
    tag: 'Content',
    body: 'Crawl a site every week and keep a spreadsheet of what changed on it.',
    uses: ['cron', 'firecrawl', 'google-sheets'],
  },
  {
    tag: 'Data',
    body: 'Turn an Airtable base into a formatted Excel workbook, on request.',
    uses: ['airtable', 'spreadsheet-editing'],
  },
  {
    tag: 'Research',
    body: 'Search the web, read the sources, and write a brief that cites them.',
    uses: ['tavily', 'citation-discipline', 'google-docs'],
  },
  {
    tag: 'Code',
    body: 'Hand a repository task to Claude Code on your own subscription, then read the diff.',
    uses: ['claude-code', 'mcp-github', 'code-task'],
  },
  {
    tag: 'Notes',
    body: 'File today into your Obsidian vault, link it to what it belongs with, archive the rest.',
    uses: ['obsidian'],
  },
  {
    tag: '3D',
    body: 'Drive Blender from a sentence and drop the render into your Drive.',
    uses: ['blender', 'google-drive'],
  },
  {
    tag: 'Shipping',
    body: 'Deploy a page to Cloudflare Workers, once you have approved it.',
    uses: ['cloudflare', 'approval'],
  },
  {
    tag: 'Money',
    body: 'Answer what came in last week, from Stripe, on WhatsApp.',
    uses: ['stripe', 'whatsapp'],
  },
];

/* ── Section 03 ─────────────────────────────────────────────────────────── */

/**
 * The icon wall. Each entry names a slug that must exist in
 * `lib/catalog-facts.json`, and a file that must exist in
 * `public/home/icons/`. Both are checked by the test, so an icon for something
 * the product does not actually ship cannot reach the page.
 *
 * The SVGs are copied unmodified from `apps/web/public/`, which is where the
 * dashboard reads them. They are brand marks: they are never recoloured, which
 * is why they sit on a tile that stays light in both themes rather than being
 * forced to `currentColor`.
 */
export interface CatalogIcon {
  /** Slug in the product catalog. */
  readonly slug: string;
  /** File name under `public/home/icons/`, without the extension. */
  readonly file: string;
  readonly label: string;
}

export const CONNECTOR_ICONS: readonly CatalogIcon[] = [
  { slug: 'notion', file: 'notion', label: 'Notion' },
  { slug: 'gmail', file: 'gmail', label: 'Gmail' },
  { slug: 'google-drive', file: 'google-drive', label: 'Google Drive' },
  { slug: 'google-calendar', file: 'google-calendar', label: 'Google Calendar' },
  { slug: 'google-sheets', file: 'google-sheets', label: 'Google Sheets' },
  { slug: 'google-docs', file: 'google-docs', label: 'Google Docs' },
  { slug: 'outlook-mail', file: 'outlook-mail', label: 'Outlook Mail' },
  { slug: 'airtable', file: 'airtable', label: 'Airtable' },
  { slug: 'cloudflare', file: 'cloudflare', label: 'Cloudflare' },
  { slug: 'firecrawl', file: 'firecrawl', label: 'Firecrawl' },
  { slug: 'tavily', file: 'tavily', label: 'Tavily' },
  { slug: 'apify', file: 'apify', label: 'Apify' },
];

export const MCP_ICONS: readonly CatalogIcon[] = [
  { slug: 'mcp-github', file: 'github', label: 'GitHub' },
  { slug: 'mcp-git', file: 'git', label: 'Git' },
  { slug: 'mcp-postgres', file: 'postgresql', label: 'PostgreSQL' },
  { slug: 'mcp-playwright', file: 'playwright', label: 'Playwright' },
  { slug: 'mcp-fetch', file: 'fetch', label: 'Fetch' },
  { slug: 'linear', file: 'linear', label: 'Linear' },
  { slug: 'sentry', file: 'sentry', label: 'Sentry' },
  { slug: 'stripe', file: 'stripe', label: 'Stripe' },
  { slug: 'supabase', file: 'supabase', label: 'Supabase' },
  { slug: 'n8n', file: 'n8n', label: 'n8n' },
  { slug: 'perplexity', file: 'perplexity', label: 'Perplexity' },
  { slug: 'blender', file: 'blender', label: 'Blender' },
  { slug: 'unity', file: 'unity', label: 'Unity' },
  { slug: 'unreal-engine', file: 'unreal-engine', label: 'Unreal Engine' },
  { slug: 'keyshot', file: 'keyshot', label: 'KeyShot' },
  { slug: 'photoshop', file: 'photoshop', label: 'Photoshop' },
];

/** Source: README.md, "Channels". The icons live in apps/web/public/channel-icons. */
export const CHANNEL_ICONS: readonly CatalogIcon[] = [
  { slug: 'telegram', file: 'telegram', label: 'Telegram' },
  { slug: 'discord', file: 'discord', label: 'Discord' },
  { slug: 'slack', file: 'slack', label: 'Slack' },
  { slug: 'whatsapp', file: 'whatsapp', label: 'WhatsApp' },
];

export interface Definition {
  readonly term: string;
  readonly body: string;
}

/** The three words the product uses, told apart in one line each. */
export const DEFINITIONS: readonly Definition[] = [
  {
    term: 'A connector',
    body: 'Access to a service you already use. You authorise it once, with OAuth or an API key, and the agent reaches your account inside it.',
  },
  {
    term: 'A skill',
    body: 'Know-how handed to an agent. A written page it reads before working, telling it how to do a thing well rather than what it is allowed to touch.',
  },
  {
    term: 'A tool',
    body: 'A single action an agent executes: send this mail, run this command, write this file. Every tool is listed per agent, and the risky ones stop for your approval.',
  },
];

/** Counts, straight out of `lib/catalog-facts.json`. */
export const CATALOG_FIGURES: readonly Figure[] = [
  { value: String(CATALOG.connectors), label: 'connectors in the catalog' },
  { value: String(CATALOG.connectorTools), label: 'connector tools' },
  { value: String(CATALOG.mcpServers), label: 'MCP servers in the catalog' },
  { value: String(CATALOG.systemSkills), label: 'system skills' },
  { value: String(CATALOG.builtinTools), label: 'built-in tools' },
  { value: String(CATALOG.models), label: 'models pre-configured' },
];

/* ── Section 04 ─────────────────────────────────────────────────────────── */

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
    title: 'You land in a conversation, not a form',
    body: 'Nodal opens on an empty thread. You say what you want, and no row is written until your first message lands. A run that came from a schedule, the CLI or another tool gets its own page rather than a thread it never had.',
  },
  {
    title: 'A project is a folder you open',
    body: 'Its page is one list of everything that happened in it, conversations and runs together, with the folder docked beside it: what recent runs wrote, and the commands that proved it works. Nodal offers to run git init and never does it behind your back.',
  },
  {
    title: 'An agent is a row, not a file',
    body: 'Personality, skills, connectors, memory budget and team assignments all live in Postgres. The runtime carries no agent name. Adding a capability inserts rows, it does not edit code.',
  },
  {
    title: 'Guards against running away',
    body: 'A token budget and a cost ceiling per job on every provider, a no-progress detector, an atomic job claim so the same job never runs twice, and hard caps on chained resumes, tool calls and delegation depth.',
  },
  {
    title: 'Guards against a false win',
    body: 'A run that failed is never reported as done. Every failed job keeps its transcript, the real upstream error and a short specific reason, propagated back up through delegation. A reviewer verdict is a typed record, never the first line of its prose.',
  },
  {
    title: 'The agent says how to check its own work',
    body: 'When it finishes it declares the commands it already ran to check itself: a build, a test suite, a request against a server it started. Nodal runs them in order and records each exit code with its output. A proof whose project changed since is marked stale, not green.',
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

/**
 * The four records a run leaves behind, one line each.
 *
 * Source: `apps/docs/content/docs/concepts/proof.mdx`, which is itself written
 * against the runtime. They are four and not one on purpose: "it wrote these
 * files", "this command says it works", "a reviewer read it" and "here is the
 * folder before it started" are four different questions, and a product that
 * answers them with a single green tick is answering none of them.
 */
export const PROOF_RECORDS: readonly Definition[] = [
  {
    term: 'What it wrote',
    body: 'The files the run really changed, read back from the disk. In a repository each one carries the word git itself used: added, modified, deleted or renamed. Outside one, only files a tool named are credited, and the page says so rather than showing an empty list.',
  },
  {
    term: 'What proves it works',
    body: 'The commands the agent declared when it finished, run in order, each with its exit code and its output. The project turns green or red with the command that decided it. Declaring is gated by approval exactly like running.',
  },
  {
    term: 'What a second agent found',
    body: 'The verdict a reviewer recorded: approved, or changes requested with a count per severity. The commands the reviewer itself ran are kept as proof of the work it read. A second review of an unchanged target is refused rather than paid for.',
  },
  {
    term: 'What it looked like before',
    body: 'A snapshot of every workspace the agent holds, taken before anything could write, in a shadow store and never in your own history. When the snapshot cannot be taken the write is refused, with a typed code and the figures measured right then.',
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

/* ── Section 05 ─────────────────────────────────────────────────────────── */

export interface Figure {
  readonly value: string;
  readonly label: string;
}

/**
 * Every figure below comes from `lib/measured-facts.json`, derived on each build
 * from `apps/qa/data/snapshot.json` — the nightly measurement
 * (`.github/workflows/qa.yml`) — by `scripts/gen-reference.ts`.
 *
 * They were transcribed by hand until issue #109. The nightly rewrites the
 * snapshot with `[skip ci]`, so the constants went stale the moment it ran, and
 * the next pull request opened inherited a red check for a drift it had not
 * caused. A figure typed by hand is a figure that goes stale; there is one
 * source now, and a snapshot missing a figure fails the build by name.
 *
 * The measurement date is printed next to the table: a number without its
 * measurement date is a number nobody can check.
 */
export const MEASURED_ON = measured.measuredOn;
export const MEASURED_COMMIT = measured.commit;
export const MEASURED_RUN_URL = measured.runUrl;
export const CAPABILITIES = measured.capabilities;
export const CAPABILITIES_VERIFIED = measured.capabilitiesVerified;

export const FIGURES: readonly Figure[] = measured.figures;

export interface Practice {
  readonly title: string;
  readonly body: string;
}

/**
 * Source: CLAUDE.md ("Tests gates per brique", the `@cap:` label, the Codex
 * review rule) and `.github/workflows/ci.yml` / `qa.yml` / `docs.yml`.
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
    body: 'A pull request is reviewed by an outside tool, never by a second instance of the same model, because two copies of one model share one blind spot. Review, fix, review again, until a pass comes back with nothing blocking and nothing important. Four passes at most: a request still blocked on the fourth has a shape problem, not a bug.',
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
    name: 'Checks',
    body: 'Typecheck, lint, format check, secret scan, commit hygiene, architecture check, the capability gate, script tests, the bench, and a dependency audit.',
  },
  {
    name: 'Unit tests',
    body: 'The whole suite in five parallel slices: the dashboard and the runner each cut in two by file, and every other package together.',
  },
  {
    name: 'Build',
    body: 'The production build on its own, so a broken build and a slow suite are two different red marks.',
  },
  {
    name: 'Windows',
    body: 'Typecheck and the unit suite again, on windows-latest, on every merge to main and every night.',
  },
  {
    name: 'Pack smoke',
    body: 'The real tarball is packed, installed into a clean directory, and booted. A published package that does not start is caught here, not by you.',
  },
  {
    name: 'End to end',
    body: 'The stack boots for real, then Playwright drives five journeys through the dashboard in a browser: navigation, the autonomy tab, delegation outcomes, memory, and the runs list.',
  },
];

/* ── Section 06 ─────────────────────────────────────────────────────────── */

/** Source: apps/cli/package.json (version) and CHANGELOG.md (headline). */
export const VERSION = '0.9.1';
export const VERSION_DATE = 'September 2026';

/** Source: README.md, "On the roadmap". */
export const ROADMAP: readonly string[] = [
  'MCP over OAuth, which unlocks Linear, remote Notion, remote GitHub, Atlassian and Sentry.',
  'A dry-run meta-tool, so you can see what a self-extending agent would do before it does it.',
  'Bundled pgvector for semantic memory search. Today the fallback is keyword search.',
];

/* ── Links ──────────────────────────────────────────────────────────────── */

export const LINK_DOCS = `${BASE_PATH}/docs`;
/** Where "Get started" lands: the install page, not the docs index. */
export const LINK_START = `${BASE_PATH}/docs/getting-started`;
/**
 * The quality portal, published under `/qa/` by the same workflow that
 * publishes these docs. It is a standalone HTML document, not a route of this
 * site, so it is linked by path and never with `next/link`.
 */
export const LINK_QA = `${BASE_PATH}/qa/`;
export const LINK_CHANGELOG = `${BASE_PATH}/docs/changelog`;
export const LINK_GITHUB = 'https://github.com/Kwintspiracy/nodal-agents';
export const LINK_NPM = 'https://www.npmjs.com/package/nodal-agents';
