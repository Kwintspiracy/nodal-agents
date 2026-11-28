// version-compare.ts — the ONE rule for "is this version newer than that one".
//
// Every place that decides whether an update exists goes through here: the
// `update` command (which installs), the notice `up` prints, and the dashboard's
// update badge. Each used to carry its own comparison, and the one that
// INSTALLED compared with `===`: a registry answering an older version than the
// installed one (a mirror a day behind) made `update` install that older
// version over a database the newer one had already migrated.
//
// The order is semver 2.0 precedence (semver.org, section 11):
//   1. major, minor, patch, compared as numbers (`0.8.10` > `0.8.9`);
//   2. on an equal triple, a version WITHOUT a pre-release is newer than one
//      with it (`0.9.12` > `0.9.12-beta.1`);
//   3. two pre-releases compare identifier by identifier, split on `.`: two
//      numeric identifiers as numbers, a numeric one before an alphanumeric
//      one, alphanumerics in ASCII order, and a shorter list that prefixes the
//      other comes first (`rc` < `rc.1`, `rc.2` < `rc.10`);
//   4. build metadata (`+…`) is ignored.
//
// Anything that is not `x.y.z[-pre][+build]` (an optional leading `v` aside)
// is NOT ordered: `compareVersions` answers `null`, and every caller treats
// that as "cannot tell", never as a guess.

/** `-1` when `a` is older than `b`, `0` when they are the same version, `1` when newer. */
export type VersionOrder = -1 | 0 | 1;

interface ParsedVersion {
  readonly triple: readonly [number, number, number];
  readonly prerelease: readonly string[];
}

const VERSION =
  /^v?(\d+)\.(\d+)\.(\d+)(?:-([0-9A-Za-z-]+(?:\.[0-9A-Za-z-]+)*))?(?:\+[0-9A-Za-z.-]+)?$/;

function parseVersion(v: string): ParsedVersion | null {
  const m = VERSION.exec(v.trim());
  if (m === null) return null;
  return {
    triple: [Number(m[1]), Number(m[2]), Number(m[3])],
    prerelease: m[4] === undefined ? [] : m[4].split('.'),
  };
}

function sign(n: number): VersionOrder {
  return n < 0 ? -1 : n > 0 ? 1 : 0;
}

function comparePrerelease(a: readonly string[], b: readonly string[]): VersionOrder {
  // Rule 2: no pre-release beats any pre-release.
  if (a.length === 0 || b.length === 0) return sign(b.length - a.length);
  for (let i = 0; i < Math.max(a.length, b.length); i++) {
    const x = a[i];
    const y = b[i];
    if (x === undefined) return -1;
    if (y === undefined) return 1;
    const xNum = /^\d+$/.test(x);
    const yNum = /^\d+$/.test(y);
    if (xNum && yNum) {
      const d = sign(Number(x) - Number(y));
      if (d !== 0) return d;
    } else if (xNum !== yNum) {
      return xNum ? -1 : 1;
    } else if (x !== y) {
      return x < y ? -1 : 1;
    }
  }
  return 0;
}

/**
 * Order two versions by semver precedence, or `null` when either is not a
 * version this rule can order.
 */
export function compareVersions(a: string, b: string): VersionOrder | null {
  const x = parseVersion(a);
  const y = parseVersion(b);
  if (x === null || y === null) return null;
  for (let i = 0; i < 3; i++) {
    const d = sign(x.triple[i]! - y.triple[i]!);
    if (d !== 0) return d;
  }
  return comparePrerelease(x.prerelease, y.prerelease);
}

/**
 * True iff `candidate` is STRICTLY newer than `current`. False when it is the
 * same, older, or when either cannot be ordered: in doubt, nothing is offered
 * and nothing is installed.
 */
export function isNewerVersion(candidate: string, current: string): boolean {
  return compareVersions(candidate, current) === 1;
}
