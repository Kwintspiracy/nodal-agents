// coding-rollup.ts — how a delegation tree folds into ONE coding pipeline.
//
// Deliberately NOT in actions.ts. That file is `'use server'`, where every
// export must be an async server action: exporting a sync helper there is a
// BUILD error that neither `tsc --noEmit` nor the vitest suite catches (learned
// the hard way — it only shows up in the browser). Pure logic lives here, where
// it can also be unit-tested against real shapes.
//
// ── Why this exists ──────────────────────────────────────────────────────────
// The Code tab used to roll up ONE level: "root job + direct children". On a
// three-level team (root orchestrator → lead → worker) that splits a single
// coding session in half — the worker's CLI attempts land in the lead's bucket
// while the lead's own writes roll up into the root's, so neither half looks
// like coding on its own and the session disappears from the tab. Rolling up to
// the true delegation ROOT, at any depth, is what makes a pipeline whole.

/**
 * Hard stop on ancestor/descendant walks. Invariant #8 caps real delegation at
 * 3 levels; this leaves room and guarantees termination on a corrupt parent
 * chain (a cycle would otherwise hang the page).
 */
export const ROLLUP_MAX_DEPTH = 8;

/**
 * The delegation ROOT of a job: walk parents until one has no parent, or until
 * the parent is unknown to the map.
 *
 * An unknown parent means "not loaded", not "no parent" — the caller resolves
 * ancestors level by level, so anything still missing is outside the window.
 * We stop at the deepest job we actually know about rather than inventing one.
 *
 * Cycle-safe: a job that reappears on its own ancestor chain (corrupt data)
 * ends the walk instead of looping forever.
 */
export function rollupRoot(jobId: string, parentOf: Map<string, string | null>): string {
  let current = jobId;
  const seen = new Set<string>([current]);
  for (let depth = 0; depth < ROLLUP_MAX_DEPTH; depth++) {
    const parent = parentOf.get(current);
    // undefined = unknown job (outside the loaded window); null = a real root.
    if (parent === undefined || parent === null) return current;
    if (seen.has(parent)) return current; // cycle — stop where we are
    seen.add(parent);
    current = parent;
  }
  return current;
}

/**
 * Every descendant of `rootIds`, at any depth, plus a member→root index.
 *
 * `childrenOf` maps a job to its DIRECT children. The walk is breadth-first and
 * bounded by ROLLUP_MAX_DEPTH, and each visited job maps back to the root it
 * descends from — which is what lets cost and file rows land on the pipeline
 * the user is actually looking at, however deep the worker sat.
 */
export function pipelineMembers(
  rootIds: string[],
  childrenOf: Map<string, string[]>,
): { memberIds: string[]; rootForMember: Map<string, string> } {
  const rootForMember = new Map<string, string>();
  for (const id of rootIds) rootForMember.set(id, id);

  let frontier = rootIds;
  for (let depth = 0; depth < ROLLUP_MAX_DEPTH && frontier.length > 0; depth++) {
    const next: string[] = [];
    for (const parent of frontier) {
      const root = rootForMember.get(parent);
      if (root === undefined) continue;
      for (const child of childrenOf.get(parent) ?? []) {
        if (rootForMember.has(child)) continue; // already placed (or a cycle)
        rootForMember.set(child, root);
        next.push(child);
      }
    }
    frontier = next;
  }

  return { memberIds: Array.from(rootForMember.keys()), rootForMember };
}
