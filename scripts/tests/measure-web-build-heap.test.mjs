// measure-web-build-heap.test.mjs — les deux lectures du script de mesure.
//
// Le reste du script (échantillonnage, pics, verdict) vit dans
// `scripts/lib/build-heap-sampler.mjs` et se vérifie dans
// `scripts/tests/build-heap-sampler.test.mjs`. Ne restent ici que les deux
// endroits où le script LIT quelque chose — et où il pourrait mesurer autre
// chose que ce qu'on croit.
//
// Lancer depuis la racine : npx vitest run scripts/tests/measure-web-build-heap.test.mjs

import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { lirePlancher, capDemande, referenceDepuis } from '../measure-web-build-heap.mjs';

describe('lirePlancher', () => {
  it('lit le plancher dans la source de build-pack', () => {
    expect(lirePlancher('const HEAP_FLOOR_MB = 16384;\n')).toBe(16384);
  });

  it('refuse plutôt que de rendre un plancher par défaut', () => {
    // Un défaut silencieux ferait mesurer sous un cap qui n'est celui de
    // personne, et le chiffre rendu ne dirait plus rien du build de release
    // (invariant #4 : pas de repli malin).
    expect(() => lirePlancher('rien ici')).toThrow(/HEAP_FLOOR_MB/);
  });

  it('lit le plancher réellement en vigueur dans le dépôt', () => {
    // Le test qui compte : le motif doit suivre la vraie ligne, pas une ligne
    // d'exemple. Le jour où quelqu'un renomme la constante, ceci rougit.
    const src = readFileSync(resolve(import.meta.dirname, '../build-pack.mjs'), 'utf8');
    expect(lirePlancher(src)).toBeGreaterThan(0);
  });
});

describe('capDemande', () => {
  it('prend le cap donné', () => {
    expect(capDemande(['--cap', '16384'], 24576)).toBe(16384);
  });

  it('retombe sur le plancher quand on ne demande rien', () => {
    expect(capDemande(['--json', 'x.json'], 24576)).toBe(24576);
  });

  it("refuse un cap illisible au lieu d'en inventer un", () => {
    expect(() => capDemande(['--cap', 'beaucoup'], 24576)).toThrow(/--cap/);
    expect(() => capDemande(['--cap'], 24576)).toThrow(/--cap/);
    expect(() => capDemande(['--cap', '-1'], 24576)).toThrow(/--cap/);
  });
});

describe('referenceDepuis', () => {
  const mesure = { picProcessusMo: 13069, picArbreMo: 13603, secondes: 1193 };
  const os = { platform: 'win32', cores: 24, node: '26.4.0' };
  const maintenant = new Date('2026-09-20T02:11:00Z');

  it('porte la machine avec le chiffre', () => {
    // Un pic nu ne se compare à rien : `next build` ouvre un worker par cœur,
    // donc le même dépôt rend un autre chiffre sur une autre machine. Sans la
    // machine, l'alerte du prochain build ne peut pas être tranchée.
    const ref = referenceDepuis(mesure, { commit: 'dee372ea', cap: 12288, maintenant, os });

    expect(ref.machine).toBe('win32 24 cœurs, node 26.4.0');
    expect(ref.picProcessusMo).toBe(13069);
    expect(ref.picArbreMo).toBe(13603);
    expect(ref.capMo).toBe(12288);
    expect(ref.commit).toBe('dee372ea');
    expect(ref.date).toBe('2026-09-20');
  });

  it('dit dans le fichier à quoi il sert', () => {
    // Le fichier est relu par build-pack.mjs et par personne d'autre. Sans
    // cette phrase, le premier lecteur le prend pour un cache et le supprime.
    const ref = referenceDepuis(mesure, { commit: 'abc1234', cap: 16384, maintenant, os });
    expect(ref._pourquoi).toContain('build-pack');
  });
});
