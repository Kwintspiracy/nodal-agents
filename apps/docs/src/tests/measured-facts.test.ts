/**
 * The homepage figures are derived from the nightly measurement, never typed.
 * Two things have to hold: a real snapshot yields every figure the page prints,
 * and a snapshot missing a field stops the build instead of rendering a zero.
 */
import { readFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

import {
  coverageLabel,
  deriveMeasuredFacts,
  spellDate,
  type MeasuredFacts,
} from '../../scripts/measured-facts';

const here = dirname(fileURLToPath(import.meta.url));
const repoRoot = resolve(here, '..', '..', '..', '..');

const snapshot = JSON.parse(
  readFileSync(join(repoRoot, 'apps', 'qa', 'data', 'snapshot.json'), 'utf8'),
) as Record<string, unknown>;

const LABELS = [
  'packages measured',
  'test cases',
  'test files',
  'end-to-end cases',
  'line coverage',
  'capabilities green at both levels',
];

describe('measured facts are read from the nightly snapshot', () => {
  it('derives every figure the homepage prints from the real snapshot', () => {
    const facts = deriveMeasuredFacts(snapshot);
    expect(facts.figures.map((f) => f.label)).toEqual(LABELS);
    const summary = snapshot.resume as Record<string, number>;
    const value = (label: string) => facts.figures.find((f) => f.label === label)?.value;
    expect(value('packages measured')).toBe(String(summary.paquets));
    expect(value('test files')).toBe(String(summary.fichiersDeTest));
    expect(value('test cases')).toBe(summary.casDeTest.toLocaleString('en-US'));
    expect(value('end-to-end cases')).toBe(String(summary.casE2e));
    expect(value('capabilities green at both levels')).toBe(
      `${summary.capacitesVerifiees} / ${summary.capacites}`,
    );
    expect(facts.commit).toBe(snapshot.commit);
    expect(facts.runUrl).toBe((snapshot.execution as { url: string }).url);
  });

  it('spells the measurement date in UTC, so the page can cite it', () => {
    expect(spellDate('2026-09-15T09:01:39.520Z')).toBe('15 September 2026');
    expect(spellDate('2026-01-02T23:30:00.000Z')).toBe('2 January 2026');
    expect(deriveMeasuredFacts(snapshot).measuredOn).toBe(spellDate(snapshot.genereLe as string));
  });

  // Rounding DOWN is what resolves the contradiction a1d0afd3 found in the old
  // assertion: `Math.round` and "never above the measurement" cannot both hold
  // for a value ending in .x5 (81.75 rounds to 81.8, which is above). Truncation
  // satisfies both, and the bound below keeps it from losing more than a tenth.
  it('never rounds coverage up, and never loses more than a tenth of a point', () => {
    expect(coverageLabel(81.75)).toBe('81.7%');
    expect(coverageLabel(99.99)).toBe('99.9%');
    expect(coverageLabel(100)).toBe('100.0%');
    const shown = Number(
      coverageLabel((snapshot.resume as { couvertureLignes: number }).couvertureLignes).replace(
        '%',
        '',
      ),
    );
    expect(shown).toBeLessThanOrEqual(
      (snapshot.resume as { couvertureLignes: number }).couvertureLignes,
    );
  });

  it('fails loud, naming the field, when a figure is absent', () => {
    const without = (field: string) => {
      const copy = structuredClone(snapshot) as { resume: Record<string, unknown> };
      delete copy.resume[field];
      return () => deriveMeasuredFacts(copy);
    };
    expect(without('paquets')).toThrow(/resume\.paquets/);
    expect(without('casDeTest')).toThrow(/resume\.casDeTest/);
    expect(without('couvertureLignes')).toThrow(/resume\.couvertureLignes/);
    expect(without('capacitesVerifiees')).toThrow(/resume\.capacitesVerifiees/);
    expect(() => deriveMeasuredFacts({ resume: {} })).toThrow(/snapshot\.json/);
    expect(() => deriveMeasuredFacts(null)).toThrow(/snapshot/);
  });

  // A present-but-absurd figure used to pass the guard, which only asked "is it
  // a finite number?". The page then printed `-3 / 24`, `0 of the 0
  // capabilities` and `150.0%` — each one a broken measurement wearing the
  // clothes of a result. An absurd figure now stops the build by name, exactly
  // as an absent one does.
  it('refuses a negative count, naming the field', () => {
    const withValue = (field: string, value: unknown) => {
      const copy = structuredClone(snapshot) as { resume: Record<string, unknown> };
      copy.resume[field] = value;
      return () => deriveMeasuredFacts(copy);
    };
    expect(withValue('paquets', -1)).toThrow(/resume\.paquets is negative \(-1\)/);
    expect(withValue('casDeTest', -42)).toThrow(/resume\.casDeTest is negative/);
    expect(withValue('capacitesVerifiees', -3)).toThrow(/resume\.capacitesVerifiees is negative/);
    expect(withValue('couvertureLignes', -0.5)).toThrow(/resume\.couvertureLignes is negative/);
    // Zero is a real measurement for a count of things; it is not one for the
    // total the page divides by, which the next case covers.
    expect(withValue('casE2e', 0)).not.toThrow();
  });

  it('refuses a measurement with no capabilities at all', () => {
    const copy = structuredClone(snapshot) as { resume: Record<string, unknown> };
    copy.resume.capacites = 0;
    copy.resume.capacitesVerifiees = 0;
    expect(() => deriveMeasuredFacts(copy)).toThrow(/resume\.capacites is zero/);
  });

  it('refuses a coverage that is not a share of a hundred', () => {
    const withCoverage = (value: number) => {
      const copy = structuredClone(snapshot) as { resume: Record<string, unknown> };
      copy.resume.couvertureLignes = value;
      return () => deriveMeasuredFacts(copy);
    };
    expect(withCoverage(150)).toThrow(/resume\.couvertureLignes is above 100 \(150\)/);
    expect(withCoverage(100.01)).toThrow(/resume\.couvertureLignes is above 100/);
    expect(withCoverage(100)).not.toThrow();
    expect(withCoverage(0)).not.toThrow();
  });

  it('refuses a measurement claiming more proven capabilities than it has', () => {
    const copy = structuredClone(snapshot) as { resume: Record<string, unknown> };
    copy.resume.capacitesVerifiees = (copy.resume.capacites as number) + 1;
    expect(() => deriveMeasuredFacts(copy)).toThrow(/capacitesVerifiees/);
  });

  it('is what the generator committed, in the shape the page consumes', () => {
    const generated = JSON.parse(
      readFileSync(join(repoRoot, 'apps', 'docs', 'lib', 'measured-facts.json'), 'utf8'),
    ) as MeasuredFacts;
    expect(generated.figures.map((f) => f.label)).toEqual(LABELS);
    for (const f of generated.figures) expect(f.value).not.toBe('');
    expect(generated.commit).toMatch(/^[0-9a-f]{7,40}$/);
    expect(generated.runUrl).toMatch(/^https:\/\/github\.com\//);
    expect(generated.capabilitiesVerified).toBeLessThanOrEqual(generated.capabilities);
  });
});
