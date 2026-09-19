// redact-stream.test.ts — un secret coupé en deux par le réseau reste masqué.
//
// Ce qui se prouve : le texte qui SORT du masqueur, morceau par morceau, ne
// contient jamais le jeton, même quand aucun fragment ne le contient en entier.
// L'assertion porte sur le texte émis (invariant #5), pas sur un nombre
// d'appels.

import { describe, it, expect } from 'vitest';
import { createStreamRedactor } from '../redact-stream.ts';
import { REDACTED_TEXT } from '@nodal-agents/shared';

/** Tout ce que le masqueur a laissé sortir pour ces fragments. */
function emitted(chunks: readonly string[]): string {
  const r = createStreamRedactor();
  return chunks.map((c) => r.push(c)).join('') + r.flush();
}

describe('createStreamRedactor', () => {
  it('rend le texte ordinaire intact, fragment par fragment', () => {
    expect(emitted(['Bonjour ', 'tout ', 'le monde.'])).toBe('Bonjour tout le monde.');
  });

  it('masque un jeton qu’aucun fragment ne porte en entier', () => {
    // Une FORME de jeton, pas un jeton : l'alphabet écrit en clair.
    const token = 'sk-ant-abcdefghijklmnopqrstuvwxyz0123'; // secrets:allow
    const out = emitted(['here is the key ', token.slice(0, 9), token.slice(9), ' keep it safe']);
    expect(out).not.toContain(token);
    expect(out).not.toContain('sk-ant-abcdefg');
    expect(out).toContain(REDACTED_TEXT);
    expect(out).toContain('here is the key ');
    expect(out).toContain(' keep it safe');
  });

  it('masque un `Bearer <jeton>` coupé sur son espace', () => {
    const out = emitted(['Authorization: Bearer ', 'abcdefghijklmnopqrstuvwxyz012345', '\ndone']);
    expect(out).not.toContain('abcdefghijklmnopqrstuvwxyz012345');
    expect(out).toContain(REDACTED_TEXT);
  });

  it('masque un bloc de clé privée arrivé ligne par ligne', () => {
    const out = emitted([
      'key follows\n-----BEGIN ',
      'RSA PRIVATE KEY-----\nAAAA',
      'BBBB\n-----END RSA PRIVATE KEY-----\n',
      'that is all',
    ]);
    expect(out).not.toContain('AAAABBBB');
    expect(out).toContain(REDACTED_TEXT);
    expect(out).toContain('that is all');
  });

  it('ne retient rien à la fin : ce qui reste sort au `flush`', () => {
    const r = createStreamRedactor();
    const streamed = r.push('un mot sans espace final');
    expect(streamed + r.flush()).toBe('un mot sans espace final');
    expect(r.flush()).toBe('');
  });
});
