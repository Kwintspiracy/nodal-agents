/**
 * The public homepage of Nodal-Agents.
 *
 * Rewritten on 2026-09-24 (owner's request): the story of the project and the
 * questions it explores, measured in what it claims, on the same design (the
 * hero band and its illustration, the typography, the section layout).
 *
 * Kept free of `next/link`, `next/image` and `next/font` on purpose: the site is
 * a static export, so those would only add the basePath prefix, which
 * `home-content.ts` owns explicitly. In exchange the whole page renders under
 * `react-dom/server` inside a plain unit test, which is what makes
 * `homepage.test.tsx` able to assert that every section is really on it.
 */

import {
  AUTHOR,
  BASE_PATH,
  BUILDING_BLOCKS,
  CAPABILITIES,
  CAPABILITIES_VERIFIED,
  FEEDBACK,
  FIGURES,
  HARNESS_POINTS,
  HERO,
  LINK_CHANGELOG,
  LINK_DOCS,
  LINK_GITHUB,
  LINK_ISSUES,
  LINK_NPM,
  LINK_QA,
  LINK_START,
  MEASURED_COMMIT,
  MEASURED_ON,
  MEASURED_RUN_URL,
  PRACTICES,
  QUESTIONS,
  QUESTIONS_NOTE,
  SCREENS_TITLE,
  SECTIONS,
  STATUS,
  STORY,
  TRY_NOTE,
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

export default function Home() {
  const [s1, s2, s3, s4, s5] = SECTIONS;

  return (
    <main className="home">
      {/* ── Hero ─────────────────────────────────────────────────────── */}
      {/* The band carries the illustration as a full-bleed background (a dog
          walking a conveyor of data toward the racks). It is dark in both
          themes, so the copy on it is always white; two gradients keep the
          left column readable and darken the strip the nav sits on.

          The nav rides on the picture rather than in a bar of its own: that is
          the composition of the redesign, which puts the whole first screen on
          the illustration. The same four links are repeated in the footer, so
          nothing is only reachable at the top of the page. */}
      <section
        className="home-hero-band"
        style={{ backgroundImage: `url(${BASE_PATH}/home/hero.webp)` }}
      >
        <header className="home-bar">
          <div className="home-wrap home-wrap-wide home-bar-inner">
            <a className="home-mark" href={`${BASE_PATH}/`}>
              <img
                src={`${BASE_PATH}/home/logo-128.png`}
                width={34}
                height={34}
                alt=""
                decoding="async"
              />
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

        <div className="home-wrap home-wrap-wide home-hero">
          {/* One column on the left of a 1440px container, the design's own
              width (owner, 2026-09-22): wider than the sections below, so the
              hero keeps the design's composition while the picture bleeds to
              the edges. The racks and the conveyor on the right half of the
              picture stay uncovered. */}
          <div className="home-hero-copy">
            <p className="home-hero-pill">
              <span className="dot" aria-hidden="true" />v{VERSION} · {HERO.pillSuffix}
            </p>
            <h1 className="home-hero-title">{HERO.title}</h1>
            <p className="home-hero-lede">{HERO.lede}</p>
            {/* The three pillars stand where the design had two buttons: what
                the product stands on, said once, in the accent colour. The
                install command below is the call to action. */}
            <ul className="home-hero-pillars">
              {HERO.pillars.map((p) => (
                <li key={p.label}>
                  <strong>{p.label}</strong>
                  <span>{p.body}</span>
                </li>
              ))}
            </ul>
            <div className="home-term">
              <div className="home-term-bar">
                <span className="d r" aria-hidden="true" />
                <span className="d y" aria-hidden="true" />
                <span className="d g" aria-hidden="true" />
                <span className="home-term-title">{HERO.terminalTitle}</span>
              </div>
              <div className="home-term-body">
                {HERO.commands.map((command) => (
                  <div key={command}>
                    <span className="p">$</span> <span className="c">{command}</span>
                  </div>
                ))}
              </div>
            </div>
          </div>
        </div>
      </section>

      {/* Room above the two captures, and a title over them (owner, 2026-09-22:
          they sat against the hero). */}
      <div className="home-wrap home-screens-band">
        <h2 className="home-display home-screens-title">{SCREENS_TITLE}</h2>
        <div className="home-screens">
          <figure className="home-shot">
            <img
              src={`${BASE_PATH}/home/dashboard-light.webp`}
              width={1393}
              height={1040}
              alt="The Nodal-Agents dashboard in the light theme, showing agent, skill and connector counts, job totals, weekly activity and a per-agent token table."
              loading="lazy"
              decoding="async"
            />
            <figcaption>The dashboard, light theme.</figcaption>
          </figure>
          <figure className="home-shot">
            <img
              src={`${BASE_PATH}/home/agent-dark.webp`}
              width={1393}
              height={1040}
              alt="An agent detail page in the dark theme, showing its model, role, skill and connector counts, success rate, a chart of its runs over seven days, and its attached skills."
              loading="lazy"
              decoding="async"
            />
            <figcaption>One agent, dark theme.</figcaption>
          </figure>
        </div>
      </div>

      {/* ── 01 The starting point ────────────────────────────────────── */}
      <section className="home-wrap home-section" id={s1.id}>
        <Rail index={s1.index} label={s1.label} />
        <div>
          <h2 className="home-display">{s1.title}</h2>
          <p className="home-claim">{s1.claim}</p>
          <p className="home-mono home-author">{AUTHOR}</p>
          <div className="home-story">
            {STORY.map((paragraph) => (
              <p key={paragraph}>{paragraph}</p>
            ))}
          </div>
        </div>
      </section>

      {/* ── 02 The questions ─────────────────────────────────────────── */}
      <section className="home-wrap home-section" id={s2.id}>
        <Rail index={s2.index} label={s2.label} />
        <div>
          <h2 className="home-display">{s2.title}</h2>
          <p className="home-claim">{s2.claim}</p>
          <div className="home-grid-2">
            {QUESTIONS.map((q, n) => (
              <article className="home-block" key={q.title}>
                <p className="home-mono">{String(n + 1).padStart(2, '0')}</p>
                <h3>{q.title}</h3>
                <dl className="home-defs home-question">
                  <div>
                    <dt>The question</dt>
                    <dd>{q.question}</dd>
                  </div>
                  <div>
                    <dt>What I can test in Nodal</dt>
                    <dd>{q.test}</dd>
                  </div>
                </dl>
              </article>
            ))}
          </div>
          <p className="home-figures-note">{QUESTIONS_NOTE}</p>
        </div>
      </section>

      {/* ── 03 The harness today ─────────────────────────────────────── */}
      <section className="home-wrap home-section" id={s3.id}>
        <Rail index={s3.index} label={s3.label} />
        <div>
          <h2 className="home-display">{s3.title}</h2>
          <p className="home-claim">{s3.claim}</p>
          <div className="home-grid-2 home-grid-3">
            {HARNESS_POINTS.map((p) => (
              <article className="home-block" key={p.title}>
                <h3>{p.title}</h3>
                <p>{p.body}</p>
              </article>
            ))}
          </div>
          <p className="home-mono" style={{ marginTop: '48px' }}>
            Models, connectors and other building blocks
          </p>
          <dl className="home-defs">
            {BUILDING_BLOCKS.map((d) => (
              <div key={d.term}>
                <dt>{d.term}</dt>
                <dd>{d.body}</dd>
              </div>
            ))}
          </dl>
        </div>
      </section>

      {/* ── 04 Building and checking ─────────────────────────────────── */}
      <section className="home-wrap home-section" id={s4.id}>
        <Rail index={s4.index} label={s4.label} />
        <div>
          <h2 className="home-display">{s4.title}</h2>
          <p className="home-claim">{s4.claim}</p>
          <p className="home-figures-note">
            The repository also includes automated checks, tests and a public quality report. They
            make the state of the project easier to inspect as it evolves. These figures are
            measured, not estimated.
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
            <a href={MEASURED_RUN_URL}>See the run</a>. {CAPABILITIES_VERIFIED} of the{' '}
            {CAPABILITIES} capabilities are green at both levels today. The other{' '}
            {CAPABILITIES - CAPABILITIES_VERIFIED} are missing one level, and the page that tracks
            them says so in grey rather than in green.
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
              <p className="home-mono">Pre-1.0</p>
              <h3>The quality report</h3>
              <p>
                Nodal is still pre-1.0. I use it for personal tasks while continuing to explore its
                behaviour and limits. Tests and reviews are part of that process, and the report
                shows them as they are, including what is not measured.
              </p>
            </div>
            <a className="home-btn home-btn-primary" href={LINK_QA}>
              See the quality report
            </a>
          </div>

          <dl className="home-defs" style={{ marginTop: '48px' }}>
            {STATUS.map((d) => (
              <div key={d.term}>
                <dt>{d.term}</dt>
                <dd>{d.body}</dd>
              </div>
            ))}
          </dl>
          <div className="home-status">
            <span className="home-version">{VERSION}</span>
            <span className="home-mono">latest on npm · {VERSION_DATE}</span>
          </div>
          <div className="home-actions">
            <a className="home-btn home-btn-ghost" href={LINK_CHANGELOG}>
              Read the changelog
            </a>
          </div>
        </div>
      </section>

      {/* ── 05 Try it and compare notes ──────────────────────────────── */}
      <section className="home-wrap home-section" id={s5.id}>
        <Rail index={s5.index} label={s5.label} />
        <div>
          <h2 className="home-display">{s5.title}</h2>
          <p className="home-claim">{s5.claim}</p>
          <p className="home-figures-note">{TRY_NOTE}</p>
          <div className="home-actions">
            <a className="home-btn home-btn-primary" href={LINK_START}>
              Read the setup guide
            </a>
            <a className="home-btn home-btn-ghost" href={LINK_NPM}>
              nodal-agents on npm
            </a>
          </div>

          <div className="home-portal" style={{ marginTop: '48px' }}>
            <div>
              <p className="home-mono">Compare notes</p>
              <h3>I’d like to hear what you find</h3>
              {FEEDBACK.map((paragraph) => (
                <p key={paragraph}>{paragraph}</p>
              ))}
            </div>
            <a className="home-btn home-btn-primary" href={LINK_ISSUES}>
              Share feedback on GitHub
            </a>
          </div>
        </div>
      </section>

      <footer className="home-wrap home-footer">
        <span>Nodal-Agents · an ongoing exploration by Quentin Beau.</span>
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
