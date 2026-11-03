// sentence-chunker.test.ts — the cut a spoken reply goes to speech by (#943).
//
// Each case is fed TWICE: as one delta, and one character at a time — the
// worst split a model stream can produce. Both must give the same sentences:
// a boundary depends on the text, never on where the network cut it.
//
// Mutations verified (each turns at least one case red):
//   - the lower-case rule removed (`isLower` never true) → "decimals, ellipses",
//     "abbreviations" (e.g.);
//   - the abbreviation list emptied → "abbreviations";
//   - the "decide only once the next character is visible" guard removed
//     (`return -1` at the end of the buffer turned into a boundary) → "one
//     character at a time" variants of "abbreviations" and "decimals";
//   - the closing-quote loop removed → "quotes and brackets";
//   - `findCut` disabled → "a very long sentence";
//   - `flush` returning [] → "a final sentence with no full stop".

import { describe, it, expect } from 'vitest';
import { createSentenceChunker, splitSentences } from '../sentence-chunker.ts';

function charByChar(text: string): string[] {
  const chunker = createSentenceChunker();
  const out: string[] = [];
  for (const ch of text) out.push(...chunker.push(ch));
  return [...out, ...chunker.flush()];
}

function both(text: string): string[] {
  const whole = splitSentences(text);
  expect(charByChar(text)).toEqual(whole);
  return whole;
}

describe('the sentence chunker @cap:parler-a-un-agent/moteur', () => {
  it('cuts at full stops, question and exclamation marks, French spacing included', () => {
    expect(both('Bonjour Quentin. Il fait beau ! Tu sors ? Oui.')).toEqual([
      'Bonjour Quentin.',
      'Il fait beau !',
      'Tu sors ?',
      'Oui.',
    ]);
    expect(both('Hello there! How are you? Fine.')).toEqual([
      'Hello there!',
      'How are you?',
      'Fine.',
    ]);
  });

  it('abbreviations do not end a sentence', () => {
    expect(both('M. Dupont arrive. Dr. Smith aussi.')).toEqual([
      'M. Dupont arrive.',
      'Dr. Smith aussi.',
    ]);
    expect(both('Take a coat, e.g. the blue one. Then go.')).toEqual([
      'Take a coat, e.g. the blue one.',
      'Then go.',
    ]);
    expect(both('Written by J. K. Rowling. A classic.')).toEqual([
      'Written by J. K. Rowling.',
      'A classic.',
    ]);
    expect(both('Voir p. 12 du rapport. Merci.')).toEqual(['Voir p. 12 du rapport.', 'Merci.']);
  });

  it('decimals and times stay whole', () => {
    expect(both('Il fait 3.5 degrés. Rendez-vous à 19 h 30. Ou à 19.30 ?')).toEqual([
      'Il fait 3.5 degrés.',
      'Rendez-vous à 19 h 30.',
      'Ou à 19.30 ?',
    ]);
    expect(both('Le total est de 3,5 € pour 2 personnes. 4 restent.')).toEqual([
      'Le total est de 3,5 € pour 2 personnes.',
      '4 restent.',
    ]);
  });

  it('ellipses: a pause before a lower-case word, an end before a capital', () => {
    expect(both('Well... maybe. Attends… Voilà, c’est fait.')).toEqual([
      'Well... maybe.',
      'Attends…',
      'Voilà, c’est fait.',
    ]);
  });

  it('quotes and closing brackets after the full stop stay with their sentence', () => {
    expect(both('Il a dit « oui. » Puis il est parti.')).toEqual([
      'Il a dit « oui. »',
      'Puis il est parti.',
    ]);
    expect(both('He said "yes." Then he left. (See above.) Next.')).toEqual([
      'He said "yes."',
      'Then he left.',
      '(See above.)',
      'Next.',
    ]);
    // An opening quote after a stop belongs to the NEXT sentence.
    expect(both('Done. "Hello," she said.')).toEqual(['Done.', '"Hello," she said.']);
  });

  it('a final sentence with no full stop is given by flush, and only then', () => {
    const chunker = createSentenceChunker();
    expect(chunker.push('First one. And the second')).toEqual(['First one.']);
    expect(chunker.push(' goes on')).toEqual([]);
    expect(chunker.flush()).toEqual(['And the second goes on']);
    // A last full stop waits for what follows, which flush settles.
    const ends = createSentenceChunker();
    expect(ends.push('Only this.')).toEqual([]);
    expect(ends.flush()).toEqual(['Only this.']);
  });

  it('a line break ends a sentence; nothing without a letter or digit is spoken', () => {
    expect(both('Deux choses :\n- le pain\n- le lait\n\n...')).toEqual([
      'Deux choses :',
      '- le pain',
      '- le lait',
    ]);
  });

  it('a very long sentence is cut at a clause boundary, so the first sound never waits for it', () => {
    const long =
      'Pour préparer ce voyage il faut réserver le train assez tôt dans la semaine, ' +
      'vérifier que les billets sont bien arrivés dans la boîte de réception, ' +
      'prévenir la famille qui attend à la gare et prendre un parapluie au cas où';
    const chunker = createSentenceChunker();
    const firstPieces: string[] = [];
    for (const ch of long) {
      firstPieces.push(...chunker.push(ch));
      if (firstPieces.length > 0) break;
    }
    // The first piece comes out BEFORE the sentence is finished, at a comma.
    expect(firstPieces).toEqual([
      'Pour préparer ce voyage il faut réserver le train assez tôt dans la semaine,',
    ]);
    const pieces = both(long);
    expect(pieces[0]).toBe(firstPieces[0]);
    expect(pieces.join(' ')).toBe(long);
    for (const p of pieces) expect(p.length).toBeLessThanOrEqual(260);
    // No clause boundary at all: cut at a space past the hard bound.
    const words = Array.from({ length: 80 }, (_, i) => `mot${String(i)}`).join(' ');
    const cut = splitSentences(words);
    expect(cut.length).toBeGreaterThan(1);
    expect(cut.join(' ')).toBe(words);
    for (const p of cut) expect(p.length).toBeLessThanOrEqual(260);
  });
});
