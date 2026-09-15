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
import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it } from 'vitest';

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
  MEASURED_COMMIT,
  SECTIONS,
  VERSION,
} from '../../app/home-content';

const here = dirname(fileURLToPath(import.meta.url));
const docsRoot = resolve(here, '..', '..');
const repoRoot = resolve(docsRoot, '..', '..');

const markup = renderToStaticMarkup(<Home />);

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
    const wf = readFileSync(join(repoRoot, '.github', 'workflows', 'docs.yml'), 'utf8');
    expect(wf).toContain('node apps/qa/build.mjs');
    expect(wf).toContain('apps/docs/out/qa/index.html');
    // It also has to fire after the nightly measurement: that push is made with
    // GITHUB_TOKEN and triggers no workflow on its own, so without this the
    // portal would freeze on the day it was first published.
    expect(wf).toContain("workflows: ['Quality — full measurement']");
    expect(existsSync(join(repoRoot, '.github', 'workflows', 'qa-pages.yml'))).toBe(false);
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

describe('homepage figures match the measurement they cite', () => {
  const snapshot = JSON.parse(
    readFileSync(join(repoRoot, 'apps', 'qa', 'data', 'snapshot.json'), 'utf8'),
  ) as {
    commit: string;
    resume: {
      paquets: number;
      fichiersDeTest: number;
      casDeTest: number;
      casE2e: number;
      couvertureLignes: number;
      capacites: number;
      capacitesVerifiees: number;
    };
  };

  it('cites the commit the snapshot was measured on', () => {
    expect(snapshot.commit).toBe(MEASURED_COMMIT);
  });

  it('prints the counts the snapshot recorded', () => {
    const r = snapshot.resume;
    expect(figure('packages measured')).toBe(String(r.paquets));
    expect(figure('test files')).toBe(String(r.fichiersDeTest));
    expect(figure('test cases')).toBe(r.casDeTest.toLocaleString('en-US'));
    expect(figure('end-to-end cases')).toBe(String(r.casE2e));
  });

  it('rounds coverage without inflating it', () => {
    // TRUNCATED to one decimal, not rounded. The two assertions contradicted
    // each other on any measurement ending in .x5 — `Math.round` turns 81.75
    // into 81.8, which the next line then rejects as inflated. "Without
    // inflating it" is the rule the title states, so the figure rounds DOWN.
    const shown = Number(figure('line coverage').replace('%', ''));
    expect(shown).toBe(Math.floor(snapshot.resume.couvertureLignes * 10) / 10);
    expect(shown).toBeLessThanOrEqual(snapshot.resume.couvertureLignes);
  });

  it('does not overstate how many capabilities are proven at both levels', () => {
    const r = snapshot.resume;
    expect(figure('capabilities green at both levels')).toBe(
      `${r.capacitesVerifiees} / ${r.capacites}`,
    );
    expect(r.capacitesVerifiees).toBeLessThanOrEqual(r.capacites);
  });
});
