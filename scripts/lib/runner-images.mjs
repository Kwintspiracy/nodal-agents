// runner-images.mjs — find the moving runner labels in a workflow file (issue #882).
//
// `ubuntu-latest`, `windows-latest` and `macos-latest` follow an image GitHub
// switches without notice. On 2026-10-30 `ubuntu-latest` became Ubuntu 26.04
// and Playwright 1.60 refused to install Chromium there: every PR went red on a
// day nothing in the repository had changed. A workflow names its image.
//
// The labels are read WHERE and AS GitHub reads them: the workflow is parsed as
// YAML and only the `runs-on` of each job is looked at, in every form it takes
// (string, list, `{ group, labels }`), following `${{ matrix.X }}` into
// `strategy.matrix.X` and its `include` entries. A name, a `run:` script or a
// comment that mentions `ubuntu-latest` is none of that and is not read (a
// first version scanned lines for the token: it flagged `echo "ex ubuntu-latest"`
// and, cutting at any ` #`, missed a label after a `#` inside a quoted string).
//
// GitHub matches labels case-insensitively, so `Ubuntu-Latest` is caught.
//
// A `runs-on` composed at run time (`vars.`, `inputs.`, `fromJSON(`, a ternary)
// cannot be checked from the file: it is refused and named, never waved
// through (invariant #4).

import { LineCounter, parseDocument } from 'yaml';

/** `ubuntu-latest`, `windows-latest`, `macos-latest`, and the larger-runner forms (`ubuntu-latest-8-cores`). */
const MOVING_LABEL = /^(?:ubuntu|windows|macos)-latest(?:-.+)?$/i;
const MATRIX_REF = /^\$\{\{\s*matrix\.([A-Za-z_][\w-]*)\s*\}\}$/;

/**
 * @typedef {{ line: number, value: string, kind: 'moving' | 'unverifiable', why: string }} Finding
 */

/**
 * Every `runs-on` label of `text` that moves or cannot be verified.
 * @param {string} text
 * @returns {Finding[]}
 */
export function findMovingLabels(text) {
  const lineCounter = new LineCounter();
  const doc = parseDocument(text, { lineCounter });
  if (doc.errors.length > 0) {
    throw new Error(`not a valid YAML workflow: ${doc.errors[0].message}`);
  }
  const root = doc.toJS();
  const jobs = root && typeof root === 'object' ? root.jobs : undefined;
  if (!jobs || typeof jobs !== 'object') return [];

  /** Line of the node at `path`, or of the closest ancestor that exists. */
  const lineAt = (path) => {
    for (let n = path.length; n >= 0; n--) {
      const node = doc.getIn(path.slice(0, n), true);
      const start = node && typeof node === 'object' && node.range ? node.range[0] : undefined;
      if (start !== undefined) return lineCounter.linePos(start).line;
    }
    return 1;
  };

  /** @type {Finding[]} */
  const found = [];
  const judge = (value, path, via) => {
    if (typeof value !== 'string') {
      found.push({
        line: lineAt(path),
        value: JSON.stringify(value),
        kind: 'unverifiable',
        why: `${via} is not a string`,
      });
    } else if (value.includes('${{')) {
      found.push({
        line: lineAt(path),
        value,
        kind: 'unverifiable',
        why: `${via} is composed at run time, the guard cannot check it`,
      });
    } else if (MOVING_LABEL.test(value.trim())) {
      found.push({ line: lineAt(path), value: value.trim(), kind: 'moving', why: via });
    }
  };

  for (const [jobId, job] of Object.entries(jobs)) {
    if (!job || typeof job !== 'object' || !('runs-on' in job)) continue;
    const base = ['jobs', jobId, 'runs-on'];
    const runsOn = job['runs-on'];

    // `{ group, labels }`: the group is a runner-group name, only `labels` are labels.
    const entries = [];
    if (runsOn && typeof runsOn === 'object' && !Array.isArray(runsOn)) {
      const labels = runsOn.labels;
      if (Array.isArray(labels)) {
        labels.forEach((l, i) => entries.push([l, [...base, 'labels', i]]));
      } else if (labels !== undefined) {
        entries.push([labels, [...base, 'labels']]);
      }
    } else if (Array.isArray(runsOn)) {
      runsOn.forEach((l, i) => entries.push([l, [...base, i]]));
    } else {
      entries.push([runsOn, base]);
    }

    for (const [value, path] of entries) {
      const ref = typeof value === 'string' ? MATRIX_REF.exec(value.trim()) : null;
      if (!ref) {
        judge(value, path, '`runs-on`');
        continue;
      }
      // `${{ matrix.X }}`: judge every value X takes, in the matrix and its includes.
      const key = ref[1];
      const matrixPath = ['jobs', jobId, 'strategy', 'matrix'];
      const matrix = job.strategy?.matrix;
      if (!matrix || typeof matrix !== 'object') {
        judge(value, path, `\`runs-on: ${value}\` (no static matrix to follow)`);
        continue;
      }
      const reached = [];
      const axis = matrix[key];
      if (axis !== undefined) {
        if (Array.isArray(axis)) axis.forEach((v, i) => reached.push([v, [...matrixPath, key, i]]));
        else reached.push([axis, [...matrixPath, key]]);
      }
      if (Array.isArray(matrix.include)) {
        matrix.include.forEach((inc, i) => {
          if (inc && typeof inc === 'object' && key in inc) {
            reached.push([inc[key], [...matrixPath, 'include', i, key]]);
          }
        });
      } else if (matrix.include !== undefined) {
        judge(matrix.include, [...matrixPath, 'include'], '`matrix.include`');
      }
      if (reached.length === 0) {
        judge(value, path, `\`runs-on: ${value}\` (\`matrix.${key}\` has no static value)`);
      }
      for (const [v, p] of reached) judge(v, p, `\`matrix.${key}\``);
    }
  }
  return found.sort((a, b) => a.line - b.line);
}

/** One readable line per finding, for a failure message. */
export function describeFinding(file, { line, value, kind, why }) {
  return kind === 'moving'
    ? `${file}:${line}: ${value} (${why}) is a moving label, name an image`
    : `${file}:${line}: ${value} (${why}) cannot be verified, name an image`;
}
