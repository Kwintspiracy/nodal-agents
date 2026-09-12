// explications.test.mjs — chaque page du portail est expliquée, et chaque
// explication est complète. Un portail qu'on ne sait pas lire ne vaut rien.

import { readFileSync } from 'node:fs';
import { describe, it, expect } from 'vitest';
import { EXPLICATIONS, PAGES_EXPLIQUEES } from './explications.mjs';

const build = readFileSync(new URL('./build.mjs', import.meta.url), 'utf8');

/** Les pages que le rendu déclare : `<section id="…" class="vue…">`. */
const pagesRendues = [
  ...new Set([...build.matchAll(/<section id="([a-z]+)" class="vue/g)].map((m) => m[1])),
];

const PARTIES = [
  'À quoi ça sert',
  'Comment le lire',
  "D'où ça vient",
  'Quand agir',
  'Ce que ça ne dit pas',
];

describe('chaque page du portail a son explication', () => {
  it('les pages rendues et les pages expliquées sont les mêmes — ni orpheline, ni fantôme', () => {
    expect([...pagesRendues].sort()).toEqual([...PAGES_EXPLIQUEES].sort());
  });

  it('chaque page appelle son en-tête, qui porte le bouton « Comprendre cette page »', () => {
    for (const id of pagesRendues) {
      expect(build, `entete('${id}') manque dans build.mjs`).toContain(`entete('${id}'`);
    }
    expect(build).toContain('data-explique="${id}"');
    expect(build).toContain('Comprendre cette page');
  });

  it('chaque explication dit pourquoi, comment lire, d’où ça vient, quand agir, et ce que ça ne dit pas', () => {
    for (const id of PAGES_EXPLIQUEES) {
      const x = EXPLICATIONS[id];
      expect(x.enBref.length, `${id}.enBref`).toBeGreaterThan(80);
      expect(
        x.parties.map((p) => p.titre),
        `${id} : les cinq parties, dans cet ordre`,
      ).toEqual(PARTIES);
      for (const p of x.parties) expect(p.texte.length, `${id} › ${p.titre}`).toBeGreaterThan(60);
    }
  });

  it('chaque repère posé dans le rendu existe dans les explications', () => {
    const appels = [...build.matchAll(/repere\('([a-z]+)', '([a-z]+)'\)/g)];
    expect(appels.length).toBeGreaterThan(0);
    for (const [, page, bloc] of appels) {
      expect(EXPLICATIONS[page]?.blocs?.[bloc], `repère ${page}.${bloc} sans texte`).toBeTruthy();
    }
  });

  it('aucun bloc expliqué n’est orphelin — un texte que personne n’affiche est un texte qui pourrit', () => {
    for (const id of PAGES_EXPLIQUEES) {
      for (const bloc of Object.keys(EXPLICATIONS[id].blocs ?? {})) {
        expect(build, `repere('${id}', '${bloc}') jamais appelé`).toContain(
          `repere('${id}', '${bloc}')`,
        );
      }
    }
  });
});
