/**
 * The public homepage of Nodal-Agents.
 *
 * Kept free of `next/link`, `next/image` and `next/font` on purpose: the site is
 * a static export, so those would only add the basePath prefix, which
 * `home-content.ts` owns explicitly. In exchange the whole page renders under
 * `react-dom/server` inside a plain unit test, which is what makes
 * `home-content.test.ts` able to assert that every section is really on it.
 */

import {
  BASE_PATH,
  CATALOG,
  CATALOG_FIGURES,
  CHANNEL_ICONS,
  CONNECTOR_ICONS,
  DEFINITIONS,
  EXAMPLES,
  FORMULA,
  FORMULA_RESULT,
  MCP_ICONS,
  CI_JOBS,
  FIGURES,
  INVARIANTS,
  LINK_CHANGELOG,
  LINK_DOCS,
  LINK_GETTING_STARTED,
  LINK_GITHUB,
  LINK_NPM,
  LINK_QA,
  MEASURED_COMMIT,
  MEASURED_ON,
  MEASURED_RUN_URL,
  PILLARS,
  PRACTICES,
  PRINCIPLES,
  ROADMAP,
  SECTIONS,
  VERSION,
  VERSION_DATE,
} from './home-content';

function Rail({ index, label }: { index: string; label: string }) {
  return (
    <div className="home-rail">
      <span className="n">{index}</span>
      <span className="home-mono">{label}</span>
    </div>
  );
}

/**
 * Orchestrator to agents to tools to memory, drawn by hand rather than
 * generated: the point is the four boxes and who talks to whom, and a generated
 * graph spends its pixels on everything else.
 */
function FlowDiagram() {
  const box = { fill: 'var(--home-sunk)', stroke: 'var(--home-line)', strokeWidth: 1, rx: 4 };
  const line = { stroke: 'var(--home-line)', strokeWidth: 1.5, fill: 'none' };
  return (
    <svg viewBox="0 0 900 250" role="img" aria-labelledby="flow-title">
      <title id="flow-title">
        A message arrives from a channel, the runner turns it into a job, and the job reaches the
        model, the tools and the database.
      </title>
      <defs>
        <marker
          id="home-arrow"
          viewBox="0 0 8 8"
          refX="7"
          refY="4"
          markerWidth="7"
          markerHeight="7"
          orient="auto"
        >
          <path d="M0 0 L8 4 L0 8 z" fill="var(--home-ink-soft)" />
        </marker>
      </defs>
      <g style={{ color: 'var(--home-ink)' }} fontFamily="var(--font-jbmono), monospace">
        {/* Channel */}
        <rect x="8" y="78" width="150" height="86" {...box} />
        <text x="26" y="106" fontSize="13" fill="currentColor">
          Channel
        </text>
        <text x="26" y="128" fontSize="11" fill="var(--home-ink-soft)">
          dashboard, Telegram,
        </text>
        <text x="26" y="144" fontSize="11" fill="var(--home-ink-soft)">
          Discord, Slack, WhatsApp
        </text>

        <path d="M158 121 L212 121" {...line} markerEnd="url(#home-arrow)" />

        {/* Runner */}
        <rect x="218" y="36" width="256" height="170" {...box} stroke="var(--home-flame)" />
        <text x="238" y="66" fontSize="13" fill="currentColor">
          Runner
        </text>
        <text x="238" y="94" fontSize="11" fill="var(--home-ink-soft)">
          job queue and executor
        </text>
        <text x="238" y="114" fontSize="11" fill="var(--home-ink-soft)">
          runaway guards
        </text>
        <text x="238" y="134" fontSize="11" fill="var(--home-ink-soft)">
          tool whitelist per agent
        </text>
        <text x="238" y="154" fontSize="11" fill="var(--home-ink-soft)">
          memory injection
        </text>
        <text x="238" y="174" fontSize="11" fill="var(--home-ink-soft)">
          delegation to sub-agents
        </text>

        <path d="M474 74 L560 44" {...line} markerEnd="url(#home-arrow)" />
        <path d="M474 121 L560 121" {...line} markerEnd="url(#home-arrow)" />
        <path d="M474 168 L560 198" {...line} markerEnd="url(#home-arrow)" />
        <path d="M566 190 L480 162" {...line} markerEnd="url(#home-arrow)" />

        {/* Model */}
        <rect x="566" y="18" width="320" height="56" {...box} />
        <text x="586" y="42" fontSize="13" fill="currentColor">
          Model
        </text>
        <text x="586" y="60" fontSize="11" fill="var(--home-ink-soft)">
          one per agent, with a failover chain
        </text>

        {/* Tools */}
        <rect x="566" y="94" width="320" height="56" {...box} />
        <text x="586" y="118" fontSize="13" fill="currentColor">
          Tools, connectors, MCP servers
        </text>
        <text x="586" y="136" fontSize="11" fill="var(--home-ink-soft)">
          approval-gated when the tool is risky
        </text>

        {/* DB */}
        <rect x="566" y="170" width="320" height="62" {...box} />
        <text x="586" y="194" fontSize="13" fill="currentColor">
          Postgres, embedded
        </text>
        <text x="586" y="212" fontSize="11" fill="var(--home-ink-soft)">
          agents, jobs, transcripts, memory
        </text>
        <text x="586" y="226" fontSize="11" fill="var(--home-ink-soft)">
          all of it on your disk
        </text>
      </g>
    </svg>
  );
}

