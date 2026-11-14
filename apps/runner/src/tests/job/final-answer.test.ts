// final-answer.test.ts — la réponse d'un job est celle qu'il donne quand il
// FINIT (#1083), lue dans la transcription par `answerOfRun`.
//
// La lecture pure, sur toutes les formes de fin. Les mêmes formes passent par
// le vrai `executeJob` dans final-answer-run.test.ts.

import { describe, it, expect } from 'vitest';
import { answerOfRun } from '../../job/final-answer.ts';
import { REPAIR_BRIEF_MARK, buildRepairBrief } from '../../verification/repair-brief.ts';

type Call = { name: string; input?: Record<string, unknown> };

const user = (content: string) => ({ role: 'user', content });
const step = (text: string, ...calls: Call[]) => ({
  role: 'assistant',
  content: [
    ...(text ? [{ type: 'text', text }] : []),
    ...calls.map((c, i) => ({
      type: 'tool-call',
      toolCallId: `c-${c.name}-${i}`,
      toolName: c.name,
      input: c.input ?? {},
    })),
  ],
});
const tool = () => ({ role: 'tool', content: [] });
const done = (reason?: string): Call => ({
  name: 'return_result',
  input: reason === undefined ? { status: 'success' } : { status: 'success', reason },
});
const write = (path: string): Call => ({ name: 'file_write', input: { path, content: 'x' } });

const brief = buildRepairBrief([
  {
    deliverable: 'D:/ws/doc.html',
    record: {
      command: 'well-formed:html',
      exitCode: 1,
      outcomeKind: 'exited',
      stdoutTail: '',
      stderrTail: '<div> opened at line 68 is never closed',
    } as never,
    turnsLeft: 0,
  },
]);

const NARRATION = 'The PDF came out at 2 pages. I will tighten the text, then re-render.';
const REPORT = 'Done: one A4 page, page_count 1, saved to out/doc.pdf. Sources: NIST.';
const REASON = 'One-page A4 PDF rendered and checked: page_count 1, 594.96 x 841.92 pt.';
const NOTE = 'Closed the div at line 68; only the HTML changed.';

describe('answerOfRun — la réponse est celle de la fin @cap:organiser-equipe/moteur', () => {
  it('forme B : un texte suivi de travail, puis return_result(reason) seul → le reason', () => {
    expect(
      answerOfRun([
        user('task'),
        step(NARRATION, write('doc.html')),
        tool(),
        step('', write('doc.html')),
        tool(),
        step('', done(REASON)),
      ]),
    ).toBe(REASON);
  });

  it('forme B sans reason : aucune réponse, jamais la narration', () => {
    expect(
      answerOfRun([
        user('task'),
        step(NARRATION),
        step('', write('doc.html')),
        tool(),
        step('', done()),
      ]),
    ).toBe('');
  });

  it('un texte dans un pas qui AGIT sans finir est écrit avant ses appels : périmé', () => {
    expect(
      answerOfRun([user('task'), step(NARRATION, write('doc.html')), tool(), step('', done())]),
    ).toBe('');
  });

  it('inchangé : un rapport et return_result dans le même pas (même avec un reason)', () => {
    expect(answerOfRun([user('task'), step(REPORT, done('done'))])).toBe(REPORT);
    // Ses outils frères du pas qui finit ne périment pas le rapport.
    expect(answerOfRun([user('task'), step(REPORT, write('doc.html'), done())])).toBe(REPORT);
  });

  it('inchangé : un rapport, puis return_result seul au pas suivant, sans travail entre', () => {
    expect(answerOfRun([user('task'), step(REPORT), step('', done('Report above.'))])).toBe(REPORT);
  });

  it('inchangé : une réponse sans appel d’outil', () => {
    expect(answerOfRun([user('task'), step('', write('a')), tool(), step(REPORT)])).toBe(REPORT);
  });

  it('un reason de BLOCAGE n’est jamais une réponse de succès', () => {
    expect(
      answerOfRun([
        user('task'),
        step(NARRATION, write('a')),
        tool(),
        step('', { name: 'return_result', input: { status: 'blocked', reason: 'no key' } }),
      ]),
    ).toBe('');
  });

  it('dashboard_publish est une réponse écrite, pas un travail', () => {
    expect(
      answerOfRun([
        user('task'),
        step(NARRATION, write('a')),
        tool(),
        step('', { name: 'dashboard_publish', input: { text: REPORT } }, done('published')),
      ]),
    ).toBe(REPORT);
  });

  it('quand un outil d’envoi porte les réponses (#649), le reason n’est pas la réponse', () => {
    expect(
      answerOfRun([
        user('task'),
        step('Let me check.', { name: 'web_search' }),
        tool(),
        step('', { name: 'telegram_send_message', input: { text: REPORT } }, done('Sent.')),
      ]),
    ).toBe('');
    // … et un texte écrit dans le pas qui finit reste lu comme avant.
    expect(
      answerOfRun([
        user('task'),
        step('Voici.', { name: 'telegram_send_message', input: { text: REPORT } }, done('Sent.')),
      ]),
    ).toBe('Voici.');
  });

  it('forme A : la réponse d’avant la preuve, PUIS la note de réparation', () => {
    expect(
      answerOfRun([
        user('task'),
        step('', write('doc.html')),
        tool(),
        step(REPORT, done()),
        tool(),
        user(brief),
        step('', write('doc.html')),
        tool(),
        step(NOTE, done()),
      ]),
    ).toBe(`${REPORT}\n\n${NOTE}`);
  });

  it('forme A, deux réparations, fins différentes : chaque section ajoute ce qu’elle a dit', () => {
    expect(
      answerOfRun([
        user('task'),
        step(REPORT, done()),
        tool(),
        user(brief),
        step('Trying again.', write('doc.html')),
        tool(),
        step('', done('First repair: closed one div.')),
        tool(),
        user(brief),
        step('', write('doc.html')),
        tool(),
        step('Second repair: closed the last div.'),
      ]),
    ).toBe(`${REPORT}\n\nFirst repair: closed one div.\n\nSecond repair: closed the last div.`);
  });

  it('une réparation qui ne dit rien laisse la réponse d’avant, et une redite n’est pas doublée', () => {
    expect(
      answerOfRun([
        user('task'),
        step(REPORT, done()),
        tool(),
        user(brief),
        step('', write('doc.html')),
        tool(),
        step('', done()),
      ]),
    ).toBe(REPORT);
    expect(
      answerOfRun([user('task'), step(REPORT, done()), tool(), user(brief), step(REPORT, done())]),
    ).toBe(REPORT);
  });

  it('le brief de réparation porte sa marque, et seul un message qui la porte sépare', () => {
    expect(brief.startsWith(REPAIR_BRIEF_MARK)).toBe(true);
    // Un message de la personne qui cite le brief sans la marque ne sépare rien.
    expect(
      answerOfRun([
        user('task'),
        step(REPORT, done()),
        user(brief.slice(REPAIR_BRIEF_MARK.length)),
        step(NOTE),
      ]),
    ).toBe(NOTE);
  });
});
