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

import { readFileSync, statSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it } from 'vitest';

import Home from '../../app/home';
import {
  BASE_PATH,
  FIGURES,
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
    expect(SECTIONS).toHaveLength(5);
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
    const shown = Number(figure('line coverage').replace('%', ''));
    expect(shown).toBe(Math.round(snapshot.resume.couvertureLignes * 10) / 10);
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