function IconWall({
  title,
  items,
  more,
  note,
}: {
  title: string;
  items: readonly { slug: string; file: string; label: string }[];
  /** How many catalog entries are not shown. Zero means the grid IS the list. */
  more: number;
  note: string;
}) {
  return (
    <div className="home-wall">
      <p className="home-mono">{title}</p>
      <ul>
        {items.map((i) => (
          <li key={i.slug}>
            <img
              src={`${BASE_PATH}/home/icons/${i.file}.svg`}
              width={28}
              height={28}
              alt=""
              loading="lazy"
              decoding="async"
            />
            <span>{i.label}</span>
          </li>
        ))}
        {more > 0 ? (
          <li className="home-wall-more">
            <span>+ {more} more</span>
          </li>
        ) : null}
      </ul>
      <p className="home-wall-note">{note}</p>
    </div>
  );
}

export default function Home() {
  const [s1, s2, s3, s4, s5, s6] = SECTIONS;

  return (
    <main className="home">
      <header className="home-bar">
        <div className="home-wrap home-bar-inner">
          <a className="home-mark" href={`${BASE_PATH}/`}>
            <span className="home-mark-dot" aria-hidden="true" />
            Nodal-Agents
          </a>
          <nav className="home-bar-nav" aria-label="Main">
            <a href={LINK_DOCS}>Docs</a>
            <a href={LINK_QA}>Quality</a>
            <a href={LINK_CHANGELOG}>Changelog</a>
            <a href={LINK_GITHUB}>GitHub</a>
          </nav>
        </div>
      </header>

      {/* ── Hero ─────────────────────────────────────────────────────── */}
      <div className="home-wrap home-hero">
        <div>
          <p className="home-mono">Self-hosted agent platform · v{VERSION}</p>
          <h1 className="home-display">
            Your AI agents. Your data. <em>Your machine.</em>
          </h1>
          <p className="home-lead">
            Nodal-Agents runs a team of AI agents on your own hardware. Each one has its own model,
            tools, memory and personality. They research, write files, call your connectors, and
            hand work to each other until the job is done.
          </p>
          <div className="home-actions">
            <a className="home-btn home-btn-primary" href={LINK_GETTING_STARTED}>
              Get started
            </a>
            <a className="home-btn home-btn-ghost" href={LINK_GITHUB}>
              View the source
            </a>
          </div>
        </div>
        <aside className="home-hero-aside">
          <div className="home-install">
            <div>
              <span className="p">$ </span>
              <span className="c">npm install -g nodal-agents</span>
            </div>
            <div>
              <span className="p">$ </span>
              <span className="c">nodal-agents up</span>
            </div>
          </div>
          <p className="home-install-note">
            Node 22 or newer. No config file, no account, nothing to answer in the terminal. Your
            browser opens on a guided setup. Data lives in <code>~/.nodalai</code>.
          </p>
        </aside>
      </div>

      <div className="home-wrap home-screens">
        <figure className="home-shot">
          <img
            src={`${BASE_PATH}/home/dashboard-light.webp`}
            width={1393}
            height={1040}
            alt="The Nodal-Agents dashboard home in the light theme, showing agent, skill and connector counts, job totals, weekly activity and a per-agent token table."
            loading="lazy"
            decoding="async"
          />
          <figcaption>The dashboard, light theme.</figcaption>
        </figure>
        <figure className="home-shot">
          <img
            src={`${BASE_PATH}/home/agent-dark.webp`}
            width={1383}
            height={800}
            alt="An agent detail page in the dark theme, showing its model, role, skill and connector counts, success rate, and a chart of its runs over seven days."
            loading="lazy"
            decoding="async"
          />
          <figcaption>One agent, dark theme.</figcaption>
        </figure>
      </div>

      {/* ── 01 What it is ────────────────────────────────────────────── */}
      <section className="home-wrap home-section" id={s1.id}>
        <Rail index={s1.index} label={s1.label} />
        <div>
          <h2 className="home-display">{s1.title}</h2>
          <p className="home-intro">
            A platform you install, not a service you sign up for. It brings its own database, its
            own dashboard and its own runner, and it talks to whichever model you already pay for.
          </p>
          <div className="home-grid-2">
            {PILLARS.map((p) => (
              <article className="home-block" key={p.title}>
                <h3>{p.title}</h3>
                <p>{p.body}</p>
              </article>
            ))}
          </div>
        </div>
      </section>

      {/* ── 02 What you can build ────────────────────────────────────── */}
      <section className="home-wrap home-section" id={s2.id}>
        <Rail index={s2.index} label={s2.label} />
        <div>
          <h2 className="home-display">{s2.title}</h2>
          <p className="home-claim">
            There is no list of supported use cases, because there is no list. The product composes,
            and you pick the parts.
          </p>

          <div className="home-formula">
            {FORMULA.map((f, n) => (
              <div className="home-formula-term" key={f.term}>
                <span className="home-formula-op" aria-hidden="true">
                  {n === 0 ? '' : '×'}
                </span>
                <h3>{f.term}</h3>
                <p>{f.body}</p>
              </div>
            ))}
            <p className="home-formula-out">
              <span aria-hidden="true">=</span> {FORMULA_RESULT}
            </p>
          </div>

          <p className="home-mono home-examples-label">
            A dozen of them, in no order, out of everything the parts allow
          </p>
          <ul className="home-examples">
            {EXAMPLES.map((e) => (
              <li key={e.body}>
                <span className="home-mono">{e.tag}</span>
                <p>{e.body}</p>
              </li>
            ))}
          </ul>
          <p className="home-figures-note">
            Each of these uses connectors, servers, skills and channels that are in the catalog
            today. None of them needed a line of code written for it.
          </p>
        </div>
      </section>

      {/* ── 03 Connectors, skills, tools ─────────────────────────────── */}
      <section className="home-wrap home-section" id={s3.id}>
        <Rail index={s3.index} label={s3.label} />
        <div>
          <h2 className="home-display">{s3.title}</h2>
          <p className="home-intro">
            Three words the product keeps apart, because they are three different decisions you make
            about one agent.
          </p>
          <dl className="home-defs">
            {DEFINITIONS.map((d) => (
              <div key={d.term}>
                <dt>{d.term}</dt>
                <dd>{d.body}</dd>
              </div>
            ))}
          </dl>

          <div className="home-figures">
            {CATALOG_FIGURES.map((f) => (
              <div className="home-figure" key={f.label}>
                <span className="v">{f.value}</span>
                <span className="l">{f.label}</span>
              </div>
            ))}
          </div>
          <p className="home-figures-note">
            Counted from the catalogs themselves at build time, not typed by hand. You can also run
            several instances of one connector side by side, a personal Gmail and a work Gmail on
            the same install, each with its own credential.
          </p>

          <IconWall
            title="Connectors"
            items={CONNECTOR_ICONS}
            more={CATALOG.connectors - CONNECTOR_ICONS.length}
            note="You cannot add a connector type yourself. Anything outside this catalog is reached through an MCP server instead, which is the same access with one more hop."
          />
          <IconWall
            title="MCP servers"
            items={MCP_ICONS}
            more={CATALOG.mcpPreconfigured - MCP_ICONS.length}
            note="You can add your own, over HTTP or as a local process, and its secrets are encrypted at rest like every other credential."
          />
          <IconWall
            title="Channels"
            items={CHANNEL_ICONS}
            more={0}
            note="All four, plus the dashboard chat. Approvals, images and files travel over every one of them."
          />
          <p className="home-figures-note">
            Skills are the open end. {CATALOG.systemSkills} ship with the product, you can install
            any community skill file, and an agent can write itself a new one after a job it did
            well.
          </p>
        </div>
      </section>

      {/* ── 04 How it is designed ────────────────────────────────────── */}
      <section className="home-wrap home-section" id={s4.id}>
        <Rail index={s4.index} label={s4.label} />
        <div>
          <h2 className="home-display">{s4.title}</h2>
          <p className="home-intro">
            The hard part of an agent platform is not calling a model. It is what happens when a run
            loops, lies, or stops without saying so. These are the decisions that shape the product.
          </p>

          <div className="home-grid-2">
            {PRINCIPLES.map((p) => (
              <article className="home-block" key={p.title}>
                <h3>{p.title}</h3>
                <p>{p.body}</p>
              </article>
            ))}
          </div>

          <figure className="home-diagram">
            <FlowDiagram />
            <figcaption>
              A message becomes a job row. The runner loads the thread, injects the memories that
              match the task, calls the model, runs the tool calls it emits, and writes everything
              back. A delegation opens a child job that resumes its parent when it finishes.
            </figcaption>
          </figure>

          <div className="home-invariants">
            <p className="home-mono">Non-negotiable</p>
            <h3>Ten rules the code is not allowed to break</h3>
            <p>
              They are not style preferences. Most of them are enforced by tests that run on every
              pull request, and the rest by review.
            </p>
            <ol>
              {INVARIANTS.map((i) => (
                <li key={i.n}>
                  <b>{String(i.n).padStart(2, '0')}</b>
                  <span>{i.text}</span>
                </li>
              ))}
            </ol>
          </div>
        </div>
      </section>

      {/* ── 05 How it is built ───────────────────────────────────────── */}
      <section className="home-wrap home-section" id={s5.id}>
        <Rail index={s5.index} label={s5.label} />
        <div>
          <h2 className="home-display">{s5.title}</h2>
          <p className="home-intro">
            A TypeScript monorepo in strict mode, shipped in small pull requests, each one gated by
            the same checks. The numbers below are measured, not estimated.
          </p>

          <div className="home-figures">
            {FIGURES.map((f) => (
              <div className="home-figure" key={f.label}>
                <span className="v">{f.value}</span>
                <span className="l">{f.label}</span>
              </div>
            ))}
          </div>
          <p className="home-figures-note">
            Measured by the nightly run on {MEASURED_ON}, commit {MEASURED_COMMIT}.{' '}
            <a href={MEASURED_RUN_URL}>See the run</a>. Twelve of the twenty-four capabilities are
            green at both levels today. The other twelve are missing one level, and the page that
            tracks them says so in grey rather than in green.
          </p>

          <ol className="home-steps">
            {PRACTICES.map((p) => (
              <li key={p.title}>
                <div>
                  <h3>{p.title}</h3>
                  <p>{p.body}</p>
                </div>
              </li>
            ))}
          </ol>

          <div className="home-portal">
            <div>
              <p className="home-mono">Open to anyone</p>
              <h3>The quality portal</h3>
              <p>
                Everything on this page is a summary of one public document. The portal shows the
                measurement itself: every capability and what proves it, the journeys and which ones
                the last run played, the tests that broke or went flaky, the bench, and the work in
                flight read from the issues and pull requests. What is not measured is shown as not
                measured, never as zero and never as green.
              </p>
            </div>
            <a className="home-btn home-btn-primary" href={LINK_QA}>
              Open the portal
            </a>
          </div>

          <p className="home-mono" style={{ marginTop: '48px' }}>
            Every pull request
          </p>
          <dl className="home-ci">
            {CI_JOBS.map((j) => (
              <div className="home-ci-row" key={j.name}>
                <dt>{j.name}</dt>
                <dd>{j.body}</dd>
              </div>
            ))}
          </dl>
        </div>
      </section>

      {/* ── 06 Where it stands ───────────────────────────────────────── */}
      <section className="home-wrap home-section" id={s6.id}>
        <Rail index={s6.index} label={s6.label} />
        <div>
          <h2 className="home-display">{s6.title}</h2>
          <p className="home-intro">
            Used daily by its maintainer and stable enough for personal production. Still pre-1.0,
            so a minor version can carry a breaking change. Upgrading in place keeps your data.
          </p>
          <div className="home-status">
            <span className="home-version">{VERSION}</span>
            <span className="home-mono">latest on npm · {VERSION_DATE}</span>
          </div>
          <div className="home-actions">
            <a className="home-btn home-btn-ghost" href={LINK_CHANGELOG}>
              Read the changelog
            </a>
            <a className="home-btn home-btn-ghost" href={LINK_NPM}>
              nodal-agents on npm
            </a>
          </div>
          <p className="home-mono" style={{ marginTop: '48px' }}>
            Next
          </p>
          <ul className="home-roadmap">
            {ROADMAP.map((r) => (
              <li key={r}>{r}</li>
            ))}
          </ul>
        </div>
      </section>

      <footer className="home-wrap home-footer">
        <span>Nodal-Agents · self-hosted, pre-1.0.</span>
        <nav aria-label="Footer">
          <a href={LINK_DOCS}>Docs</a>
          <a href={LINK_CHANGELOG}>Changelog</a>
          <a href={LINK_NPM}>npm</a>
          <a href={LINK_GITHUB}>GitHub</a>
        </nav>
      </footer>
    </main>
  );
}
