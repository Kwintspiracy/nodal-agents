import { describe, it, expect } from 'vitest';
import { splitForSpeech } from '../src/lib/speak-reply.ts';

/**
 * Chunking decides when the FIRST sound arrives, which is the whole complaint
 * about the voice mode: the reply text appeared, and only then a voice started
 * reading it back. Synthesising sentence by sentence turns one 3.5–4.4 s wait
 * into a much shorter one, so these tests pin the shape of the cut rather than
 * the fact that a function exists.
 */
describe('splitForSpeech', () => {
  it('cuts on sentence ends so the first chunk is short', () => {
    const out = splitForSpeech(
      'Il est vingt heures à Tokyo. Le décalage est de huit heures avec Paris. ' +
        'Veux-tu que je note un rappel pour demain matin ?',
      20,
    );
    expect(out.length).toBeGreaterThan(1);
    expect(out[0]).toBe('Il est vingt heures à Tokyo.');
  });

  it('merges fragments up to the floor — stutter costs a round trip each', () => {
    // "Oui. Bien sûr. Voilà." as three requests is three synthesis calls and
    // three gaps, for one short answer.
    const out = splitForSpeech('Oui. Bien sûr. Voilà.', 90);
    expect(out).toEqual(['Oui. Bien sûr. Voilà.']);
  });

  it('keeps every word — nothing is dropped between chunks', () => {
    const text = 'Un. Deux ! Trois ? Quatre… Cinq.';
    expect(splitForSpeech(text, 1).join(' ')).toBe(text);
  });

  it('handles a reply with no sentence end at all', () => {
    expect(splitForSpeech('juste une phrase sans ponctuation finale')).toEqual([
      'juste une phrase sans ponctuation finale',
    ]);
  });

  it('collapses newlines rather than speaking them as pauses', () => {
    const out = splitForSpeech('Première ligne.\n\nDeuxième ligne.', 1);
    expect(out).toEqual(['Première ligne.', 'Deuxième ligne.']);
  });

  it('returns nothing for an empty reply instead of one empty chunk', () => {
    // An empty chunk would be a synthesis request for silence — billed, and
    // rejected by the adapter as `text is empty`.
    expect(splitForSpeech('   ')).toEqual([]);
  });
});
