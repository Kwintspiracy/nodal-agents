/**
 * The homepage is public, so the two ways it can go wrong are both covered
 * here:
 *
 *  · it renders, and every section it promises is really in the markup;
 *  · the figures it prints are the ones the nightly measurement recorded.
 *
 * The second half is the one that matters. Any page can claim a coverage
 * percentage. This one reads `apps/qa/data/snapshot.json` and fails if the page
 * and the measurement have drifted apart, which is the only thing that keeps a
 * marketing page honest six months from now.
 */

import { existsSync, readFileSync, statSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import type { ReactElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it, vi } from 'vitest';

import Home from '../../app/home';
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
  LINK_ISSUES,
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
} from '../../app/home-content';
import { parseYaml } from './yaml-lite';

const here = dirname(fileURLToPath(import.meta.url));
const docsRoot = resolve(here, '..', '..');
const repoRoot = resolve(docsRoot, '..', '..');

const markup = renderToStaticMarkup(<Home />);

/** The parts of `.github/workflows/docs.yml` the cases below actually read. */
interface DocsWorkflow {
  on: { workflow_run?: { workflows?: string[]; types?: string[] } };
  jobs: Record<
    string,
    { if?: string; steps: Array<{ uses?: string; run?: string; with?: { ref?: string } }> }
  >;
}

const DOCS_WORKFLOW = parseYaml(
  readFileSync(join(repoRoot, '.github', 'workflows', 'docs.yml'), 'utf8'),
) as unknown as DocsWorkflow;
const BUILD_JOB = DOCS_WORKFLOW.jobs.build;

/** True when some step of the build job runs a command containing `fragment`. */
const runsInBuildJob = (fragment: string): boolean =>
  BUILD_JOB.steps.some((step) => (step.run ?? '').includes(fragment));

/** What `renderToStaticMarkup` writes for a text: `'` becomes `&#x27;`. */
function escapeHtml(text: string): string {
  return text
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#x27;');
}

function figure(label: string): string {
  const found = FIGURES.find((f) => f.label === label);
  if (!found) throw new Error(`no figure labelled "${label}"`);
  return found.value;
}

