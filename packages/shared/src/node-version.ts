// node-version.ts — the minimum Node.js the CLI runs on (#628).
// `engines` alone only makes npm warn (engine-strict is off by default), so the
// binary checks for itself. Keep this file free of modern syntax and APIs: it
// has to load on the very Node it is about to refuse.

export const MINIMUM_NODE_MAJOR = 24;

/** The reason this Node cannot run Nodal, or null when it can. */
export function nodeVersionProblem(version: string): string | null {
  const match = /^v?(\d+)\.\d+\.\d+/.exec(version);
  const major = match ? Number(match[1]) : NaN;
  if (!(major >= MINIMUM_NODE_MAJOR)) {
    return (
      'Nodal needs Node.js ' +
      MINIMUM_NODE_MAJOR +
      ' or newer; this is Node.js ' +
      version +
      '. Install Node ' +
      MINIMUM_NODE_MAJOR +
      ': https://nodejs.org'
    );
  }
  return null;
}
