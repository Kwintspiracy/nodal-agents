// final-answer.test.ts — la réponse d'un job est celle qu'il donne quand il
// FINIT (#1083), lue dans la transcription par `answerOfRun`.
//
// La lecture pure, sur toutes les formes de fin. Les mêmes formes passent par
// le vrai `executeJob` dans final-answer-run.test.ts.

import { describe, it, expect } from 'vitest';
import { answerOfRun } from '../../job/final-answer.ts';

/** Un job qui répond par son résultat, sauf quand le test dit le contraire (#649). */
const answer = (messages: readonly unknown[], repliesGoBySend = false): string =>
  answerOfRun(messages, repliesGoBySend);
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
      answer([
        user('task'),
        step(NARRATION, write('doc.html')),
        tool(),
        step('', write('doc.html')),
        tool(),
        step('', write('doc.html')),
        tool(),
        step('', done(REASON)),
      ]),
    ).toBe(REASON);
  });

  it('forme B sans reason : aucune réponse, jamais la narration', () => {
    expect(
      answer([
        user('task'),
        step(NARRATION),
        step('', write('doc.html')),
        tool(),
        step('', done()),
      ]),
    ).toBe('');
  });

  it('les appels du MÊME pas ne périment pas le texte : seul un pas ultérieur qui agit le fait', () => {
    // La forme de 81 jobs relus : un rapport écrit avec l'appel qui enregistre
    // son verdict, puis `return_result` seul.
    const verdict = { name: 'record_review_verdict', input: { ok: true } };
    expect(answer([user('task'), step(REPORT, verdict), tool(), step('', done())])).toBe(REPORT);
    // Un pas ultérieur qui agit, lui, le périme.
    expect(
      answer([
        user('task'),
        step(REPORT, verdict),
        tool(),
        step('', write('a')),
        tool(),
        step('', done()),
      ]),
    ).toBe('');
  });

  it('un reason écrit APRÈS un texte qui partageait son pas avec des appels le SUIT', () => {
    expect(answer([user('task'), step(REPORT, write('a')), tool(), step('', done(REASON))])).toBe(
      [REPORT, REASON].join('\n\n'),
    );
    // Un texte seul dans son pas a tout vu : le reason qui suit n'ajoute rien.
    expect(answer([user('task'), step(REPORT, done()), tool(), step('', done(REASON))])).toBe(
      REPORT,
    );
  });

  it('inchangé : un rapport et return_result dans le même pas (même avec un reason)', () => {
    expect(answer([user('task'), step(REPORT, done('done'))])).toBe(REPORT);
    // Ses outils frères du pas qui finit ne périment pas le rapport.
    expect(answer([user('task'), step(REPORT, write('doc.html'), done())])).toBe(REPORT);
  });

  it('inchangé : un rapport, puis return_result seul au pas suivant, sans travail entre', () => {
    expect(answer([user('task'), step(REPORT), step('', done('Report above.'))])).toBe(REPORT);
  });

  it('inchangé : une réponse sans appel d’outil', () => {
    expect(answer([user('task'), step('', write('a')), tool(), step(REPORT)])).toBe(REPORT);
  });

  it('un reason de BLOCAGE n’est jamais une réponse de succès', () => {
    expect(
      answer([
        user('task'),
        step(NARRATION, write('a')),
        tool(),
        step('', write('a')),
        tool(),
        step('', { name: 'return_result', input: { status: 'blocked', reason: 'no key' } }),
      ]),
    ).toBe('');
  });

  it('dashboard_publish donne les mots de son pas', () => {
    expect(
      answer([
        user('task'),
        step(NARRATION, write('a')),
        tool(),
        step('', { name: 'dashboard_publish', input: { text: REPORT } }, done('published')),
      ]),
    ).toBe(REPORT);
  });

  it('quand un outil d’envoi porte les réponses (#649), le reason n’est pas la réponse', () => {
    const narrated = [
      user('task'),
      step('Let me check.', { name: 'web_search' }),
      tool(),
      step('', { name: 'web_search' }),
      tool(),
      step('', { name: 'telegram_send_message', input: { text: REPORT } }, done('Sent.')),
    ];
    expect(answer(narrated, true)).toBe('');
    // Le fait est la LIVRAISON du job, pas la présence d'un envoi : le même
    // run sur un job qui répond par son résultat rend son reason.
    expect(answer(narrated, false)).toBe('Sent.');
    // … et un texte écrit dans le pas qui finit reste lu comme avant.
    expect(
      answer(
        [
          user('task'),
          step('Voici.', { name: 'telegram_send_message', input: { text: REPORT } }, done('Sent.')),
        ],
        true,
      ),
    ).toBe('Voici.');
  });

  it('un envoi DIT, il ne travaille pas : il ne périme pas le texte d’avant', () => {
    const send = { name: 'telegram_send_message', input: { text: REPORT } };
    // Le chat : le texte seul, puis l'envoi et la fin au pas suivant.
    expect(answer([user('task'), step(REPORT), step('', send, done())], true)).toBe(REPORT);
    // Le job qui répond par son résultat et envoie une image en passant.
    expect(
      answer([
        user('task'),
        step(REPORT, write('a')),
        tool(),
        step('', { name: 'send_image', input: { path: 'a.png' } }),
        tool(),
        step('', done()),
      ]),
    ).toBe(REPORT);
    // Forme B avec un envoi au milieu du travail : toujours le reason.
    expect(
      answer([
        user('task'),
        step(NARRATION, write('doc.html')),
        tool(),
        step('', write('doc.html')),
        tool(),
        step('', { name: 'send_image', input: { path: 'preview.png' } }),
        tool(),
        step('', done(REASON)),
      ]),
    ).toBe(REASON);
  });

  it('forme A : la réponse d’avant la preuve, PUIS la note de réparation', () => {
    expect(
      answer([
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
      answer([
        user('task'),
        step(REPORT, done()),
        tool(),
        user(brief),
        step('Trying again.', write('doc.html')),
        tool(),
        step('', write('doc.html')),
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
      answer([
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
      answer([user('task'), step(REPORT, done()), tool(), user(brief), step(REPORT, done())]),
    ).toBe(REPORT);
  });

  it('le brief de réparation porte sa marque, et seul un message qui la porte sépare', () => {
    expect(brief.startsWith(REPAIR_BRIEF_MARK)).toBe(true);
    // Un message de la personne qui cite le brief sans la marque ne sépare rien.
    expect(
      answer([
        user('task'),
        step(REPORT, done()),
        user(brief.slice(REPAIR_BRIEF_MARK.length)),
        step(NOTE),
      ]),
    ).toBe(NOTE);
  });
});
