// build-heap-sampler.test.mjs — les parties du mesureur qui peuvent mentir.
//
// Le module rend un chiffre qui règle le plancher de tas du build de release
// (#219) et qui fait parler le build de pack quand la marge s'épuise. Un
// mesureur faux est pire qu'absent : il fait baisser un plancher sur la foi
// d'un nombre que personne ne recalcule. Les parties pures sont donc vérifiées
// ici, sur des relevés qu'on écrit à la main.
//
// Lancer depuis la racine : npx vitest run scripts/tests/build-heap-sampler.test.mjs

import { describe, it, expect } from 'vitest';
import {
  arbreDe,
  picsDe,
  plancherPour,
  verdictPic,
  nodeOptionsAvecCap,
  parserPsPosix,
  parserCimWindows,
} from '../lib/build-heap-sampler.mjs';

describe('arbreDe', () => {
  it('descend les petits-enfants — le build se déporte sur deux niveaux', () => {
    const processus = [
      { pid: 100, ppid: 1 },
      { pid: 200, ppid: 100 },
      { pid: 300, ppid: 200 },
      { pid: 400, ppid: 1 },
    ];

    expect([...arbreDe(processus, 100)].sort((a, b) => a - b)).toEqual([100, 200, 300]);
  });

  it("laisse dehors les processus d'une autre session", () => {
    // C'est le point : sur cette machine une dizaine de node.exe tournent en
    // permanence. Compter tous les node.exe mesurerait le pic des autres.
    const processus = [
      { pid: 100, ppid: 1 },
      { pid: 200, ppid: 100 },
      { pid: 900, ppid: 1 },
      { pid: 901, ppid: 900 },
    ];

    const arbre = arbreDe(processus, 100);
    expect(arbre.has(900)).toBe(false);
    expect(arbre.has(901)).toBe(false);
  });

  it('ne boucle pas sur un relevé où un pid est son propre parent', () => {
    // Le relevé est une photo prise pendant que des processus naissent et
    // meurent : un pid réattribué peut donner un cycle apparent.
    const processus = [
      { pid: 100, ppid: 200 },
      { pid: 200, ppid: 100 },
    ];

    expect([...arbreDe(processus, 100)].sort((a, b) => a - b)).toEqual([100, 200]);
  });
});

describe('picsDe', () => {
  it('rend le plus gros processus, celui que --max-old-space-size borne', () => {
    const echantillons = [
      { t: 0, processus: [{ pid: 1, rssMo: 1000 }] },
      {
        t: 2,
        processus: [
          { pid: 1, rssMo: 4000 },
          { pid: 2, rssMo: 9000 },
        ],
      },
      { t: 4, processus: [{ pid: 1, rssMo: 2000 }] },
    ];

    const pics = picsDe(echantillons);
    expect(pics.picProcessusMo).toBe(9000);
    expect(pics.pidPic).toBe(2);
  });

  it("ne somme jamais deux pics que la machine n'a pas portés ensemble", () => {
    // 9000 puis 8000, mais jamais au même instant : le pic de l'arbre est
    // 9000 + 1000, pas 17 000. Sommer les pics individuels donnerait un besoin
    // machine inventé — et ferait remonter un plancher sans raison.
    const echantillons = [
      {
        t: 0,
        processus: [
          { pid: 1, rssMo: 9000 },
          { pid: 2, rssMo: 1000 },
        ],
      },
      { t: 2, processus: [{ pid: 2, rssMo: 8000 }] },
    ];

    const pics = picsDe(echantillons);
    expect(pics.picArbreMo).toBe(10000);
    expect(pics.tPicArbre).toBe(0);
  });

  it('rend zéro sans échantillon plutôt que NaN', () => {
    expect(picsDe([])).toEqual({
      picProcessusMo: 0,
      pidPic: null,
      picArbreMo: 0,
      tPicArbre: null,
    });
  });
});

describe('plancherPour', () => {
  it('arrondit au multiple de 1024 au-dessus du pic majoré de la marge', () => {
    // 12 000 + 25 % = 15 000 → 15 360 (15 × 1024).
    expect(plancherPour(12000)).toBe(15360);
  });

  it('ne rend jamais un plancher sous le pic mesuré', () => {
    for (const pic of [1, 1023, 4096, 9001, 20000]) {
      expect(plancherPour(pic)).toBeGreaterThan(pic);
    }
  });
});

