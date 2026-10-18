// subjects.test.ts — les sujets de recherche calibrés : lus, ou refusés en le disant.
//
// Décision 3 du 17/10 : un sujet n'est accepté que si chaque modèle comparé,
// interrogé sans outil, se trompe ou refuse au moins 2 fois sur 3. Le fichier
// prouve la calibration ; un fichier qui ne la prouve pas est une erreur, jamais
// un sujet accepté en silence, et un fichier absent n'est jamais remplacé par un
// sujet par défaut.

import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import {
  SUBJECTS_FILE,
  noSubjectReason,
  pickSubject,
  readResearchSubjects,
  requestWithSubject,
  subjectFacts,
} from '../subjects';

const file = (content: unknown): string => {
  const p = join(mkdtempSync(join(tmpdir(), 'subjects-')), 'research-subjects.json');
  writeFileSync(p, typeof content === 'string' ? content : JSON.stringify(content));
  return p;
};
const SUBJECT = {
  id: 'phare-kerbenec',
  kind: 'research',
  request: 'la mise en service du phare de Kerbénec',
  facts: [{ says: 'give 1897', pattern: '\\b1897\\b' }],
  calibration: [
    { model: 'a', asked: 3, wrong: 3 },
    { model: 'b', asked: 3, wrong: 2 },
  ],
};

describe('calibrated research subjects', () => {
  it('the repository holds no calibrated subject yet: the research scenarios are skipped (#776)', () => {
    expect(readResearchSubjects(SUBJECTS_FILE)).toEqual([]);
    expect(noSubjectReason('research')).toBe(
      'no calibrated research subject (kind research) in packages/bench/subjects/research-subjects.json: the trial does not run on a subject models know from memory (#776)',
    );
  });

  it('a calibrated subject is read with its facts, and picked by its kind only', () => {
    const subjects = readResearchSubjects(file({ subjects: [SUBJECT] }));
    expect(subjects).toEqual([
      {
        id: 'phare-kerbenec',
        kind: 'research',
        request: 'la mise en service du phare de Kerbénec',
        facts: [{ says: 'give 1897', pattern: '\\b1897\\b', flags: '' }],
        calibratedOn: ['a', 'b'],
      },
    ]);
    expect(pickSubject('research', subjects)?.id).toBe('phare-kerbenec');
    expect(pickSubject('deep-research', subjects)).toBeNull();
    const [fact] = subjectFacts(subjects[0]!);
    expect([fact!.holds('mis en service en 1897'), fact!.holds('en 18970')]).toEqual([true, false]);
  });

  it('a model that answers from memory more than once in three refuses the subject, naming the model', () => {
    const weak = {
      ...SUBJECT,
      calibration: [
        { model: 'a', asked: 3, wrong: 3 },
        { model: 'b', asked: 3, wrong: 1 },
      ],
    };
    expect(() => readResearchSubjects(file({ subjects: [weak] }))).toThrow(
      'workflow_subject_not_calibrated: phare-kerbenec is answered from memory too often (b wrong 1/3); a subject needs at least 2 wrong answers out of 3 for every model',
    );
    const short = { ...SUBJECT, calibration: [{ model: 'a', asked: 2, wrong: 2 }] };
    expect(() => readResearchSubjects(file({ subjects: [short] }))).toThrow(/a wrong 2\/2/);
  });

  it('a file that is not JSON, not the shape, or a pattern that does not compile is an error', () => {
    expect(() => readResearchSubjects(file('{ not json'))).toThrow(
      /^workflow_subjects_unreadable: .* is not JSON/,
    );
    expect(() => readResearchSubjects(file({ subjects: [{ id: 'x' }] }))).toThrow(
      /does not have the subjects shape/,
    );
    const bad = { ...SUBJECT, facts: [{ says: 'x', pattern: '(' }] };
    expect(() => readResearchSubjects(file({ subjects: [bad] }))).toThrow(
      /pattern "\(" does not compile/,
    );
  });

  it('the subject goes into the request at its slot; a request without the slot is an error', () => {
    const [s] = readResearchSubjects(file({ subjects: [SUBJECT] }));
    expect(requestWithSubject('Cherche {subject}, avec tes sources.', s!)).toBe(
      'Cherche la mise en service du phare de Kerbénec, avec tes sources.',
    );
    expect(() => requestWithSubject('Cherche quelque chose.', s!)).toThrow(
      'workflow_subject_slot_missing',
    );
  });
});
