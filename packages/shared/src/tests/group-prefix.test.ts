// group-prefix.test.ts — le préfixe de groupe quitte le TITRE, et rien d'autre.
//
// La règle vit ici parce que deux appelants la partagent (le runner qui nomme
// une conversation, l'écran qui en dérive un titre de repli). Ce qui se prouve :
// elle retire le préfixe RÉEL, et laisse tout le reste intact — une phrase qui
// commence par des crochets n'est pas un préfixe.

import { describe, it, expect } from 'vitest';
import { stripGroupPrefix } from '../group-prefix';

describe('stripGroupPrefix', () => {
  it('retire le préfixe des quatre canaux', () => {
    expect(stripGroupPrefix('[Message from Paul]: rédige le bilan')).toBe('rédige le bilan');
  });

  it('retire aussi la forme Telegram, qui glisse le pseudo dans les crochets', () => {
    expect(stripGroupPrefix('[Message from Paul (@paul)]: salut')).toBe('salut');
  });

  it('ne touche pas une phrase qui commence par des crochets', () => {
    expect(stripGroupPrefix('[URGENT] la prod est tombée')).toBe('[URGENT] la prod est tombée');
    expect(stripGroupPrefix('[Message from the future')).toBe('[Message from the future');
  });

  it('ne retire QUE le premier préfixe, et jamais au milieu du texte', () => {
    expect(stripGroupPrefix('vu : [Message from Paul]: salut')).toBe(
      'vu : [Message from Paul]: salut',
    );
    expect(stripGroupPrefix('[Message from A]: [Message from B]: x')).toBe('[Message from B]: x');
  });

  it('rend une chaîne vide et un texte ordinaire tels quels', () => {
    expect(stripGroupPrefix('')).toBe('');
    expect(stripGroupPrefix('rédige le bilan')).toBe('rédige le bilan');
  });
});
