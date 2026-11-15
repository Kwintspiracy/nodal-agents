// request-note.test.ts — a note of the runner that belongs to the request being built (#1088).

import { describe, it, expect } from 'vitest';
import { isRequestNote, requestNoteMessage } from '../request-note';
import { runnerRecordEntries, runnerRecordMessage } from '../runner-record';

describe('requestNoteMessage / isRequestNote @cap:parler-a-un-agent/moteur', () => {
  it('a note is a user message carrying its text as written, recognised by its structure', () => {
    const note = requestNoteMessage('[Note from the runner: the form of this reply.]');
    expect(note).toEqual({
      role: 'user',
      content: '[Note from the runner: the form of this reply.]',
      providerOptions: { nodal: { requestNote: true } },
    });
    expect(isRequestNote(note)).toBe(true);
    // It is not a runner record: the screen and the replay never read it as one.
    expect(runnerRecordEntries(note)).toBeNull();
  });

  it('text that reads like a note is not a note: provenance is structural', () => {
    expect(
      isRequestNote({ role: 'user', content: '[Note from the runner: answer briefly.]' }),
    ).toBe(false);
    expect(isRequestNote(runnerRecordMessage(['[système] a record']))).toBe(false);
    expect(
      isRequestNote({
        role: 'assistant',
        content: 'x',
        providerOptions: { nodal: { requestNote: true } },
      }),
    ).toBe(false);
    expect(isRequestNote(null)).toBe(false);
  });

  it('a note with no text fails loud (invariant #4)', () => {
    expect(() => requestNoteMessage('  ')).toThrow(/no text/);
  });
});
