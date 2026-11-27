// final-answer.test.ts — la réponse d'un job est celle qu'il donne quand il
// FINIT (#1083), lue dans la transcription par `answerOfRun`.
//
// La lecture pure, sur toutes les formes de fin. Les mêmes formes passent par
// le vrai `executeJob` dans final-answer-run.test.ts.

import { describe, it, expect } from 'vitest';
import { NO_CHAT_SENDS, answerOfRun, readRunAnswer } from '../../job/final-answer.ts';
import type { ChatSends } from '../../job/final-answer.ts';

/**
 * Un job dont aucun envoi n'a atteint le chat qui a demandé, sauf quand le test
 * dit le contraire : `true`, chaque envoi de texte de la transcription l'a
 * atteint, confirmé (#1215, les faits que `sendsToChat` lit sur les lignes).
 */
const answer = (messages: readonly unknown[], sentToTheChat = false): string =>
  answerOfRun(messages, sentToTheChat ? sendsOf(messages, 'confirmed') : NO_CHAT_SENDS);

/** Chaque appel d'envoi de texte de `messages`, avec l'issue donnée. */
function sendsOf(messages: readonly unknown[], outcome: 'confirmed' | 'unknown'): ChatSends {
  const out = new Map<string, 'confirmed' | 'unknown'>();
  for (const m of messages as Array<{ role?: string; content?: unknown }>) {
    if (m.role !== 'assistant' || !Array.isArray(m.content)) continue;
    for (const p of m.content as Array<{ type?: string; toolName?: string; toolCallId?: string }>) {
      if (p.type === 'tool-call' && p.toolName === 'telegram_send_message' && p.toolCallId) {
        out.set(p.toolCallId, outcome);
      }
    }
  }
  return out;
}
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

  it('quand un envoi au chat qui a demandé porte la réponse (#1215), le reason n’est pas la réponse', () => {
    const narrated = [
      user('task'),
      step('Let me check.', { name: 'web_search' }),
      tool(),
      step('', { name: 'web_search' }),
      tool(),
      step('', { name: 'telegram_send_message', input: { text: REPORT } }, done('Sent.')),
    ];
    expect(answer(narrated, true)).toBe('');
    // Le fait est l'ENVOI au chat, lu sur les lignes (`sendsToChat`), pas la
    // présence d'un appel : le même run dont l'envoi n'a atteint aucun chat de
    // la demande (un autre chat, un job sans chat) rend son reason.
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

// ─── Ce qui reste à livrer au chat qui a demandé (#1215) ──────────────────────

describe('readRunAnswer — ce qu’un envoi a porté n’est pas livré deux fois @cap:parler-par-canal-externe/moteur', () => {
  const send = (text: string): Call => ({ name: 'telegram_send_message', input: { text } });
  const read = (messages: readonly unknown[], outcome?: 'confirmed' | 'unknown') =>
    readRunAnswer(messages, outcome ? sendsOf(messages, outcome) : NO_CHAT_SENDS);

  it('aucun envoi au chat : la réponse à livrer est le résultat (null), pas de renvoi', () => {
    expect(read([user('task'), step('', write('a')), tool(), step(REPORT)])).toEqual({
      text: REPORT,
      unsent: null,
      resendsUnconfirmed: false,
    });
  });

  it('le pas de réponse envoie au chat, confirmé : rien ne reste à livrer', () => {
    const messages = [user('task'), step('', write('a')), tool(), step('', send(REPORT), done())];
    expect(read(messages, 'confirmed')).toEqual({
      text: '',
      unsent: '',
      resendsUnconfirmed: false,
    });
  });

  it('un accusé envoyé, puis du travail, puis la réponse en texte : l’accusé n’est pas la réponse', () => {
    const messages = [user('task'), step('', send('On it.'), write('a')), tool(), step(REPORT)];
    expect(read(messages, 'confirmed')).toEqual({
      text: REPORT,
      unsent: null,
      resendsUnconfirmed: false,
    });
  });

  it('un accusé envoyé seul, puis la réponse en texte : la réponse est plus récente, elle est livrée', () => {
    const messages = [user('task'), step('', send('On it.')), tool(), step(REPORT)];
    expect(read(messages, 'confirmed').unsent).toBeNull();
  });

  it('un envoi dont l’issue est inconnue : son texte est à renvoyer, et c’est dit', () => {
    const messages = [user('task'), step('', send(REPORT), done('Sent, maybe.'))];
    expect(read(messages, 'unknown')).toEqual({
      text: '',
      unsent: REPORT,
      resendsUnconfirmed: true,
    });
  });

  it('une réparation après une réponse envoyée : seul ce que la réparation a dit reste à livrer', () => {
    const messages = [
      user('task'),
      step('', write('doc.html')),
      tool(),
      step('', send(REPORT), done()),
      tool(),
      user(brief),
      step('', write('doc.html')),
      tool(),
      step(NOTE),
    ];
    expect(read(messages, 'confirmed')).toEqual({
      text: NOTE,
      unsent: NOTE,
      resendsUnconfirmed: false,
    });
  });
});