describe('parserPsPosix', () => {
  it('lit les Ko de ps et les rend en Mo', () => {
    const sortie = ['  PID  PPID   RSS', ' 100     1 2097152', ' 200   100  524288', ''].join('\n');

    expect(parserPsPosix(sortie)).toEqual([
      { pid: 100, ppid: 1, rssMo: 2048 },
      { pid: 200, ppid: 100, rssMo: 512 },
    ]);
  });

  it('ignore une ligne que le format ne décrit pas', () => {
    const sortie = ['  PID  PPID   RSS', 'ps: something broke', ' 100     1 1024'].join('\n');

    expect(parserPsPosix(sortie)).toEqual([{ pid: 100, ppid: 1, rssMo: 1 }]);
  });
});

describe('parserCimWindows', () => {
  it('lit les octets de Win32_Process et les rend en Mo', () => {
    const json = JSON.stringify([
      { ProcessId: 100, ParentProcessId: 1, WorkingSetSize: 2147483648 },
      { ProcessId: 200, ParentProcessId: 100, WorkingSetSize: 536870912 },
    ]);

    expect(parserCimWindows(json)).toEqual([
      { pid: 100, ppid: 1, rssMo: 2048 },
      { pid: 200, ppid: 100, rssMo: 512 },
    ]);
  });

  it('accepte le processus seul, que ConvertTo-Json ne met pas dans un tableau', () => {
    const json = JSON.stringify({ ProcessId: 7, ParentProcessId: 1, WorkingSetSize: 1048576 });

    expect(parserCimWindows(json)).toEqual([{ pid: 7, ppid: 1, rssMo: 1 }]);
  });

  it('lit une taille remontée en chaîne au-delà de 2 Go', () => {
    // PowerShell sérialise les grands entiers en chaîne. Number() les relit ;
    // un parseInt naïf sur l'objet brut rendrait NaN, et le pic disparaîtrait
    // exactement pour les processus qui nous intéressent.
    const json = JSON.stringify([
      { ProcessId: 100, ParentProcessId: 1, WorkingSetSize: '10737418240' },
    ]);

    expect(parserCimWindows(json)).toEqual([{ pid: 100, ppid: 1, rssMo: 10240 }]);
  });
});

describe('verdictPic', () => {
  const reference = { picProcessusMo: 8000, commit: 'abc1234', machine: 'win32 24 cœurs' };

  it('nomme la hausse, la référence et de combien', () => {
    // C'est tout ce qui a manqué le 19/09 : le plancher a doublé et personne
    // ne pouvait dire de combien le besoin, lui, avait bougé.
    const v = verdictPic(11000, reference);
    expect(v.niveau).toBe('hausse');
    expect(v.message).toContain('11000');
    expect(v.message).toContain('8000');
    expect(v.message).toContain('abc1234');
    expect(v.message).toContain('+38 %');
  });

  it('se tait sur une variation ordinaire', () => {
    expect(verdictPic(8800, reference).niveau).toBe('ok');
    expect(verdictPic(6000, reference).niveau).toBe('ok');
  });

  it('place la frontière exactement au seuil de hausse', () => {
    expect(verdictPic(10000, reference, 0.25).niveau).toBe('ok');
    expect(verdictPic(10001, reference, 0.25).niveau).toBe('hausse');
  });

  it("dit qu'il n'a pas de référence plutôt que de rendre « ok »", () => {
    // Un fichier de référence vide ou absent ne doit pas se lire comme un
    // build sain : c'est un build que personne n'a comparé (invariant #4).
    expect(verdictPic(9000, null).niveau).toBe('sans-reference');
    expect(verdictPic(9000, { picProcessusMo: 0 }).niveau).toBe('sans-reference');
    expect(verdictPic(9000, {}).niveau).toBe('sans-reference');
  });
});

describe('nodeOptionsAvecCap', () => {
  it("remplace le cap de l'appelant au lieu d'en ajouter un second", () => {
    // Deux `--max-old-space-size` dans NODE_OPTIONS : V8 garde le dernier. Une
    // mesure qui en laisse deux mesure un cap qu'elle croit avoir choisi.
    expect(nodeOptionsAvecCap('--max-old-space-size=4096 --enable-source-maps', 16384)).toBe(
      '--enable-source-maps --max-old-space-size=16384',
    );
  });

  it('garde les autres options, et marche sur un NODE_OPTIONS absent', () => {
    expect(nodeOptionsAvecCap(undefined, 12288)).toBe('--max-old-space-size=12288');
    expect(nodeOptionsAvecCap('--no-warnings', 12288)).toBe(
      '--no-warnings --max-old-space-size=12288',
    );
  });
});
