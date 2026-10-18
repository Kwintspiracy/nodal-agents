// npm-floor.mjs — compare two `major.minor.patch` versions (prerelease ignored).

/**
 * Negative when `a` < `b`, 0 when equal, positive when `a` > `b`.
 * Fails loud on anything that is not `x.y.z`: a floor check that compares
 * garbage would pass or fail for no reason.
 * @param {string} a
 * @param {string} b
 */
export function compareVersions(a, b) {
  const parse = (v) => {
    const m = /^(\d+)\.(\d+)\.(\d+)(?:[-+].*)?$/.exec(String(v).trim());
    if (!m) throw new Error(`not a version: "${v}"`);
    return m.slice(1, 4).map(Number);
  };
  const [x, y] = [parse(a), parse(b)];
  for (let i = 0; i < 3; i++) {
    if (x[i] !== y[i]) return x[i] - y[i];
  }
  return 0;
}
