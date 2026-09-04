// verification-runs-view.test.ts — les helpers purs de la vue de lecture des
// preuves (T24) : groupage par séquence, tri par rang, verdict de séquence,
// fusion des traces D8.

import { describe, it, expect } from 'vitest';
import {
  groupVerificationRuns,
  sequenceVerdict,
  mergeSkippedSurfaces,
  surfaceLabel,
  type VerificationRunSource,
} from '../verification-runs-view.ts';

function row(
  over: Partial<VerificationRunSource> & { sequenceId: string; commandRank: number },
): VerificationRunSource {
  return {
    jobId: 'job-a',
    deliverableType: 'code_project',
    canonicalKey: 'd:/apps/x',
    command: `cmd-${over.commandRank}`,
    exitCode: 0,
    outcomeKind: 'exit',
    durationMs: 10,
    verdict: 'green',
    testedGeneration: 1,
    testedEpoch: 0,
    createdAt: new Date('2026-09-04T10:00:00Z'),
    ...over,
  };
}

describe('groupVerificationRuns', () => {
  it('groupe par séquence et trie par rang quel que soit l’ordre des lignes', () => {
    const later = new Date('2026-09-04T11:00:00Z');
    const seqs = groupVerificationRuns([
      row({ sequenceId: 'S2', commandRank: 1, createdAt: later, jobId: 'job-b' }),
      row({ sequenceId: 'S1', commandRank: 3, verdict: 'red', exitCode: 1 }),
      row({ sequenceId: 'S1', commandRank: 1 }),
      row({ sequenceId: 'S1', commandRank: 2 }),
    ]);
    expect(seqs.map((s) => s.sequenceId)).toEqual(['S1', 'S2']);
    expect(seqs[0]!.runs.map((r) => r.commandRank)).toEqual([1, 2, 3]);
    expect(seqs[0]!.runs.map((r) => r.command)).toEqual(['cmd-1', 'cmd-2', 'cmd-3']);
    expect(seqs[0]!.verdict).toBe('red');
    expect(seqs[0]!.jobId).toBe('job-a');
    expect(seqs[1]!.jobId).toBe('job-b');
    expect(seqs[1]!.verdict).toBe('green');
    expect(seqs[1]!.startedAt).toBe(later.toISOString());
  });

  it('rend [] sans ligne', () => {
    expect(groupVerificationRuns([])).toEqual([]);
  });
});

describe('sequenceVerdict', () => {
  it('infra_error prime, puis red, sinon green ; vide ⇒ infra_error (jamais un faux vert)', () => {
    expect(sequenceVerdict([{ verdict: 'green' }, { verdict: 'green' }])).toBe('green');
    expect(sequenceVerdict([{ verdict: 'green' }, { verdict: 'red' }])).toBe('red');
    expect(sequenceVerdict([{ verdict: 'red' }, { verdict: 'infra_error' }])).toBe('infra_error');
    expect(sequenceVerdict([])).toBe('infra_error');
  });
});

describe('mergeSkippedSurfaces', () => {
  it('union dédoublonnée dans l’ordre des clés connues, inconnues après, non-chaînes ignorées', () => {
    expect(
      mergeSkippedSurfaces([
        ['shell', 'fileOps'],
        ['zzz', 'fileOps', 42, ''],
        null,
        'pas-un-tableau',
        ['codeTask', 'aaa'],
      ]),
    ).toEqual(['codeTask', 'fileOps', 'shell', 'aaa', 'zzz']);
    expect(mergeSkippedSurfaces([[], null])).toEqual([]);
  });
});

describe('surfaceLabel', () => {
  it('libelle les clés connues et rend la clé brute sinon', () => {
    expect(surfaceLabel('fileOps')).toBe('File tools');
    expect(surfaceLabel('mystère')).toBe('mystère');
  });
});
