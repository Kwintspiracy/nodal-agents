// types.ts — the shape of a bench run.
//
// The test suite answers "did anything break?". The bench answers a different
// question: "what CHANGED, and by how much, since last time?" — which is the
// one you need when adding a model, a provider, or a tool, because the honest
// answer is usually "these four numbers moved" rather than pass/fail.
//
// So a section produces MEASUREMENTS, stored under bench/baselines/, and every
// run is diffed against the stored one.

/** Which way is better. `exact` means any change at all is a regression. */
export type Direction = 'lower-is-better' | 'higher-is-better' | 'exact';

export interface Metric {
  id: string;
  label: string;
  value: number;
  unit: string;
  direction: Direction;
  /**
   * Free-form detail kept OUT of the comparison — names of the offending
   * files, the model ids that drifted. The number is what is compared; this is
   * what makes a regression actionable instead of merely visible.
   */
  detail?: string[];
}

export interface Section {
  id: string;
  label: string;
  /** One sentence: what breaks in production if this section regresses. */
  why: string;
  /**
   * Vitest targets covering this section, as `<pnpm filter>:<path glob>`.
   * `pnpm bench --section <id> --tests` runs exactly these — the "re-run only
   * what this change touches" path.
   */
  tests: readonly string[];
  run(): Promise<Metric[]>;
}

export interface SectionResult {
  sectionId: string;
  metrics: Metric[];
  durationMs: number;
  /** Set when the section itself failed to run — never silently treated as 0. */
  error?: string;
}

export interface BenchRun {
  startedAt: string;
  /** Commit the measurement belongs to. A number without a sha is a rumour. */
  gitSha: string;
  sections: SectionResult[];
}

export type Verdict = 'new' | 'unchanged' | 'improved' | 'regressed' | 'gone';

export interface MetricDiff {
  metricId: string;
  label: string;
  unit: string;
  before: number | null;
  after: number | null;
  delta: number | null;
  verdict: Verdict;
  detail?: string[];
}

export interface SectionDiff {
  sectionId: string;
  label: string;
  diffs: MetricDiff[];
  regressed: boolean;
  error?: string;
}
