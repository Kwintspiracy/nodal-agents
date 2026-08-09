// contrast.test.ts — UX-001.
//
// L'audit D6 a mesuré 118 combinaisons couleur/fond dans le DOM réel : 6
// échouaient à WCAG 2.1 AA, toutes issues de DEUX tokens. Corriger la définition
// du token corrige les six.
//
// Aucun test n'assertait le contraste, ce qui est la raison pour laquelle
// l'écart a vécu : rien ne le disait. Celui-ci lit les VRAIES valeurs de
// globals.css — pas une copie — pour qu'un futur ajustement de palette ne puisse
// pas repasser sous le seuil en silence.

import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const CSS = readFileSync(
  join(dirname(fileURLToPath(import.meta.url)), '..', '..', 'app', 'globals.css'),
  'utf-8',
);

/** Luminance relative WCAG. */
function luminance(hex: string): number {
  const ch = [1, 3, 5]
    .map((i) => parseInt(hex.substr(i, 2), 16) / 255)
    .map((v) => (v <= 0.03928 ? v / 12.92 : Math.pow((v + 0.055) / 1.055, 2.4)));
  return 0.2126 * ch[0]! + 0.7152 * ch[1]! + 0.0722 * ch[2]!;
}

export function contrastRatio(fg: string, bg: string): number {
  const a = luminance(fg);
  const b = luminance(bg);
  return (Math.max(a, b) + 0.05) / (Math.min(a, b) + 0.05);
}

/**
 * Lit un token dans le bloc clair (première occurrence) ou sombre (seconde).
 * Volontairement naïf et positionnel : si la structure du fichier change, le
 * test casse plutôt que de lire silencieusement la mauvaise valeur.
 */
function token(name: string, theme: 'light' | 'dark'): string {
  const all = [...CSS.matchAll(new RegExp(`--${name}:\\s*(#[0-9a-f]{6})`, 'gi'))].map((m) => m[1]!);
  const value = theme === 'light' ? all[0] : all[1];
  if (!value) throw new Error(`Token --${name} introuvable pour le thème ${theme}`);
  return value;
}

// Les fonds sur lesquels ces textes apparaissent réellement, relevés dans le DOM
// pendant l'audit — pas des fonds supposés.
const COMBINATIONS: Array<[string, string, 'light' | 'dark', string]> = [
  ['ink-4 sur la barre latérale', 'c-ink-4', 'light', '#f2f2f2'],
  ['ink-4 sur papier', 'c-ink-4', 'light', '#ffffff'],
  ['ink-3 sur canvas', 'c-ink-3', 'light', '#eaeaea'],
  ['ink-3 sur papier', 'c-ink-3', 'light', '#ffffff'],
  ['ink-4 sur papier sombre', 'c-ink-4', 'dark', '#1c1c20'],
  ['ink-3 sur papier sombre', 'c-ink-3', 'dark', '#1c1c20'],
];

describe('UX-001 — contraste WCAG 2.1 AA des tokens de texte secondaire', () => {
  for (const [label, name, theme, bg] of COMBINATIONS) {
    it(`${label} atteint 4.5:1`, () => {
      const ratio = contrastRatio(token(name, theme), bg);
      expect(
        ratio,
        `${label}: ${ratio.toFixed(2)}:1 — le seuil AA est 4.5:1`,
      ).toBeGreaterThanOrEqual(4.5);
    });
  }

  it('CONTRE-ÉPREUVE : le calcul détecte bien un échec', () => {
    // Sans ceci, une fonction cassée qui renverrait toujours 21 rendrait tout
    // ce qui précède vert pour toujours.
    expect(contrastRatio('#9a9a9a', '#f2f2f2')).toBeLessThan(4.5);
    expect(contrastRatio('#000000', '#ffffff')).toBeCloseTo(21, 0);
  });
});