describe('homepage rendering', () => {
  it('renders every declared section, with its anchor, title, label and claim', () => {
    expect(SECTIONS).toHaveLength(5);
    for (const section of SECTIONS) {
      expect(markup).toContain(`id="${section.id}"`);
      expect(markup).toContain(section.title);
      expect(markup).toContain(section.label);
      expect(markup).toContain(section.claim);
    }
  });

  it('points at the quality report, in the nav and in the building section', () => {
    expect(markup.split(`href="${BASE_PATH}/qa/"`).length - 1).toBe(2);
    expect(markup).toContain('See the quality report');
  });

  it('carries the outbound links, the setup guide and the install command', () => {
    expect(markup).toContain('https://github.com/Kwintspiracy/nodal-agents');
    expect(markup).toContain(`href="${LINK_ISSUES}"`);
    expect(markup).toContain(`href="${LINK_START}"`);
    expect(markup).toContain(`href="${BASE_PATH}/docs"`);
    expect(markup).toContain('npm install -g nodal-agents');
    expect(markup).toContain('nodal-agents up');
  });

  it('uses no em dash, which the product copy rules forbid', () => {
    expect(markup).not.toContain('—');
  });

  // Every copy block declared in `home-content.ts` has to reach the page. A
  // block can be written, reviewed and merged while nothing renders it, and
  // nothing else here would notice: the page would simply be missing a claim
  // its own source file says it makes.
  it('renders every copy block it declares, not just the ones a case names', () => {
    const blocks: ReadonlyArray<readonly [string, readonly string[]]> = [
      ['author', [AUTHOR]],
      ['story', STORY],
      ['questions', QUESTIONS.flatMap((q) => [q.title, q.question, q.test])],
      ['questions note', [QUESTIONS_NOTE]],
      ['harness', HARNESS_POINTS.flatMap((p) => [p.title, p.body])],
      ['building blocks', BUILDING_BLOCKS.flatMap((d) => [d.term, d.body])],
      ['practices', PRACTICES.flatMap((p) => [p.title, p.body])],
      ['status', STATUS.flatMap((d) => [d.term, d.body])],
      ['try note', [TRY_NOTE]],
      ['feedback', FEEDBACK],
      [
        'hero',
        [
          HERO.title,
          HERO.lede,
          ...HERO.pillars.flatMap((p) => [p.label, p.body]),
          ...HERO.commands,
        ],
      ],
      ['screens title', [SCREENS_TITLE]],
    ];
    for (const [name, texts] of blocks) {
      expect(texts.length, `${name} declares nothing`).toBeGreaterThan(0);
      const missing = texts.filter((t) => !markup.includes(escapeHtml(t)));
      expect(missing, `${name}: not rendered`).toEqual([]);
    }
  });

  // The owner's request of 2026-09-24: an exploration used by one person,
  // measured in its claims. These are the sentences that say so, and the
  // marketing lines the page carried before must not come back.
  it('says what it is: one user, pre-1.0, nothing tried at scale', () => {
    expect(markup).toContain('One user so far');
    expect(markup).toContain('Nothing here has been tried at scale.');
    expect(markup).toContain('Nodal is still pre-1.0.');
    for (const gone of [
      'Herd your agents',
      'personal production',
      'from the first command to production',
      'Memory that compounds',
    ]) {
      expect(markup, `the old claim "${gone}" is back`).not.toContain(gone);
    }
  });

  it('asks each of the four questions with what can be tested in Nodal', () => {
    expect(QUESTIONS).toHaveLength(4);
    expect(markup.split('<dt>The question</dt>').length - 1).toBe(4);
    expect(markup.split('<dt>What I can test in Nodal</dt>').length - 1).toBe(4);
  });

  it('opens on a hero band whose background is the illustration shipped with the site', () => {
    // The band sets the picture inline (the base path is home-content's), and
    // the file must really be in `public/`: a static export serves nothing else.
    expect(markup).toContain(`background-image:url(${BASE_PATH}/home/hero.webp)`);
    expect(existsSync(join(docsRoot, 'public', 'home', 'hero.webp'))).toBe(true);
    // And the nav is inside that band rather than in a bar above it, which is
    // the composition of the redesign. Asserted on the markup and not on the
    // stylesheet: a `position:absolute` on a header that sits outside the
    // section would put the picture behind nothing.
    const band = markup.slice(markup.indexOf('home-hero-band'));
    const bandEnd = band.indexOf('home-screens');
    expect(bandEnd).toBeGreaterThan(0);
    expect(band.slice(0, bandEnd)).toContain('class="home-bar"');
  });

  // Every word of the hero comes from `HERO`, so the page and the handoff
  // cannot drift apart without this going red.
  it('renders the hero copy it declares: a one-line title, the lede, three pillars, the commands', () => {
    // One line, no break inside the heading (owner, 2026-09-22).
    expect(markup).toContain(`<h1 class="home-hero-title">${HERO.title}</h1>`);
    expect(markup).toContain(HERO.lede);
    expect(HERO.pillars).toHaveLength(3);
    for (const p of HERO.pillars) {
      expect(markup).toContain(p.label);
      expect(markup).toContain(p.body);
    }
    // The two buttons of the design are gone: the install command is the call
    // to action, and the nav carries GitHub.
    expect(markup).not.toContain('home-hero-btn');
    expect(markup).toContain(HERO.terminalTitle);
    for (const command of HERO.commands) expect(markup).toContain(command);
  });

  // Every section opens the same way since 2026-09-22: the title, then one
  // claim in the display face with the accent bar, and no section left on the
  // old plain intro.
  it('opens every section on a claim with the accent bar, the same style each time', () => {
    expect(markup.split('class="home-claim"').length - 1).toBe(SECTIONS.length);
    expect(markup).not.toContain('home-intro');
  });

  it('gives the two captures a title and room under the hero', () => {
    const band = markup.slice(markup.indexOf('home-screens-band'));
    expect(band.indexOf(SCREENS_TITLE)).toBeGreaterThan(0);
    expect(band.indexOf(SCREENS_TITLE)).toBeLessThan(band.indexOf('home-shot'));
  });

  // The pill is the one place on the page where a version could be typed by
  // hand next to the one the release publishes. It reads `VERSION`, which the
  // case below checks against `apps/cli/package.json`.
  it('prints the published version on the hero pill, never a typed one', () => {
    expect(markup).toContain(`v${VERSION} · ${HERO.pillSuffix}`);
  });

  // The redesign names Instrument Sans and IBM Plex Mono outright. They are
  // loaded through `next/font`, which a statically rendered page cannot show,
  // so this reads the two files that have to agree: the layout declares the
  // variable, the stylesheet uses it.
  it('loads the two hero typefaces and uses them in the hero only', () => {
    const layout = readFileSync(join(docsRoot, 'app', 'layout.tsx'), 'utf8');
    const css = readFileSync(join(docsRoot, 'app', 'home.css'), 'utf8');
    for (const [font, variable] of [
      ['Instrument_Sans', '--font-instrument'],
      ['IBM_Plex_Mono', '--font-plexmono'],
    ]) {
      expect(layout).toContain(font);
      expect(layout).toContain(`variable: '${variable}'`);
      expect(layout).toContain(
        `\${${font === 'Instrument_Sans' ? 'instrumentSans' : 'plexMono'}.variable}`,
      );
      expect(css).toContain(`var(${variable})`);
    }
    // Scoped to the hero: the docs pages and the rest of the homepage keep
    // Public Sans and Inter. Checked rule by rule rather than on one slice of
    // the file, because a slice leaves every other rule free to pick the
    // variable up (Reviewer C, pass 1). Every innermost block that mentions
    // one of the two has to be selected by a hero class, media queries
    // included: the pattern matches inner blocks only, since a rule body
    // cannot itself contain a brace.
    const heroSelector = /(^|[\s,])\.home-(hero|term|bar|mark)/;
    const offenders = [...css.replace(/\/\*[\s\S]*?\*\//g, '').matchAll(/([^{}]+)\{([^{}]*)\}/g)]
      .filter(
        ([, , body]) => body.includes('--font-instrument') || body.includes('--font-plexmono'),
      )
      .map(([, selector]) => selector.trim())
      .filter((selector) => !selector.split(',').every((one) => heroSelector.test(one.trim())));
    expect(offenders, 'hero typeface used outside the hero').toEqual([]);
  });
});

describe('homepage assets and configuration', () => {
  it('prefixes its own links with the basePath the build actually uses', () => {
    const config = readFileSync(join(docsRoot, 'next.config.mjs'), 'utf8');
    expect(config).toContain(`basePath: '${BASE_PATH}'`);
    expect(config).toContain(`assetPrefix: '${BASE_PATH}'`);
  });

  it('ships every screenshot it references, each under 250 KB', () => {
    // `src` attributes, and the pictures set as backgrounds (the hero): a
    // guard that reads only `src` would let a full-bleed background weigh
    // anything.
    const sources = [
      ...[...markup.matchAll(/src="([^"]+)"/g)].map((m) => m[1]),
      ...[...markup.matchAll(/background-image:url\(([^)]+)\)/g)].map((m) => m[1]),
    ];
    expect(sources.length).toBeGreaterThan(0);
    expect(sources).toContain(`${BASE_PATH}/home/hero.webp`);
    for (const src of sources) {
      expect(src.startsWith(`${BASE_PATH}/`)).toBe(true);
      const onDisk = join(docsRoot, 'public', src.slice(BASE_PATH.length + 1));
      expect(statSync(onDisk).size).toBeLessThan(250 * 1024);
    }
  });

  // The portal is a standalone HTML document rendered by `apps/qa/build.mjs`,
  // not a route of this site. Nothing in the Next build would notice if the
  // deploy stopped copying it, so the link above would rot into a 404 in
  // silence. This reads the workflow that has to put it there.
  it('is deployed alongside a portal the docs workflow actually copies', () => {
    expect(runsInBuildJob('node apps/qa/build.mjs')).toBe(true);
    expect(runsInBuildJob('apps/docs/out/qa/index.html')).toBe(true);
    // It also has to fire after the nightly measurement: that push is made with
    // GITHUB_TOKEN and triggers no workflow on its own, so without this the
    // portal would freeze on the day it was first published.
    expect(DOCS_WORKFLOW.on.workflow_run?.workflows).toEqual(['Quality — full measurement']);
    expect(DOCS_WORKFLOW.on.workflow_run?.types).toEqual(['completed']);
    expect(existsSync(join(repoRoot, '.github', 'workflows', 'qa-pages.yml'))).toBe(false);
  });

  // The figures are generated at build time, so the deploy has to run the
  // generator on every publish, and has to publish again after the nightly
  // measurement. Neither is visible from the page itself.
  //
  // Read from the parsed workflow, not by looking for substrings in the file:
  // `expect(wf).toContain('ref: main')` passes on a `ref: main` that has moved
  // to another job, been commented out, or sits under a step that no longer
  // runs. It is the structure that has to hold.
  it('regenerates its figures on every build, and rebuilds after each measurement', () => {
    const pkg = JSON.parse(readFileSync(join(docsRoot, 'package.json'), 'utf8')) as {
      scripts: Record<string, string>;
    };
    expect(pkg.scripts.build).toContain('gen-reference.ts');
    expect(runsInBuildJob('pnpm --filter @nodal-agents/docs build')).toBe(true);
    expect(DOCS_WORKFLOW.on.workflow_run?.workflows).toEqual(['Quality — full measurement']);
    // The measurement pushes its data commit after the run that triggered it,
    // so the rebuild has to check out main rather than the triggering SHA —
    // and it is the BUILD job's own checkout that has to carry it.
    const checkout = BUILD_JOB.steps.filter((s) => (s.uses ?? '').startsWith('actions/checkout@'));
    expect(checkout).toHaveLength(1);
    expect(checkout[0].with?.ref).toBe('main');
  });

  // GitHub keeps ONE pending run per concurrency group and cancels the older
  // one when a second is queued, whatever its event. On 2026-09-20 the deploy
  // of main was the one cancelled (#306). That is harmless only because every
  // run builds main HEAD, so the survivor deploys at least what the cancelled
  // run would have: the build job must check out `main` (asserted above) and
  // must never skip itself. The former `if` on the measurement's conclusion
  // did exactly that: a failed nightly cancelled the pending deploy of main,
  // then skipped its own, and nobody deployed until the hourly net. It guarded
  // nothing, since the measurement commits its data only after every earlier
  // step succeeded, so main never carries a half-written measurement.
  it('never skips a deploy: every run publishes main HEAD, whatever queued it', () => {
    expect(BUILD_JOB.if).toBeUndefined();
    const checkout = BUILD_JOB.steps.filter((s) => (s.uses ?? '').startsWith('actions/checkout@'));
    expect(checkout[0].with?.ref).toBe('main');
  });

  it('announces the version that is actually published', () => {
    const cli = JSON.parse(readFileSync(join(repoRoot, 'apps', 'cli', 'package.json'), 'utf8')) as {
      name: string;
      version: string;
    };
    expect(cli.name).toBe('nodal-agents');
    expect(VERSION).toBe(cli.version);
    expect(markup).toContain(VERSION);
  });
});

describe('homepage figures come from the measurement, not from a transcription', () => {
  // Deliberately NOT a comparison between the page and the current snapshot.
  // The nightly measurement rewrites that snapshot with `[skip ci]`, so such a
  // comparison turned every pull request opened afterwards red for a drift it
  // had not caused (issue #109). The figures are derived at build time by
  // `scripts/gen-reference.ts`; what is left to prove here is that the page
  // really prints them, and cites when they were measured.
  it('prints every derived figure, value and label', () => {
    expect(FIGURES).toHaveLength(6);
    for (const f of FIGURES) {
      expect(f.value).not.toBe('');
      expect(markup).toContain(f.value);
      expect(markup).toContain(f.label);
    }
    expect(figure('capabilities green at both levels')).toBe(
      `${CAPABILITIES_VERIFIED} / ${CAPABILITIES}`,
    );
  });

  // The guard against someone typing the numbers back in. Comparing `FIGURES`
  // to the committed `measured-facts.json` did NOT do that: both sides read the
  // same file, so typing today's values into `home-content.ts` as constants
  // left it green. Proving the import means putting a DIFFERENT file in front
  // of the page and rendering it — only a page that really reads the generated
  // file can print what the substitute says.
  it('renders whatever the generated file says, not numbers of its own', async () => {
    const substitute = {
      note: 'substituted by the test',
      measuredOn: '7 March 1999',
      commit: 'deadbee',
      runUrl: 'https://github.com/Kwintspiracy/nodal-agents/actions/runs/424242',
      capabilities: 41,
      capabilitiesVerified: 7,
      figures: [
        { value: '7770', label: 'packages measured' },
        { value: '8,881', label: 'test cases' },
        { value: '7772', label: 'test files' },
        { value: '7773', label: 'end-to-end cases' },
        { value: '7.4%', label: 'line coverage' },
        { value: '7 / 41', label: 'capabilities green at both levels' },
      ],
    };
    vi.resetModules();
    vi.doMock('../../lib/measured-facts.json', () => ({ default: substitute }));
    try {
      const { default: SubstitutedHome } = (await import('../../app/home')) as {
        default: () => ReactElement;
      };
      const rendered = renderToStaticMarkup(<SubstitutedHome />);
      for (const f of substitute.figures) expect(rendered).toContain(f.value);
      expect(rendered).toContain(substitute.measuredOn);
      expect(rendered).toContain(substitute.commit);
      expect(rendered).toContain(substitute.runUrl);
      expect(rendered).toContain('7 of the 41 capabilities');
      expect(rendered).toContain('The other 34 are missing one level');
      // And nothing of the real measurement leaked through a second source.
      expect(rendered).not.toContain(MEASURED_COMMIT);
    } finally {
      vi.doUnmock('../../lib/measured-facts.json');
      vi.resetModules();
    }
  });

  it('cites the date, the commit and the run the figures were measured on', () => {
    expect(markup).toContain(MEASURED_ON);
    expect(markup).toContain(MEASURED_COMMIT);
    expect(markup).toContain(MEASURED_RUN_URL);
    expect(MEASURED_COMMIT).toMatch(/^[0-9a-f]{7,40}$/);
  });

  it('states how many capabilities are still missing a level, without overstating', () => {
    expect(CAPABILITIES_VERIFIED).toBeLessThanOrEqual(CAPABILITIES);
    expect(markup).toContain(
      `The other ${CAPABILITIES - CAPABILITIES_VERIFIED} are missing one level`,
    );
  });
});
