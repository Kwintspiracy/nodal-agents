/**
 * measured-facts.ts — turn the nightly measurement into the figures the
 * homepage prints.
 *
 * The homepage used to carry those figures as hand-typed constants, and a test
 * compared them to `apps/qa/data/snapshot.json`. The nightly job rewrites that
 * snapshot with `[skip ci]`, so every pull request opened after a measurement
 * started red for a file it never touched (issue #109). A figure that is
 * transcribed by hand is a figure that goes stale, so there is now one source:
 * the snapshot, read at build time, exactly as `catalog-facts.json` is derived
 * from the catalogs.
 *
 * Every figure is required. A snapshot missing one fails the build with the
 * field name, rather than rendering a silent `0` on a public page.
 */

export interface Figure {
  readonly value: string;
  readonly label: string;
}

export interface MeasuredFacts {
  readonly note: string;
  /** Measurement date, spelled out, e.g. `15 September 2026`. */
  readonly measuredOn: string;
  /** Short commit the measurement ran on. */
  readonly commit: string;
  /** The workflow run that produced it. */
  readonly runUrl: string;
  readonly capabilities: number;
  readonly capabilitiesVerified: number;
  readonly figures: readonly Figure[];
}

function fail(field: string, why: string): never {
  throw new Error(
    `apps/qa/data/snapshot.json: ${field} ${why}. The homepage figures are read ` +
      `from the nightly measurement; it cannot render a figure the snapshot does not carry.`,
  );
}

function record(value: unknown, field: string): Record<string, unknown> {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    fail(field, 'is missing or is not an object');
  }
  return value as Record<string, unknown>;
}

function count(source: Record<string, unknown>, field: string, path: string): number {
  const value = source[field];
  if (typeof value !== 'number' || !Number.isFinite(value))
    fail(path, 'is missing or not a number');
  // A count below zero is not a measurement, it is a corrupt file. Letting it
  // through printed `-3 / 24` on a public page, which the type alone allows and
  // no reader would read as an error.
  if ((value as number) < 0) fail(path, `is negative (${value as number})`);
  return value as number;
}

/**
 * A count of something this repository always has some of: packages, test
 * files, test cases, capabilities, a coverage percentage. Zero is a real
 * measurement for `casE2e` or for capabilities proven at both levels, and it is
 * never one here — a collector that fell silent writes zeros, and the page then
 * announced "0 packages measured" and "0.0% line coverage" under a green build.
 */
function positive(source: Record<string, unknown>, field: string, path: string): number {
  const value = count(source, field, path);
  if (value === 0) fail(path, 'is zero, which no measurement of this repository produces');
  return value;
}

/**
 * A count that also has to be a share of a hundred. A coverage of 150 rendered
 * as `150.0%` and a coverage of -4 as `-4.0%`; both are a broken measurement
 * announcing itself as a result.
 */
function percentage(source: Record<string, unknown>, field: string, path: string): number {
  const value = positive(source, field, path);
  if (value > 100) fail(path, `is above 100 (${value})`);
  return value;
}

function text(source: Record<string, unknown>, field: string, path: string): string {
  const value = source[field];
  if (typeof value !== 'string' || value.trim() === '') fail(path, 'is missing or not a string');
  return value as string;
}

const MONTHS = [
  'January',
  'February',
  'March',
  'April',
  'May',
  'June',
  'July',
  'August',
  'September',
  'October',
  'November',
  'December',
];

/**
 * `2026-09-15T09:01:39.520Z` → `15 September 2026`, in UTC, like the portal.
 *
 * UTC and a hand-written month name rather than a locale format: the page is
 * prerendered on a CI runner and read everywhere, so a date resolved against
 * the builder's timezone would name a day the measurement did not run on.
 */
export function spellDate(iso: string): string {
  const date = new Date(iso);
  if (Number.isNaN(date.getTime())) fail('genereLe', `is not a date (${iso})`);
  return `${date.getUTCDate()} ${MONTHS[date.getUTCMonth()]} ${date.getUTCFullYear()}`;
}

/**
 * One decimal, rounded DOWN. A page that rounds 81.75 up to 81.8 claims
 * coverage the repository does not have.
 */
export function coverageLabel(percent: number): string {
  return `${(Math.floor(percent * 10) / 10).toFixed(1)}%`;
}

export function deriveMeasuredFacts(snapshot: unknown): MeasuredFacts {
  const root = record(snapshot, 'the snapshot');
  const summary = record(root.resume, 'resume');
  const run = record(root.execution, 'execution');

  // Zero capabilities is not a product with nothing to prove, it is a
  // measurement that found nothing. The page said "0 of the 0 capabilities".
  const capabilities = positive(summary, 'capacites', 'resume.capacites');
  // Zero PROVEN capabilities, on the other hand, is a result: a repository can
  // legitimately have none green at both levels, and the page must say so.
  const capabilitiesVerified = count(summary, 'capacitesVerifiees', 'resume.capacitesVerifiees');
  if (capabilitiesVerified > capabilities) {
    fail('resume.capacitesVerifiees', 'is greater than resume.capacites');
  }

  return {
    note: 'Generated by scripts/gen-reference.ts from apps/qa/data/snapshot.json. Do not edit by hand.',
    measuredOn: spellDate(text(root, 'genereLe', 'genereLe')),
    commit: text(root, 'commit', 'commit'),
    runUrl: text(run, 'url', 'execution.url'),
    capabilities,
    capabilitiesVerified,
    figures: [
      { value: String(positive(summary, 'paquets', 'resume.paquets')), label: 'packages measured' },
      {
        value: positive(summary, 'casDeTest', 'resume.casDeTest').toLocaleString('en-US'),
        label: 'test cases',
      },
      {
        value: String(positive(summary, 'fichiersDeTest', 'resume.fichiersDeTest')),
        label: 'test files',
      },
      { value: String(count(summary, 'casE2e', 'resume.casE2e')), label: 'end-to-end cases' },
      {
        value: coverageLabel(percentage(summary, 'couvertureLignes', 'resume.couvertureLignes')),
        label: 'line coverage',
      },
      {
        value: `${capabilitiesVerified} / ${capabilities}`,
        label: 'capabilities green at both levels',
      },
    ],
  };
}
