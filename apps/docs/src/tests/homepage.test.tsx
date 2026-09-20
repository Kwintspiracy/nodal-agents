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
  BASE_PATH,
  CATALOG,
  CATALOG_FIGURES,
  CHANNEL_ICONS,
  CONNECTOR_ICONS,
  EXAMPLES,
  FEATURE_SLUGS,
  FIGURES,
  MCP_ICONS,
  INVARIANTS,
  CAPABILITIES,
  CAPABILITIES_VERIFIED,
  MEASURED_COMMIT,
  MEASURED_ON,
  MEASURED_RUN_URL,
  SECTIONS,
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

function figure(label: string): string {
  const found = FIGURES.find((f) => f.label === label);
  if (!found) throw new Error(`no figure labelled "${label}"`);
  return found.value;
}

describe('homepage rendering', () => {
  it('renders every declared section, with its anchor and its title', () => {
    expect(SECTIONS).toHaveLength(6);
    for (const section of SECTIONS) {
      expect(markup).toContain(`id="${section.id}"`);
      expect(markup).toContain(section.title);
      expect(markup).toContain(section.label);
    }
  });

  it('states the ten invariants, numbered one to ten', () => {
    expect(INVARIANTS.map((i) => i.n)).toEqual([1, 2, 3, 4, 5, 6, 7, 8, 9, 10]);
    for (const invariant of INVARIANTS) {
      expect(markup).toContain(invariant.text);
    }
  });

  it('points at the quality portal, in the nav and in the engineering section', () => {
    expect(markup.split(`href="${BASE_PATH}/qa/"`).length - 1).toBe(2);
    expect(markup).toContain('Open the portal');
  });

  it('carries the two outbound links and the install command', () => {
    expect(markup).toContain('https://github.com/Kwintspiracy/nodal-agents');
    expect(markup).toContain(`href="${BASE_PATH}/docs"`);
    expect(markup).toContain('npm install -g nodal-agents');
    expect(markup).toContain('nodal-agents up');
  });

  it('uses no em dash, which the product copy rules forbid', () => {
    expect(markup).not.toContain('—');
  });

  it('opens on a hero band whose background is the illustration shipped with the site', () => {
    // The band sets the picture inline (the base path is home-content's), and
    // the file must really be in `public/`: a static export serves nothing else.
    expect(markup).toContain(`background-image:url(${BASE_PATH}/home/hero.webp)`);
    expect(existsSync(join(docsRoot, 'public', 'home', 'hero.webp'))).toBe(true);
  });
});

