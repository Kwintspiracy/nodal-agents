// handoff.test.ts — la forme d'une remise : les mots de qui a demandé, seuls
// dans leur message, puis la note du modèle qui l'a remise, sous son cadre.
// Les chemins réels (chat, tour de réponse, relance, CLI) sont prouvés dans le
// runner : apps/runner/src/tests/chat/handoff-verbatim.test.ts,
// tests/job/inbox-drain.test.ts, tests/cli-runtime/inbox-after-cli-turn.test.ts.

import { describe, it, expect } from 'vitest';
import {
  HANDOFF_NOTE_FRAME,
  handoffNote,
  isHandoffNoteMessage,
  openingMessages,
  openingText,
} from '../handoff';
import { inboxMessages, isInboxMessage } from '../conversation-inbox';

describe('a hand-off keeps the person’s words and the relaying model’s note apart @cap:parler-a-un-agent/moteur', () => {
  it('a note that adds nothing is no note: empty, blank, or the very words', () => {
    expect(handoffNote(undefined, 'Imprime-le.')).toBeNull();
    expect(handoffNote('   ', 'Imprime-le.')).toBeNull();
    expect(handoffNote(' Imprime-le. ', 'Imprime-le.')).toBeNull();
    expect(handoffNote('Le fichier est celui d’hier.', 'Imprime-le.')).toBe(
      'Le fichier est celui d’hier.',
    );
  });

  it('the opening: the words alone in their message, then the note under its frame, marked', () => {
    expect(openingMessages('Imprime-le.', null)).toEqual([
      { role: 'user', content: 'Imprime-le.' },
    ]);
    const [words, note] = openingMessages('印刷して', 'The file from yesterday.');
    expect(words).toEqual({ role: 'user', content: '印刷して' });
    expect(note?.content).toBe(`${HANDOFF_NOTE_FRAME}\nThe file from yesterday.`);
    expect([isHandoffNoteMessage(words), isHandoffNoteMessage(note)]).toEqual([false, true]);
  });

  it('the same opening as one text, for a runtime that takes a single message', () => {
    expect(openingText('Imprime-le.', null)).toBe('Imprime-le.');
    expect(openingText('Imprime-le.', 'Imprime-le.')).toBe('Imprime-le.');
    expect(openingText('Imprime-le.', 'Le fichier d’hier.')).toBe(
      `Imprime-le.\n\n${HANDOFF_NOTE_FRAME}\nLe fichier d’hier.`,
    );
  });

  it('a drained entry: the words marked as passed on, the note marked as a note, never the reverse', () => {
    const entry = {
      id: 'e1',
      task: 'Un seul trait.',
      content: 'Un seul trait.',
      receivedAt: '2026-10-18T03:23:32.000Z',
    };
    expect(inboxMessages(entry).map((m) => [m.content, isInboxMessage(m)])).toEqual([
      ['Un seul trait.', true],
    ]);
    const withNote = inboxMessages({ ...entry, note: 'Elle corrige le 7.' });
    expect(withNote.map((m) => [m.content, isInboxMessage(m), isHandoffNoteMessage(m)])).toEqual([
      ['Un seul trait.', true, false],
      [`${HANDOFF_NOTE_FRAME}\nElle corrige le 7.`, false, true],
    ]);
  });
});
