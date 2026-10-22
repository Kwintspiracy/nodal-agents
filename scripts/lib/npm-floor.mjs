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

/**
 * The command line that runs the npm under test: `npx npm@<spec>` when a
 * version or tag is named (NODAL_SMOKE_NPM), the npm on PATH otherwise.
 *
 * `--no-audit --no-fund` on the npx bootstrap: npx installs the requested npm
 * into its cache, and that install POSTs the whole tree of npm's own ~100
 * dependencies to the registry's audit endpoint (`/-/npm/v1/security/advisories/bulk`)
 * before it returns. Nothing reads the answer, and the endpoint stalls without
 * answering from time to time (measured 22/10/2026: 6 cold runs of
 * `npx -y npm@latest --version` out of 8 did not return in 60 to 100 s, the 6
 * runs with `--no-audit` took 7 to 10 s each). The install step already says `--no-audit`;
 * the bootstrap now says it too, from the one place both scripts get the npm.
 * @param {string | undefined} spec
 */
export function npmUnderTest(spec) {
  return spec ? `npx -y --no-audit --no-fund npm@${spec}` : 'npm';
}