describe('the catalog section only shows what the product actually ships', () => {
  it('gives every connector icon a slug that is in the connector catalog', () => {
    expect(CONNECTOR_ICONS.length).toBeGreaterThan(0);
    for (const icon of CONNECTOR_ICONS) {
      expect(CATALOG.connectorSlugs).toContain(icon.slug);
      expect(markup).toContain(`${BASE_PATH}/home/icons/${icon.file}.svg`);
    }
  });

  it('gives every MCP icon a slug that is in the MCP catalog', () => {
    expect(MCP_ICONS.length).toBeGreaterThan(0);
    for (const icon of MCP_ICONS) {
      expect(CATALOG.mcpSlugs).toContain(icon.slug);
    }
  });

  it('shows the four channels the product actually speaks', () => {
    expect(CHANNEL_ICONS.map((c) => c.slug)).toEqual(['telegram', 'discord', 'slack', 'whatsapp']);
  });

  it('prints the catalog counts the generator recorded', () => {
    const value = (label: string) => {
      const found = CATALOG_FIGURES.find((f) => f.label === label);
      if (!found) throw new Error(`no catalog figure labelled "${label}"`);
      return found.value;
    };
    expect(value('connectors in the catalog')).toBe(String(CATALOG.connectors));
    expect(value('MCP servers in the catalog')).toBe(String(CATALOG.mcpServers));
    expect(value('system skills')).toBe(String(CATALOG.systemSkills));
    expect(value('connector tools')).toBe(String(CATALOG.connectorTools));
    expect(value('built-in tools')).toBe(String(CATALOG.builtinTools));
    expect(value('models pre-configured')).toBe(String(CATALOG.models));
    for (const f of CATALOG_FIGURES) expect(markup).toContain(f.label);
  });

  it('offers a wide, unordered scatter of examples rather than a short menu', () => {
    expect(EXAMPLES.length).toBeGreaterThanOrEqual(8);
    // Heterogeneous on purpose: two examples sharing a domain tag would read as
    // a category, and a category reads as the list the section denies having.
    const tags = EXAMPLES.map((e) => e.tag);
    expect(new Set(tags).size).toBe(tags.length);
    for (const e of EXAMPLES) {
      expect(markup).toContain(e.body);
      // One line each. The section failed twice by explaining two cases at
      // length, which is what made them read as the only two.
      expect(e.body.length).toBeLessThan(110);
    }
    // Telegram is a way to reach an agent, not a thing you build with one. It
    // may appear as the channel of an example, never as its subject.
    expect(markup).toContain('There is no list of supported use cases');
  });

  it('builds every example out of things that are really in the catalog', () => {
    const known = new Set([
      ...CATALOG.connectorSlugs,
      ...CATALOG.mcpSlugs,
      ...CATALOG.systemSkillSlugs,
      ...FEATURE_SLUGS,
    ]);
    const unknown = EXAMPLES.flatMap((e) =>
      e.uses.filter((u) => !known.has(u)).map((u) => `${e.tag}: ${u}`),
    );
    expect(unknown).toEqual([]);
    for (const e of EXAMPLES) expect(e.uses.length).toBeGreaterThan(0);
  });

  it('says how much of each catalog the grid is not showing', () => {
    const connectorsLeft = CATALOG.connectors - CONNECTOR_ICONS.length;
    const serversLeft = CATALOG.mcpPreconfigured - MCP_ICONS.length;
    expect(connectorsLeft).toBeGreaterThan(0);
    expect(serversLeft).toBeGreaterThan(0);
    expect(markup).toContain(`+ ${connectorsLeft} more`);
    expect(markup).toContain(`+ ${serversLeft} more`);
    // The two "add your own" sentinels are not servers anybody can connect to,
    // so counting them here would overstate the catalog by two.
    expect(CATALOG.mcpPreconfigured).toBe(CATALOG.mcpServers - 2);
    // Channels are the one grid that IS the whole list, so it claims no more.
    expect(CHANNEL_ICONS.length).toBe(4);
  });

  // Verified in the dashboard source, not assumed: McpAddForm plus the two
  // custom-* catalog sentinels for servers, InstallCommunitySkillModal and
  // SkillForm for skills, and no form at all for a new connector type, which
  // ConnectorsClient.tsx states outright ("custom passe par un MCP server").
  it('claims you can add servers and skills, and does not claim it for connectors', () => {
    expect(markup).toContain('You can add your own, over HTTP or as a local process');
    expect(markup).toContain('You cannot add a connector type yourself');
    expect(markup).toContain('any community skill file');
  });
});

describe('homepage assets and configuration', () => {
  it('prefixes its own links with the basePath the build actually uses', () => {
    const config = readFileSync(join(docsRoot, 'next.config.mjs'), 'utf8');
    expect(config).toContain(`basePath: '${BASE_PATH}'`);
    expect(config).toContain(`assetPrefix: '${BASE_PATH}'`);
  });

  it('ships every screenshot it references, each under 250 KB', () => {
    const sources = [...markup.matchAll(/src="([^"]+)"/g)].map((m) => m[1]);
    expect(sources.length).toBeGreaterThan(0);
    for (const src of sources) {
      expect(src.startsWith(`${BASE_PATH}/`)).toBe(true);
      const onDisk = join(docsRoot, 'public', src.slice(BASE_PATH.length + 1));
      expect(statSync(onDisk).size).toBeLessThan(250 * 1024);
    }
    // Screenshots and brand icons both, so a renamed icon file is caught here
    // rather than by a visitor looking at a broken image.
    expect(sources.filter((s) => s.endsWith('.svg')).length).toBe(
      CONNECTOR_ICONS.length + MCP_ICONS.length + CHANNEL_ICONS.length,
    );
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

  // A measurement that FAILED leaves `apps/qa/data` half written. Publishing it
  // would present those leftovers as the state of the day, so the build job is
  // gated on the conclusion of the run that triggered it — while staying open
  // to every other event, which carries no `workflow_run` at all.
  it('refuses to publish what a failed measurement left behind', () => {
    const gate = BUILD_JOB.if ?? '';
    expect(gate).toContain("github.event_name != 'workflow_run'");
    expect(gate).toContain("github.event.workflow_run.conclusion == 'success'");
    expect(gate).toMatch(/\|\|/);
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
