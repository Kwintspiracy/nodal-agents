// coding-rollup.test.ts — the Code tab's delegation rollup.
//
// The bug this pins: rolling up ONE level splits a three-level coding session
// in half. On a root orchestrator → lead → worker team, the worker's CLI
// attempts land in the lead's bucket while the lead's own writes roll up into
// the root's, so neither half carries enough signal to qualify as coding and
// the whole session vanishes from the tab.
//
// Measured live on 2026-08-20 before this fix: with a one-level rollup AND the
// refused-call filter, the entity showed 0 coding processes. With the
// transitive rollup, the same data shows 5 — and they are attributed to the
// agent that actually received the request (Alfred, via telegram) instead of
// the internal lead.

import { describe, it, expect } from 'vitest';
import { rollupRoot, pipelineMembers, ROLLUP_MAX_DEPTH } from '../coding-rollup.ts';

// root ── lead ── worker : the shape that broke.
const THREE_LEVEL = new Map<string, string | null>([
  ['root', null],
  ['lead', 'root'],
  ['worker', 'lead'],
]);

describe('rollupRoot', () => {
  it('returns the job itself when it has no parent', () => {
    expect(rollupRoot('root', THREE_LEVEL)).toBe('root');
  });

  it('folds a direct child into its parent', () => {
    expect(rollupRoot('lead', THREE_LEVEL)).toBe('root');
  });

  it('folds a GRANDCHILD all the way to the root — the actual fix', () => {
    // One-level rollup answered 'lead' here, which is what split the session.
    expect(rollupRoot('worker', THREE_LEVEL)).toBe('root');
  });

  it('puts a whole delegation chain in ONE bucket', () => {
    const roots = new Set(['root', 'lead', 'worker'].map((id) => rollupRoot(id, THREE_LEVEL)));
    expect(roots).toEqual(new Set(['root']));
  });

  it('stops at the deepest KNOWN job when an ancestor was not loaded', () => {
    // 'lead' is known and claims a parent we never loaded: we must not invent
    // it, and must not walk past what we know.
    const partial = new Map<string, string | null>([['lead', 'unloaded-root']]);
    expect(rollupRoot('lead', partial)).toBe('unloaded-root');
    // A job absent from the map is its own root, not an error.
    expect(rollupRoot('stranger', partial)).toBe('stranger');
  });

  it('terminates on a corrupt parent cycle instead of hanging the page', () => {
    const cyclic = new Map<string, string | null>([
      ['a', 'b'],
      ['b', 'a'],
    ]);
    // Whatever it returns, it must RETURN — a cycle used to be unreachable
    // only because the walk was one step long.
    expect(['a', 'b']).toContain(rollupRoot('a', cyclic));
  });

  it('stops after ROLLUP_MAX_DEPTH on a pathologically deep chain', () => {
    const deep = new Map<string, string | null>();
    for (let i = 0; i < 50; i++) deep.set(`j${i}`, `j${i + 1}`);
    deep.set('j50', null);
    // Bounded walk: it does not reach j50, and it does not loop.
    expect(rollupRoot('j0', deep)).toBe(`j${ROLLUP_MAX_DEPTH}`);
  });
});

describe('pipelineMembers', () => {
  const CHILDREN = new Map<string, string[]>([
    ['root', ['lead']],
    ['lead', ['worker']],
  ]);

  it('includes descendants at EVERY depth, not just direct children', () => {
    const { memberIds } = pipelineMembers(['root'], CHILDREN);
    expect(new Set(memberIds)).toEqual(new Set(['root', 'lead', 'worker']));
  });

  it('maps every member back to its root, so cost and files land on one pipeline', () => {
    const { rootForMember } = pipelineMembers(['root'], CHILDREN);
    expect(rootForMember.get('root')).toBe('root');
    expect(rootForMember.get('lead')).toBe('root');
    // This is the one a one-level rollup got wrong: the worker's cli_runs cost
    // was attributed to the lead, i.e. to a pipeline the user never sees.
    expect(rootForMember.get('worker')).toBe('root');
  });

  it('keeps two independent pipelines apart', () => {
    const children = new Map<string, string[]>([
      ['r1', ['a']],
      ['a', ['a2']],
      ['r2', ['b']],
    ]);
    const { rootForMember } = pipelineMembers(['r1', 'r2'], children);
    expect(rootForMember.get('a2')).toBe('r1');
    expect(rootForMember.get('b')).toBe('r2');
  });

  it('returns just the roots when nothing was delegated', () => {
    const { memberIds } = pipelineMembers(['solo'], new Map());
    expect(memberIds).toEqual(['solo']);
  });

  it('terminates on a cycle in the children map', () => {
    const cyclic = new Map<string, string[]>([
      ['a', ['b']],
      ['b', ['a']],
    ]);
    const { memberIds } = pipelineMembers(['a'], cyclic);
    expect(new Set(memberIds)).toEqual(new Set(['a', 'b']));
  });
});
