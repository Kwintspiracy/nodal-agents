import measured from '../lib/measured-facts.json';

/**
 * Everything the homepage states, in one place.
 *
 * Rewritten on 2026-09-24 at the owner's request: the page tells where the
 * project comes from and what it is for, and measures what it claims. It is a
 * personal exploration used by one person, nothing in it has been run at
 * scale, and the page says so instead of selling it. The design (the hero
 * band and its illustration, the typography, the section layout) is kept.
 *
 * Two reasons this is data and not JSX:
 *
 *  1. Every claim on a public page has to be traceable. Each measured figure
 *     comes from the nightly measurement, with its date and commit, and a test
 *     refuses a page that prints numbers of its own.
 *  2. The section titles and every copy block are asserted by
 *     `homepage.test.tsx` against the rendered markup, so "the page says this"
 *     is a fact and not a hope.
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
  /** The sentence each section opens on, in the display face with the accent bar. */
  readonly claim: string;
}

/** The section anchors, in page order. Asserted against the rendered markup. */
export const SECTIONS: readonly Section[] = [
  {
    id: 'starting-point',
    index: '01',
    label: 'The starting point',
    title: 'A question that became a working harness',
    claim: 'It started with questions about the agent tools I was already using.',
  },
  {
    id: 'the-questions',
    index: '02',
    label: 'The questions',
    title: 'What I am trying to understand',
    claim:
      'The harness lets me experiment with the mechanics behind an agent’s behaviour. These are the questions I keep coming back to.',
  },
  {
    id: 'the-harness',
    index: '03',
    label: 'The harness today',
    title: 'A place to put those questions to work',
    claim:
      'Nodal runs on your machine and connects to the models and tools you choose. This is what the working project looks like today.',
  },
  {
    id: 'building-and-checking',
    index: '04',
    label: 'Building and checking',
    title: 'The experiment includes how I build it',
    claim:
      'Claude handles the main development work, with ChatGPT as a reviewer. I use this setup to turn questions into changes I can try in the harness.',
  },
  {
    id: 'try-it',
    index: '05',
    label: 'Try it and compare notes',
    title: 'Curious? Take a closer look',
    claim:
      'You can run Nodal locally and explore the current implementation. The documentation covers setup and configuration.',
  },
];

/* ── Hero ───────────────────────────────────────────────────────────────── */

export interface HeroPillar {
  readonly label: string;
  readonly body: string;
}

export interface HeroCopy {
  /** One line (owner, 2026-09-22). */
  readonly title: string;
  readonly lede: string;
  /**
   * Three plain facts in the place of the design's buttons: when it started,
   * who builds it, who uses it. No claim about what it achieves.
   */
  readonly pillars: readonly HeroPillar[];
  /** What follows the version on the pill, after a middle dot. */
  readonly pillSuffix: string;
  /** The shell name the design prints on the right of the terminal chrome. */
  readonly terminalTitle: string;
  readonly commands: readonly string[];
}

export const HERO: HeroCopy = {
  title: 'Understanding agents by building with them.',
  lede: 'I wanted to understand how agent harnesses work, and why they work the way they do. So I started building one.',
  pillars: [
    {
      label: 'Since April 2026',
      body: 'A personal project that started as a question and kept growing.',
    },
    {
      label: 'Claude builds, ChatGPT reviews',
      body: 'I am not a developer. Claude writes most of the code, ChatGPT reviews it, and I decide what goes in.',
    },
    {
      label: 'One user so far',
      body: 'I use it for my own tasks. Nothing here has been tried at scale.',
    },
  ],
  pillSuffix: 'an ongoing exploration',
  terminalTitle: 'zsh',
  commands: ['npm install -g nodal-agents', 'nodal-agents up'],
};

/** The title over the two product captures under the hero. */
export const SCREENS_TITLE = 'What it looks like today';

/* ── 01 The starting point ──────────────────────────────────────────────── */

export const AUTHOR =
  'Quentin Beau · User Experience Expert · Exploring agentic systems through practice';

/** The story, in the owner's words (handed over on 2026-09-24). */
export const STORY: readonly string[] = [
  'Working on agentic systems, I wanted to get closer to the decisions behind the tools we use. How do agents share work? What gives them permission to act? What happens when something goes wrong?',
  'In April 2026, I started building a small harness to explore those questions, with Claude as the main developer and ChatGPT as a reviewer. I am not a developer, though I have a solid understanding of software development methods.',
  'The project kept growing. Today, I use Nodal for some everyday tasks, to try different models, and to test other ways of coordinating agents. It gives me somewhere to change an approach and see how it behaves in practice.',
];

/* ── 02 The questions ───────────────────────────────────────────────────── */

export interface Question {
  readonly title: string;
  readonly question: string;
  readonly test: string;
}

export const QUESTIONS: readonly Question[] = [
  {
    title: 'How should agents share the work?',
    question:
      'When does it help to hand a task to a specialist? When does splitting it across several agents add more coordination than value?',
    test: 'Route a request to one agent, or distribute work across several. Follow the child tasks and how their results return to the orchestrator.',
  },
  {
    title: 'Where should autonomy begin and end?',
    question:
      'Which decisions can an agent take on its own? When is an approval useful, and what information helps someone make that decision?',
    test: 'Set autonomy and tool access per agent. Try approval steps that explain the intended action and its impact, with limits on execution.',
  },
  {
    title: 'What do I need to see to follow the work?',
    question:
      'How can I tell what happened, what changed, and what still needs checking? What should be visible when an agent reports that it has finished?',
    test: 'Inspect run histories, changed files, verification output and reviewer findings as separate records. Trace errors through delegated tasks.',
  },
  {
    title: 'What changes when the model or context changes?',
    question:
      'How much of an outcome comes from the model, its instructions, the tools it can reach, or the information it remembers?',
    test: 'Choose different models per agent, assign skills and connectors, and work with persistent memory across tasks.',
  },
];

