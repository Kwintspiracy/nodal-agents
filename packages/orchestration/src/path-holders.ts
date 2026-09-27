// path-holders.ts — which agent of a roster has a named folder or path.
//
// The team block lists each agent's folders as ROOTS (label = absolute path).
// An agent has a root AND everything inside it. Run 0b505b0d: "Nodal-Video"
// lived inside Montage's root, so "not in the list" never meant "nobody has
// it" (Codex review of #506, pass 3). This is the rule the block's
// ground-truth sentence states, as a pure function, so it is tested here and
// not only asserted in prose.

export interface RosterFolders {
  agent: string;
  folders: ReadonlyArray<{ label: string; path: string }>;
}

export type PathHolders =
  | { kind: 'held'; agents: string[] }
  | { kind: 'nobody' }
  /** A bare name: it may be inside any listed root; only looking there can tell. */
  | { kind: 'undetermined' };

/** Forward slashes, no trailing slash, and a drive letter compared without case. */
function normalize(p: string): string {
  const slashed = p.trim().replace(/\\/g, '/').replace(/\/+$/, '');
  return /^[a-z]:\//i.test(slashed) ? slashed[0]!.toLowerCase() + slashed.slice(1) : slashed;
}

function isAbsolute(p: string): boolean {
  return /^[a-z]:\//i.test(p) || p.startsWith('/');
}

/** True when `path` is `root` or lies inside it (a sibling sharing a prefix is not). */
function isUnder(path: string, root: string): boolean {
  return path === root || path.startsWith(`${root}/`);
}

/**
 * Who has `named`: an absolute path is placed under the roots that contain it;
 * a relative path whose first segment is a folder label is placed under that
 * label; a bare name is undetermined — the roster lists roots, not their
 * contents, so it is never "nobody" on the roster's word alone.
 */
export function holdersOfPath(named: string, roster: ReadonlyArray<RosterFolders>): PathHolders {
  const target = normalize(named);
  const agents: string[] = [];
  if (isAbsolute(target)) {
    for (const r of roster) {
      if (r.folders.some((f) => isUnder(target, normalize(f.path)))) agents.push(r.agent);
    }
    return agents.length > 0 ? { kind: 'held', agents } : { kind: 'nobody' };
  }
  const [first, ...rest] = target.split('/');
  if (rest.length === 0) return { kind: 'undetermined' };
  for (const r of roster) {
    if (r.folders.some((f) => f.label === first)) agents.push(r.agent);
  }
  return agents.length > 0 ? { kind: 'held', agents } : { kind: 'undetermined' };
}
