// path-holders.test.ts — which agent has a named folder, when the roster only
// lists ROOTS (#506, Codex review pass 3, P1).
//
// Run 0b505b0d: "Nodal-Video" was in Montage's folder
// (C:\Users\kwint\Documents\Nodal\Montage\Nodal-Video). The roster lists the
// root, not its subfolders, so a router reading "a folder not listed belongs
// to nobody" could still conclude nobody had it — the very bug of the ticket.

import { describe, it, expect } from 'vitest';
import { holdersOfPath } from '../path-holders';

const ROSTER = [
  {
    agent: 'Montage',
    folders: [
      { label: 'Montage', path: 'C:\\Users\\kwint\\Documents\\Nodal\\Montage' },
      { label: 'shared', path: '/home/u/.nodalai/workspaces/e1/shared' },
    ],
  },
  { agent: 'Lead', folders: [{ label: 'Dev', path: 'C:\\Users\\kwint\\Documents\\Dev' }] },
];

describe('holdersOfPath @cap:organiser-equipe/moteur', () => {
  it('a path UNDER a listed root belongs to that root’s agent', () => {
    expect(
      holdersOfPath('C:\\Users\\kwint\\Documents\\Nodal\\Montage\\Nodal-Video', ROSTER),
    ).toEqual({ kind: 'held', agents: ['Montage'] });
    // Separators and drive-letter case do not change the answer.
    expect(
      holdersOfPath('c:/Users/kwint/Documents/Nodal/Montage/Nodal-Video/a.mp4', ROSTER),
    ).toEqual({ kind: 'held', agents: ['Montage'] });
  });

  it('a path given with a folder label resolves under that label', () => {
    expect(holdersOfPath('Montage/Nodal-Video', ROSTER)).toEqual({
      kind: 'held',
      agents: ['Montage'],
    });
  });

  it('a shared folder belongs to every agent that has it', () => {
    const two = [
      ...ROSTER,
      {
        agent: 'Dev C',
        folders: [{ label: 'shared', path: '/home/u/.nodalai/workspaces/e1/shared' }],
      },
    ];
    expect(holdersOfPath('/home/u/.nodalai/workspaces/e1/shared/out.txt', two)).toEqual({
      kind: 'held',
      agents: ['Montage', 'Dev C'],
    });
  });

  it('an absolute path under NO listed root belongs to nobody', () => {
    expect(holdersOfPath('D:\\Elsewhere\\Nodal-Video', ROSTER)).toEqual({ kind: 'nobody' });
    // A sibling that merely shares a prefix is not "under" the root.
    expect(holdersOfPath('C:\\Users\\kwint\\Documents\\DevOld\\x', ROSTER)).toEqual({
      kind: 'nobody',
    });
  });

  it('a bare name cannot be placed from the roster alone: undetermined, never "nobody"', () => {
    expect(holdersOfPath('Nodal-Video', ROSTER)).toEqual({ kind: 'undetermined' });
  });
});