export const QUESTIONS_NOTE =
  'These are areas of exploration, not results. My own use gives me observations to discuss and approaches to keep testing.';

/* ── 03 The harness today ───────────────────────────────────────────────── */

export interface Point {
  readonly title: string;
  readonly body: string;
}

export const HARNESS_POINTS: readonly Point[] = [
  {
    title: 'Different agents, different setups',
    body: 'Each agent can have its own model, tools, skills and memory settings. Tasks can be delegated to other agents.',
  },
  {
    title: 'Real tasks and connected tools',
    body: 'Try research, document work or repository tasks through the dashboard, messaging channels, schedules and webhooks.',
  },
  {
    title: 'Visibility and ways to intervene',
    body: 'Inspect execution records, configure approvals and limits, and use workspace snapshots to recover earlier file states.',
  },
];

export interface Definition {
  readonly term: string;
  readonly body: string;
}

/** The building blocks, one line each. Source: README.md and the docs. */
export const BUILDING_BLOCKS: readonly Definition[] = [
  {
    term: 'Models',
    body: 'Hosted providers including Anthropic, OpenAI, Google and OpenRouter, plus local models through tools such as Ollama and LM Studio.',
  },
  {
    term: 'Tools and context',
    body: 'Connectors for services such as Gmail, Notion and Google Drive. MCP servers extend access to other tools. Skills provide written guidance.',
  },
  {
    term: 'Ways to interact',
    body: 'The dashboard, Telegram, Discord, Slack and WhatsApp. Tasks can also start from a schedule or a webhook.',
  },
];

/* ── 04 Building and checking ───────────────────────────────────────────── */

export interface Figure {
  readonly value: string;
  readonly label: string;
}

/**
 * Every figure below comes from `lib/measured-facts.json`, derived on each build
 * from `apps/qa/data/snapshot.json` — the nightly measurement
 * (`.github/workflows/qa.yml`) — by `scripts/gen-reference.ts`. A figure typed
 * by hand goes stale; there is one source, and a snapshot missing a figure
 * fails the build by name. The measurement date is printed next to them.
 */
export const MEASURED_ON = measured.measuredOn;
export const MEASURED_COMMIT = measured.commit;
export const MEASURED_RUN_URL = measured.runUrl;
export const CAPABILITIES = measured.capabilities;
export const CAPABILITIES_VERIFIED = measured.capabilitiesVerified;

export const FIGURES: readonly Figure[] = measured.figures;

export const PRACTICES: readonly Point[] = [
  {
    title: 'Keep changes inspectable',
    body: 'Development happens through small pull requests, with automated checks and review.',
  },
  {
    title: 'Check what actually happened',
    body: 'The harness keeps file changes, verification output and reviewer findings available to inspect.',
  },
  {
    title: 'Make room for another perspective',
    body: 'Sharing the project is a way to get feedback on the choices, discover different use cases and compare approaches.',
  },
];

export const STATUS: readonly Definition[] = [
  {
    term: 'Where it stands',
    body: 'A working project used for personal tasks and ongoing experiments. It continues to change, and updates can include breaking changes.',
  },
  {
    term: 'Where the exploration continues',
    body: 'Different models, new use cases, and ways to make delegation, autonomy and control work together. Other people’s experiences are part of what I want to learn from next.',
  },
];

/** Source: apps/cli/package.json (version). */
export const VERSION = '0.9.3';
export const VERSION_DATE = 'September 2026';

/* ── 05 Try it and compare notes ────────────────────────────────────────── */

export const TRY_NOTE =
  'Requires Node.js 22 or later. Connect your own model provider or a local model. Provider usage may incur costs.';

export const FEEDBACK: readonly string[] = [
  'Maybe you’ve tried another way of handling approvals. Maybe delegation worked differently from what you expected. Or perhaps there’s a task you’d like to explore with it.',
  'That’s why I’m sharing the project: to get other perspectives on something I’ve mostly been exploring through my own use. An issue is a good place for a concrete observation, a question or an idea to explore.',
];

/* ── Links ──────────────────────────────────────────────────────────────── */

export const LINK_DOCS = `${BASE_PATH}/docs`;
/** Where "Read the setup guide" lands: the install page, not the docs index. */
export const LINK_START = `${BASE_PATH}/docs/getting-started`;
/**
 * The quality portal, published under `/qa/` by the same workflow that
 * publishes these docs. It is a standalone HTML document, not a route of this
 * site, so it is linked by path and never with `next/link`.
 */
export const LINK_QA = `${BASE_PATH}/qa/`;
export const LINK_CHANGELOG = `${BASE_PATH}/docs/changelog`;
export const LINK_GITHUB = 'https://github.com/Kwintspiracy/nodal-agents';
export const LINK_ISSUES = 'https://github.com/Kwintspiracy/nodal-agents/issues';
export const LINK_NPM = 'https://www.npmjs.com/package/nodal-agents';
