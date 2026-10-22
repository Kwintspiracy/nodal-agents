// product-scope.ts — what "the product" is, for the bench printer's scan.
//
// The printer must never be reachable from what ships. What ships is built from
// three entry workspaces (the CLI, the runner, the web application: the three
// outputs of scripts/build-pack.mjs) and from every workspace they depend on,
// transitively. Everything else (the quality portal `apps/qa`, which catalogues
// every test file by design and so names this printer in its own snapshot; the
// docs site) is not reachable from them: no package.json of the closure lists
// it, so it cannot enter a bundle. The set is DERIVED from the manifests, not
// listed here: a new workspace is in scope the day a product workspace
// depends on it, and a generated file under an out-of-scope workspace never
// needs an exclusion line that would drift.
//
// The real gate on what ships stays the pack check
// (scripts/lib/bench-studio-absent.mjs, run by build-pack.mjs and by CI).

export const PRODUCT_ENTRIES = ['nodal-agents', '@nodal-agents/runner', '@nodal-agents/web'];

type Manifest = {
  name?: string;
  dependencies?: Record<string, string>;
  devDependencies?: Record<string, string>;
};

/**
 * The tracked files of the product workspaces, outside `excludedDir`.
 *
 * @param tracked  repo-relative, forward-slash paths of the tracked files
 * @param read     reads a tracked file as text
 * @throws when an entry workspace is missing from `tracked`: a scan over an
 *         empty or wrong scope would pass for the wrong reason.
 */
export function productFiles(
  tracked: string[],
  read: (path: string) => string,
  excludedDir: string,
): string[] {
  const dirByName = new Map<string, string>();
  const manifests = new Map<string, Manifest>();
  for (const f of tracked) {
    if (!/^(apps|packages)\/.+\/package\.json$/.test(f)) continue;
    const manifest = JSON.parse(read(f)) as Manifest;
    if (!manifest.name) continue;
    const dir = f.slice(0, -'/package.json'.length);
    dirByName.set(manifest.name, dir);
    manifests.set(dir, manifest);
  }

  for (const name of PRODUCT_ENTRIES) {
    if (!dirByName.has(name)) {
      throw new Error(`product entry workspace "${name}" is not a tracked workspace`);
    }
  }
  const inScope = new Set<string>();
  const todo = [...PRODUCT_ENTRIES];
  while (todo.length > 0) {
    const dir = dirByName.get(todo.pop()!)!;
    if (inScope.has(dir)) continue;
    inScope.add(dir);
    const m = manifests.get(dir)!;
    for (const [dep, range] of Object.entries({ ...m.devDependencies, ...m.dependencies })) {
      if (range.startsWith('workspace:') && dirByName.has(dep)) todo.push(dep);
    }
  }

  const dirs = [...inScope].map((d) => `${d}/`);
  return tracked.filter((f) => !f.startsWith(excludedDir) && dirs.some((d) => f.startsWith(d)));
}
