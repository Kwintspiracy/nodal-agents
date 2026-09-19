// welcome-line.test.ts — la ligne d'accueil de l'écran de conversation neuve
// (#248).
//
// Ce qui se prouve ici tient en une phrase : elle ne fabrique JAMAIS de nom.
// Le compte du mode local porte l'adresse `local@nodalai.local` ; une ligne
// qui aurait salué « Hey local » aurait nommé quelqu'un qui n'existe pas
// (invariant #4).

import { describe, it, expect } from 'vitest';
import { firstName, welcomeLine } from '../welcome-line.ts';

describe('welcomeLine', () => {
  it('nomme la personne quand le compte porte un nom', () => {
    expect(welcomeLine('Quentin')).toBe('Hey Quentin, what are we building today?');
  });

  it('dit le PRÉNOM, pas le nom entier', () => {
    expect(welcomeLine('Quentin Beau de Loménie')).toBe('Hey Quentin, what are we building today?');
  });

  it('sans nom connu, la phrase se passe du nom — elle n’en invente pas', () => {
    for (const rien of [null, '', '   ', '\n\t']) {
      expect(welcomeLine(rien)).toBe('Hey, what are we building today?');
    }
  });

  it('pas de virgule orpheline quand il n’y a personne à nommer', () => {
    // La faute qu'un `Hey ${name},` naïf produit : « Hey , what are we… ».
    expect(welcomeLine(null)).not.toContain('Hey ,');
    expect(welcomeLine(null)).not.toContain('  ');
  });

  it('firstName rend null plutôt qu’une chaîne vide', () => {
    expect(firstName('  ')).toBeNull();
    expect(firstName(null)).toBeNull();
    expect(firstName('  Ada  Lovelace ')).toBe('Ada');
  });
});
